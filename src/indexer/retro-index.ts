/**
 * Retrospective-only indexing for local oracle ψ/ directories.
 *
 * Full reindex uses a canonical repoRoot and smart-delete. That is correct for
 * aggregate vault indexing, but it is too blunt for `/rrr`-style local retro
 * writes: a single oracle can write a fresh markdown file under its own
 * `ψ/memory/retrospectives/` while the live DB was originally built from an
 * older aggregate vault. This path mirrors oracle_learn's write-time behavior:
 * parse the local file(s), upsert SQLite + FTS rows, and do not smart-delete
 * unrelated historical docs.
 */

import fs from 'fs';
import path from 'path';
import { createDatabase } from '../db/index.ts';
import { DB_PATH } from '../config.ts';
import { detectProject } from '../server/project-detect.ts';
import { activeTenantId } from '../middleware/tenant.ts';
import { collectDocuments } from './collectors.ts';
import { parseRetroFile } from './parser.ts';
import { storeDocuments } from './storage.ts';
import { chunkDocumentsForIndexing } from './chunker.ts';
import { supersedeReplacedSourceDocs } from './reindex-state.ts';
import { setIndexingStatus } from './status.ts';
import {
  DEFAULT_INITIAL_BATCH, DEFAULT_MAX_BATCH, DEFAULT_TARGET_MS,
  groupBySourceFile, nextBatchTarget, takeFileAlignedBatch, type AdaptiveSizing,
} from './retro-batch.ts';
import type { IndexerConfig, OracleDocument } from '../types.ts';

/**
 * Batching (PR-B slice d). A whole-root retros pass over the canonical root was ONE giant
 * `storeDocuments` transaction: it held the single Bun event loop for ~2 min and buffered the entire
 * change set — the slice-b live wedge (2026-09-05). Each batch here is its own transaction, closed
 * only at a source-file boundary, followed by its own supersede pass and a real event-loop yield.
 *
 * Batch size is adaptive by default (see `retro-batch.ts`): it steers each batch's wall time toward
 * `targetMs` (default 500 ms, a quarter of the fleet's 2 s liveness abort). `ORACLE_RETROS_BATCH_SIZE` or an
 * explicit `batchSize` pins a fixed size instead (adaptive off) — the negative-control shape.
 */
export interface RetrosIndexOptions {
  /** Fixed docs per batch (disables adaptive sizing). */
  batchSize?: number;
  /** Adaptive wall-time goal per batch, ms. */
  targetMs?: number;
  initialBatchSize?: number;
  maxBatchSize?: number;
  /** Observability hook, called after each batch has committed and superseded. */
  onBatch?: (info: RetrosBatchInfo) => void;
}

export interface RetrosBatchInfo {
  batch: number;
  files: number;
  /** Relative source files committed by this batch (names only, never content). */
  sourceFiles: string[];
  docs: number;
  chunks: number;
  superseded: number;
  wallMs: number;
  done: number;
  total: number;
  nextTarget: number;
}

/** Idle gap between batches so pending I/O and due timers both get a turn. */
const BATCH_YIELD_MS = 10;

function envNumber(name: string): number | undefined {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

export async function indexRetrospectives(
  repoRoot: string,
  dbPath: string = process.env.ORACLE_DB_PATH || DB_PATH,
  options: RetrosIndexOptions | number = {},
) {
  const opts: RetrosIndexOptions = typeof options === 'number' ? { batchSize: options } : options;
  const fixedSize = opts.batchSize ?? envNumber('ORACLE_RETROS_BATCH_SIZE');
  const sizing: AdaptiveSizing = {
    targetMs: opts.targetMs ?? envNumber('ORACLE_RETROS_BATCH_TARGET_MS') ?? DEFAULT_TARGET_MS,
    min: 1,
    max: opts.maxBatchSize ?? DEFAULT_MAX_BATCH,
  };
  const resolvedRoot = path.resolve(repoRoot);
  const config: IndexerConfig = {
    repoRoot: resolvedRoot,
    dbPath,
    chromaPath: '',
    sourcePaths: {
      resonance: 'ψ/memory/resonance',
      learnings: 'ψ/memory/learnings',
      retrospectives: 'ψ/memory/retrospectives',
      distillations: 'ψ/memory/distillations',
      learn: 'ψ/learn',
    },
  };
  const documents = collectDocuments({
    config, seenContentHashes: new Set<string>(), subdir: 'retrospectives', parseFn: parseRetroFile, label: 'retrospective',
  });
  const total = documents.length;
  // Whole-file groups in a queue the planner drains; processed groups are released for GC so the
  // JS live set plateaus after the initial load instead of holding every chunk to the end.
  const queue: Array<OracleDocument[] | undefined> = groupBySourceFile(documents);
  documents.length = 0;

  const { sqlite, db } = createDatabase(dbPath);
  // Capture the tenant once and ALWAYS pass it — activeTenantId() falls back
  // to 'default', so even an ambient-less CLI run stays tenant-scoped instead
  // of widening the supersede across every tenant sharing the source path.
  const tenantId = activeTenantId();
  const project = detectProject(resolvedRoot);
  const cursor = { next: 0 };
  let target = fixedSize ?? Math.min(opts.initialBatchSize ?? DEFAULT_INITIAL_BATCH, sizing.max);
  const ids: string[] = []; // ids only — never the chunk content
  let batches = 0;
  let files = 0;
  let done = 0;
  let superseded = 0;
  try {
    // Durable "a run is in progress" marker (indexing_status id=1, seeded by createDatabase). Read by
    // the status/health handlers. A crash or a failed batch leaves is_indexing=1 + error with
    // completed_at NULL, so a wait=false caller can still see the run did not finish.
    setIndexingStatus(db, config, true, 0, total);
    let planned = takeFileAlignedBatch(queue, cursor, target);
    while (planned) {
      const startedAt = performance.now();
      // Each batch is its own storeDocuments transaction: a failure rolls back only this batch,
      // earlier batches stay committed, and the upserts make a rerun idempotent (resumable). Its
      // bulk pointer flush scans the tenant table once, so scans stay O(batches), not O(docs).
      await storeDocuments(sqlite, db, null, project, planned.docs, { createdBy: 'retro_indexer', tenantId });
      // Upserting new deterministic ids leaves legacy active rows for the same source files behind,
      // which duplicates search results. Supersede them NOW, for this batch's files only (never
      // hard-delete): the batch is file-aligned, so every chunk of each file is already stored, and
      // search never sees a file with legacy AND new generations active past this point.
      const chunked = chunkDocumentsForIndexing(planned.docs);
      superseded += supersedeReplacedSourceDocs(db, chunked, tenantId);
      for (const doc of chunked) ids.push(doc.id);
      batches += 1;
      files += planned.files;
      done += planned.docs.length;
      setIndexingStatus(db, config, true, done, total);
      const wallMs = performance.now() - startedAt;
      if (fixedSize === undefined) target = nextBatchTarget(target, planned.docs.length, wallMs, sizing);
      opts.onBatch?.({
        batch: batches, files: planned.files, sourceFiles: planned.sourceFiles, docs: planned.docs.length, chunks: chunked.length,
        superseded, wallMs, done, total, nextTarget: target,
      });
      planned = takeFileAlignedBatch(queue, cursor, target);
      // Yield the event loop between batches. bun:sqlite is synchronous and never yields on its own,
      // so without this the loop is blocked for the whole run and every HTTP/MCP handler wedges.
      // A short idle gap, not setImmediate/setTimeout(0): the canary showed an immediate lets I/O
      // run but starves due timers across consecutive batches, and a 0 ms timer can fire before a
      // pending HTTP request is polled, so one probe waited two batches. 10 ms × batches is noise.
      if (planned) await new Promise<void>((resolve) => setTimeout(resolve, BATCH_YIELD_MS));
    }
    setIndexingStatus(db, config, false, done, total);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try { setIndexingStatus(db, config, true, done, total, message); } catch { /* keep the original error */ }
    throw err;
  } finally {
    sqlite.close();
  }

  return { ok: true as const, repoRoot: resolvedRoot, documents: total, files, ids, batches, superseded };
}

export async function indexRetroFile(repoRoot: string, filePath: string, dbPath: string = process.env.ORACLE_DB_PATH || DB_PATH) {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedFile = path.resolve(filePath);
  const retroRoot = path.join(resolvedRoot, 'ψ', 'memory', 'retrospectives');

  if (!resolvedFile.startsWith(retroRoot + path.sep)) {
    throw new Error(`Refusing to index non-retro file outside ${retroRoot}: ${resolvedFile}`);
  }
  if (!fs.existsSync(resolvedFile)) {
    throw new Error(`Retrospective file not found: ${resolvedFile}`);
  }

  const relPath = path.relative(resolvedRoot, resolvedFile);
  const content = fs.readFileSync(resolvedFile, 'utf-8');
  const documents = parseRetroFile(relPath, content);
  const { sqlite, db } = createDatabase(dbPath);
  const tenantId = activeTenantId();
  const chunked = chunkDocumentsForIndexing(documents);
  try {
    await storeDocuments(sqlite, db, null, detectProject(resolvedRoot), documents, {
      createdBy: 'retro_indexer',
      tenantId,
    });
    supersedeReplacedSourceDocs(db, chunked, tenantId);
  } finally {
    sqlite.close();
  }

  return { ok: true as const, repoRoot: resolvedRoot, filePath: resolvedFile, documents: documents.length, ids: chunked.map((doc) => doc.id) };
}
