/**
 * Learnings-only reindex pass (`scope=learnings`), invoked through
 * `OracleIndexer.indexLearnings()` — never a standalone writer.
 *
 * Reads exactly one source type, `ψ/memory/learnings` under the given root, and
 * stores it through the same sink the full indexer uses (`storeDocuments` +
 * `supersedeReplacedSourceDocs`, deterministic ids, `createdBy` default
 * 'indexer'), so `oracle_verify` reports the result as healthy. It never reads
 * the retrospectives tree (RUNBOOK §4 HOLD stays intact), never prunes, never
 * runs the smart-delete plan, and never touches other source types.
 *
 * Root validation mirrors the retro-file seam (`src/tools/index-retro.ts`):
 * the root must exist, must contain `ψ/memory/learnings`, must not be the
 * Oracle data dir, and must match `ORACLE_MEMORY_OWNER_ROOT` when a seat is
 * bound to one. `repoRoot` is always explicit — no vault/cwd fallback.
 */
import fs from 'fs';
import path from 'path';
import type { Database } from 'bun:sqlite';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from '../db/schema.ts';
import { ORACLE_DATA_DIR } from '../config.ts';
import { activeTenantId } from '../middleware/tenant.ts';
import type { OracleDocument, IndexerConfig } from '../types.ts';
import { getEmbeddingModels } from '../vector/factory.ts';
import { chunkDocumentsForIndexing } from './chunker.ts';
import { collectDocuments } from './collectors.ts';
import { parseLearningFile } from './parser.ts';
import {
  changedDocumentIds,
  enqueueVectorReindexJobs,
  snapshotActiveIndexerDocs,
  supersedeReplacedSourceDocs,
  type VectorQueueStats,
} from './reindex-state.ts';
import { setIndexingStatus } from './status.ts';
import { storeDocuments } from './storage.ts';

export const LEARNINGS_SUBDIR = path.join('ψ', 'memory', 'learnings');
const LEARNINGS_PREFIX = 'ψ/memory/learnings/';

const isWithin = (root: string, target: string): boolean => target === root || target.startsWith(root + path.sep);

/**
 * Fail closed on any symlink inside the learnings tree (Riddler PR#21 #1): the
 * collector follows directory symlinks and reads through file symlinks, so a
 * link would let a validated root read — and later store — content from
 * outside it while the relative source path hides the escape.
 */
function assertSymlinkFreeTree(realRoot: string, dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing scope=learnings: symlink inside the learnings tree (${path.relative(realRoot, full)})`);
    }
    if (entry.isDirectory()) assertSymlinkFreeTree(realRoot, full);
  }
}

export interface LearningsPassOptions {
  /** Collect and report candidates only; write nothing (no status row, no store). */
  dryRun?: boolean;
}

export interface LearningsPassResult {
  ok: true;
  scope: 'learnings';
  repoRoot: string;
  dryRun: boolean;
  /** Distinct source files (relative to repoRoot) that produced documents. */
  files: number;
  documents: number;
  chunks: number;
  superseded: number;
  vectorJobs: VectorQueueStats;
  /** Learning documents found under project-first/crew ψ dirs inside the root and NOT stored (outside this scope). */
  skippedOutsideTree: number;
  /** Present on dry runs only: the relative source files that would be stored. */
  sourceFiles?: string[];
}

/** Internals the OracleIndexer hands over; the pass owns no connection of its own. */
export interface LearningsPassContext {
  sqlite: Database;
  db: BunSQLiteDatabase<typeof schema>;
  config: IndexerConfig;
  project: string | null;
  seenContentHashes: Set<string>;
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(path.resolve(target));
  } catch {
    return null;
  }
}

/**
 * Fail-closed root check for `scope=learnings`. Returns the resolved root or
 * throws with an operator-readable reason. Pure filesystem/env checks — no DB.
 */
export function validateLearningsRoot(repoRoot: string | null | undefined): string {
  const requested = repoRoot?.trim();
  if (!requested) throw new Error('repoRoot is required for scope=learnings (no vault/cwd fallback)');
  const resolved = path.resolve(requested);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Refusing scope=learnings: repoRoot is not a directory: ${resolved}`);
  }
  const learningsDir = path.join(resolved, LEARNINGS_SUBDIR);
  if (!fs.existsSync(learningsDir) || !fs.statSync(learningsDir).isDirectory()) {
    throw new Error(`Refusing scope=learnings: ${learningsDir} does not exist`);
  }
  const real = realpathOrNull(resolved);
  if (!real) throw new Error(`Refusing scope=learnings: cannot resolve ${resolved}`);
  const realLearnings = realpathOrNull(learningsDir);
  if (!realLearnings || !isWithin(real, realLearnings)) {
    throw new Error(`Refusing scope=learnings: ${learningsDir} resolves outside the root`);
  }
  assertSymlinkFreeTree(real, realLearnings);
  // Env wins at call time (config.ts freezes ORACLE_DATA_DIR at import; tests and launchers set the env).
  const dataDir = realpathOrNull(process.env.ORACLE_DATA_DIR?.trim() || ORACLE_DATA_DIR);
  if (real && dataDir && real === dataDir) {
    throw new Error(`Refusing scope=learnings: repoRoot resolves to the Oracle data dir (${dataDir})`);
  }
  const boundRoot = process.env.ORACLE_MEMORY_OWNER_ROOT?.trim();
  if (boundRoot && real !== realpathOrNull(boundRoot)) {
    throw new Error(`Refusing scope=learnings: repoRoot is outside this seat's bound memory owner (ORACLE_MEMORY_OWNER_ROOT=${boundRoot})`);
  }
  return real;
}

export interface LearningsCandidates {
  documents: OracleDocument[];
  chunks: OracleDocument[];
  sourceFiles: string[];
  /** Documents the collector found under project-first/crew ψ dirs inside the root — not part of this scope. */
  skippedOutsideTree: number;
}

/**
 * Pure collection for `scope=learnings`: one collector call, one subdir, and
 * only documents whose source path is inside `ψ/memory/learnings/` of the root
 * (the shared collector also walks project-first `github.com/…/ψ` and crew
 * dirs under the root — those are dropped and counted). No database is
 * opened; this is what a dry run returns.
 */
export function collectLearningsCandidates(config: IndexerConfig, seen: Set<string> = new Set()): LearningsCandidates {
  seen.clear();
  const found = collectDocuments({ config, seenContentHashes: seen, subdir: 'learnings', parseFn: parseLearningFile, label: 'learning' });
  const documents = found.filter((doc) => doc.source_file.startsWith(LEARNINGS_PREFIX));
  const chunks = chunkDocumentsForIndexing(documents);
  const sourceFiles = [...new Set(documents.map((doc) => doc.source_file))].sort();
  return { documents, chunks, sourceFiles, skippedOutsideTree: found.length - documents.length };
}

const NO_VECTOR_JOBS: VectorQueueStats = { queued: 0, skipped: 0, failed: 0 };

function safeEnqueue(db: LearningsPassContext['db'], documents: OracleDocument[], changedIds: Set<string>): VectorQueueStats {
  try {
    return enqueueVectorReindexJobs(db, documents, getEmbeddingModels(), changedIds);
  } catch {
    return { queued: 0, skipped: 0, failed: documents.length };
  }
}

export async function runLearningsPass(ctx: LearningsPassContext, options: LearningsPassOptions = {}): Promise<LearningsPassResult> {
  const dryRun = options.dryRun === true;
  const tenantId = activeTenantId();
  // Exactly one collector call, exactly one subdir, contained to ψ/memory/learnings of the root.
  const { documents, chunks: indexDocuments, sourceFiles, skippedOutsideTree } = collectLearningsCandidates(ctx.config, ctx.seenContentHashes);
  const base = {
    ok: true as const,
    scope: 'learnings' as const,
    repoRoot: ctx.config.repoRoot,
    dryRun,
    files: sourceFiles.length,
    documents: documents.length,
    chunks: indexDocuments.length,
    skippedOutsideTree,
  };

  if (dryRun) return { ...base, superseded: 0, vectorJobs: NO_VECTOR_JOBS, sourceFiles };
  if (indexDocuments.length === 0) return { ...base, superseded: 0, vectorJobs: NO_VECTOR_JOBS };

  setIndexingStatus(ctx.db, ctx.config, true, 0, indexDocuments.length);
  try {
    const beforeDocs = snapshotActiveIndexerDocs(ctx.db, tenantId);
    const changedIds = changedDocumentIds(beforeDocs, indexDocuments);
    // Same sink and same supersede as OracleIndexer.index(); scoped to these
    // source files only, so no row outside ψ/memory/learnings can be superseded.
    await storeDocuments(ctx.sqlite, ctx.db, null, ctx.project, indexDocuments, { tenantId });
    const superseded = supersedeReplacedSourceDocs(ctx.db, indexDocuments, tenantId);
    const vectorJobs = safeEnqueue(ctx.db, indexDocuments, changedIds);
    setIndexingStatus(ctx.db, ctx.config, false, indexDocuments.length, indexDocuments.length);
    console.log(`[learnings] Indexed ${indexDocuments.length} chunks from ${sourceFiles.length} files; superseded ${superseded}; vector jobs queued ${vectorJobs.queued}`);
    return { ...base, superseded, vectorJobs };
  } catch (err) {
    setIndexingStatus(ctx.db, ctx.config, false, 0, indexDocuments.length, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
