/**
 * Document storage: SQLite + vector store batching
 */

import { Database } from 'bun:sqlite';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { eq } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import * as schema from '../db/schema.ts';
import { oracleDocuments } from '../db/schema.ts';
import { enrichTextWithAcronyms } from '../search/acronyms.ts';
import { tenantIdForWrite } from '../middleware/tenant.ts';
import { replaceEntityLinks } from '../search/entity-ranking.ts';
import { chunkDocumentsForIndexing } from './chunker.ts';
import { removeDocumentPointers, replaceDocumentPointers } from '../search/pointer-index.ts';
import type { VectorStoreAdapter } from '../vector/types.ts';
import type { OracleDocument } from '../types.ts';
import { yieldEvery, yieldToEventLoop } from './yield.ts';

/** Target wall time per store transaction; the event loop is held for about this long. */
export const STORE_SLICE_MS = 150;
const STORE_BATCH_MAX = 500;

/** Halve after a slow batch, double after a fast one — converges on ~STORE_SLICE_MS per transaction. */
export function nextBatchSize(current: number, elapsedMs: number): number {
  if (elapsedMs > STORE_SLICE_MS) return Math.max(1, Math.floor(current / 2));
  if (elapsedMs < STORE_SLICE_MS / 3) return Math.min(STORE_BATCH_MAX, current * 2);
  return current;
}

export const oracleFts = sqliteTable('oracle_fts', {
  id: text('id').notNull(),
  content: text('content').notNull(),
  concepts: text('concepts').notNull(),
});

/**
 * Store documents in SQLite + vector store
 * Uses Drizzle for type-safe inserts and sets createdBy: 'indexer'
 */
export async function storeDocuments(
  sqlite: Database,
  db: BunSQLiteDatabase<typeof schema>,
  vectorClient: VectorStoreAdapter | null,
  project: string | null,
  documents: OracleDocument[],
  opts: { createdBy?: string; tenantId?: string; insertOnly?: boolean; nextBatch?: typeof nextBatchSize } = {}
): Promise<void> {
  const now = Date.now();
  const tenantId = opts.tenantId ?? tenantIdForWrite();
  const storedDocuments = chunkDocumentsForIndexing(documents);

  // Prepare for vector store
  const ids: string[] = [];
  const contents: string[] = [];
  const metadatas: any[] = [];

  // One synchronous transaction over ~12k chunks held the event loop for
  // seconds (incident 2026-08-29). Chunk cost is not constant — pointer
  // doc_ids lists grow with the corpus — so batches are time-boxed: each
  // transaction is sized from the previous one's duration to stay near
  // STORE_SLICE_MS, then the loop is yielded. insertOnly (recovery) and
  // ORACLE_INDEX_YIELD_EVERY=0 keep the single all-or-nothing transaction.
  // Pointer removal reads every pointer row of the tenant, so it runs once per
  // TRANSACTION (inside it, so a rollback restores the pointers) instead of
  // once per document. The first batch starts small and grows by measurement.
  const every = yieldEvery();
  const singleTx = opts.insertOnly || every === 0;
  const adapt = opts.nextBatch ?? nextBatchSize;
  let batchSize = singleTx ? storedDocuments.length : Math.max(1, Math.floor(every / 3));
  // The cursor advances by the batch just processed — never by the adapted
  // NEXT size (d56e3b46 did that and silently skipped/rewrote documents).
  let start = 0;
  while (start < storedDocuments.length) {
    if (start > 0) await yieldToEventLoop();
    const batch = storedDocuments.slice(start, start + Math.max(batchSize, 1));
    start += batch.length;
    const batchStarted = performance.now();
    db.transaction((tx) => {
    removeDocumentPointers(sqlite, tenantId, batch.map((doc) => doc.id));
    for (const doc of batch) {
      // SQLite metadata - use doc.project if available, fall back to repo project
      const docProject = (doc.project || project)?.toLowerCase();

      const insertValues = {
        id: doc.id,
        tenantId,
        type: doc.type,
        sourceFile: doc.source_file,
        concepts: JSON.stringify(doc.concepts),
        createdAt: doc.created_at,
        updatedAt: doc.updated_at,
        indexedAt: now,
        project: docProject,
        createdBy: opts.createdBy || 'indexer',
      };

      if (opts.insertOnly) {
        // Recovery-style writes must never overwrite an existing document —
        // and the conflict must be detected HERE, before the FTS/entity-link/
        // pointer writes below, so the transaction rolls back with the
        // collided document's secondary indexes untouched.
        tx.insert(oracleDocuments).values(insertValues).onConflictDoNothing().run();
        const affected = (sqlite.query('SELECT changes() AS c').get() as { c: number }).c;
        if (affected !== 1) {
          throw new Error(`insertOnly: document id "${doc.id}" already exists — refusing to overwrite`);
        }
      } else {
        // Drizzle upsert with createdBy: 'indexer'
        tx.insert(oracleDocuments)
          .values(insertValues)
          .onConflictDoUpdate({
            target: oracleDocuments.id,
            set: {
              tenantId,
              type: doc.type,
              sourceFile: doc.source_file,
              concepts: JSON.stringify(doc.concepts),
              updatedAt: doc.updated_at,
              indexedAt: now,
              project: docProject,
              supersededBy: null,
              supersededAt: null,
              supersededReason: null,
            }
          })
          .run();
      }

      const indexedContent = enrichTextWithAcronyms(doc.content);

      // FTS5 virtual tables have no UNIQUE constraint on id (it's UNINDEXED),
      // so delete-then-insert avoids duplicates across re-index runs.
      tx.delete(oracleFts).where(eq(oracleFts.id, doc.id)).run();
      tx.insert(oracleFts).values({
        id: doc.id,
        content: indexedContent,
        concepts: doc.concepts.join(' '),
      }).run();
      replaceEntityLinks(sqlite, {
        documentId: doc.id,
        tenantId,
        content: indexedContent,
        concepts: doc.concepts,
        now,
      });
      replaceDocumentPointers(sqlite, {
        documentId: doc.id,
        tenantId,
        content: indexedContent,
        concepts: doc.concepts,
        timestamp: doc.updated_at || doc.created_at,
      }, { removeFirst: false });

      // Vector store metadata (must be primitives, not arrays)
      ids.push(doc.id);
      contents.push(indexedContent);
      metadatas.push({
        type: doc.type,
        tenant_id: tenantId,
        source_file: doc.source_file,
        concepts: doc.concepts.join(','),
        ...(doc.chunk_index !== undefined && { chunk_index: doc.chunk_index }),
        ...(doc.line_start !== undefined && { line_start: doc.line_start }),
        ...(doc.line_end !== undefined && { line_end: doc.line_end }),
      });
    }
    });
    if (!singleTx) batchSize = Math.max(1, adapt(batchSize, performance.now() - batchStarted));
  }

  // Batch insert to vector store in chunks of 100 (skip if no client)
  if (!vectorClient) {
    console.log('Skipping vector indexing (SQLite-only mode)');
    return;
  }

  const BATCH_SIZE = 100;
  let vectorSuccess = true;

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batchIds = ids.slice(i, i + BATCH_SIZE);
    const batchContents = contents.slice(i, i + BATCH_SIZE);
    const batchMetadatas = metadatas.slice(i, i + BATCH_SIZE);

    try {
      const vectorDocs = batchIds.map((id, idx) => ({
        id,
        document: batchContents[idx],
        metadata: batchMetadatas[idx]
      }));
      await vectorClient.addDocuments(vectorDocs);
      console.log(`Vector batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(ids.length / BATCH_SIZE)} stored`);
    } catch (error) {
      console.error(`Vector batch failed:`, error);
      vectorSuccess = false;
    }
  }

  console.log(`Stored in SQLite${vectorSuccess ? ` + ${vectorClient.name}` : ` (${vectorClient.name} failed)`}`);
}
