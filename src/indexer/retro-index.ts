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
import type { OracleDocument } from '../types.ts';

/** Documents per store transaction. A whole-root retros pass over the canonical root is otherwise
 * ONE giant `storeDocuments` transaction that holds the single Bun event loop for ~2 min and
 * buffers the entire change set in memory — the slice-b live wedge (2026-09-05). Batching bounds
 * both. Default sized from the proven per-file cost (RUNBOOK §4: retro-file 4–13 s); override with
 * ORACLE_RETROS_BATCH_SIZE. */
const DEFAULT_RETROS_BATCH_SIZE = 250;
function retrosBatchSize(): number {
  const n = Number(process.env.ORACLE_RETROS_BATCH_SIZE);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_RETROS_BATCH_SIZE;
}

export async function indexRetrospectives(
  repoRoot: string,
  dbPath: string = process.env.ORACLE_DB_PATH || DB_PATH,
  batchSize: number = retrosBatchSize(),
) {
  const resolvedRoot = path.resolve(repoRoot);
  const seenContentHashes = new Set<string>();
  const documents = collectDocuments({
    config: {
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
    },
    seenContentHashes,
    subdir: 'retrospectives',
    parseFn: parseRetroFile,
    label: 'retrospective',
  });

  const { sqlite, db } = createDatabase(dbPath);
  // Capture the tenant once and ALWAYS pass it — activeTenantId() falls back
  // to 'default', so even an ambient-less CLI run stays tenant-scoped instead
  // of widening the supersede across every tenant sharing the source path.
  const tenantId = activeTenantId();
  const project = detectProject(resolvedRoot);
  const size = Math.max(1, Math.trunc(batchSize));
  // Chunk ids accumulate for the response and for one supersede pass at the end (batching supersede
  // per batch would mis-fire when a source file's chunks straddle a batch boundary).
  const chunked: OracleDocument[] = [];
  let batches = 0;
  try {
    for (let i = 0; i < documents.length; i += size) {
      const batch = documents.slice(i, i + size);
      // Each batch is its own storeDocuments transaction: a failure rolls back only this batch,
      // earlier batches stay committed, and the upserts make a rerun idempotent (resumable). Its
      // bulk pointer flush scans the tenant table once, so scans stay O(batches), not O(docs).
      await storeDocuments(sqlite, db, null, project, batch, { createdBy: 'retro_indexer', tenantId });
      for (const doc of chunkDocumentsForIndexing(batch)) chunked.push(doc);
      batches += 1;
      // Yield the event loop between batches. bun:sqlite is synchronous and never yields on its own,
      // so without this the loop is blocked for the whole run and every HTTP/MCP handler wedges.
      if (i + size < documents.length) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // Upserting new deterministic ids leaves legacy active rows for the same source files behind,
    // which duplicates search results. Supersede them through the owning replaced-source mechanism
    // (never hard-delete). One pass at the end keeps file-level grouping intact.
    supersedeReplacedSourceDocs(db, chunked, tenantId);
  } finally {
    sqlite.close();
  }

  return { ok: true as const, repoRoot: resolvedRoot, documents: documents.length, ids: chunked.map((doc) => doc.id), batches };
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
