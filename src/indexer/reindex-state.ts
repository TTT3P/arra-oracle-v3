import { and, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { indexingJobs, oracleDocuments } from '../db/schema.ts';
import { asOracleDb, type OracleDb, type OracleDbInput } from '../db/drizzle-input.ts';
import type { OracleDocument } from '../types.ts';
import { enqueueIndexJob } from './jobs.ts';

export type DocSnapshot = Map<string, { sourceFile: string; content: string | null }>;
export type ModelRegistry = Record<string, { collection: string }>;

export interface VectorQueueStats {
  queued: number;
  skipped: number;
  failed: number;
}

const REINDEX_REASON = 'superseded by indexer reindex';

/**
 * Snapshot of every active indexer document's FTS content, keyed by id.
 *
 * Two defects in the previous correlated form
 * (`SELECT GROUP_CONCAT(content) FROM oracle_fts WHERE ${oracleFts.id} = ${oracleDocuments.id}`
 * as a `sql` field of a single-table `db.select`):
 * 1. Drizzle strips the table qualifier from Column refs inside a selection `sql` fragment on a
 *    single-table select, so it rendered `WHERE "id" = "id"` — true for every FTS row — and every
 *    document's "before" content was the whole FTS table concatenated. `changedDocumentIds` then
 *    saw every document as changed (pinned by tests/indexer/snapshot-set-based.test.ts).
 * 2. `oracle_fts.id` is UNINDEXED (FTS5), so even the intended query scans the whole FTS table
 *    once per active document: O(docs × fts_rows), 88 s for 10,719 docs on a live copy.
 * This form scans `oracle_fts` exactly once into a temp table and groups by id (0.16 s on the same
 * copy). `ORDER BY r` (the FTS rowid) inside GROUP_CONCAT pins the concatenation to FTS scan order,
 * including duplicate rows for one id, so the result equals the intended correlated query byte for
 * byte (needs SQLite ≥ 3.44). No Column refs are interpolated into raw SQL here on purpose. The
 * temp table is connection-local and dropped in `finally`; the function is synchronous, so two
 * snapshots can never interleave on one connection.
 */
export function snapshotActiveIndexerDocs(input: OracleDbInput, tenantId?: string): DocSnapshot {
  const db = asOracleDb(input);
  db.run(sql`DROP TABLE IF EXISTS temp.fts_snapshot_rows`);
  db.run(sql`CREATE TEMP TABLE fts_snapshot_rows (r INTEGER PRIMARY KEY, id TEXT, content TEXT)`);
  try {
    db.run(sql`INSERT INTO temp.fts_snapshot_rows (r, id, content) SELECT rowid, id, content FROM oracle_fts`);
    const contentById = new Map<string, string | null>();
    for (const [id, content] of db.values<[string, string | null]>(sql`
      SELECT id, GROUP_CONCAT(content, char(10) ORDER BY r)
      FROM temp.fts_snapshot_rows WHERE id IS NOT NULL GROUP BY id`)) {
      contentById.set(id, content);
    }
    const docs = db.select({ id: oracleDocuments.id, sourceFile: oracleDocuments.sourceFile })
      .from(oracleDocuments)
      .where(activeIndexerWhere(tenantId))
      .all();
    return new Map(docs.map((doc) => [doc.id, { sourceFile: doc.sourceFile, content: contentById.get(doc.id) ?? null }]));
  } finally {
    db.run(sql`DROP TABLE IF EXISTS temp.fts_snapshot_rows`);
  }
}

export function changedDocumentIds(before: DocSnapshot, documents: OracleDocument[]): Set<string> {
  const changed = new Set<string>();
  for (const doc of documents) {
    const prior = before.get(doc.id);
    if (!prior || prior.content !== doc.content) changed.add(doc.id);
  }
  return changed;
}

export function supersedeReplacedSourceDocs(
  input: OracleDbInput,
  documents: OracleDocument[],
  tenantId?: string,
): number {
  const db = asOracleDb(input);
  const bySource = new Map<string, string[]>();
  for (const doc of documents) {
    const ids = bySource.get(doc.source_file) ?? [];
    ids.push(doc.id);
    bySource.set(doc.source_file, ids);
  }

  let superseded = 0;
  const now = Date.now();
  for (const [sourceFile, currentIds] of bySource) {
    const stale = activeIndexerIdsForSource(db, sourceFile, currentIds, tenantId);
    if (stale.length === 0) continue;
    const successorId = currentIds[0];
    db.update(oracleDocuments)
      .set({ supersededBy: successorId, supersededAt: now, supersededReason: REINDEX_REASON })
      .where(and(
        inArray(oracleDocuments.id, stale),
        isNull(oracleDocuments.supersededBy),
        isNull(oracleDocuments.supersededAt),
      ))
      .run();
    superseded += stale.length;
  }
  return superseded;
}

export function enqueueVectorReindexJobs(
  input: OracleDbInput,
  documents: OracleDocument[],
  models: ModelRegistry,
  changedIds: Set<string>,
): VectorQueueStats {
  const db = asOracleDb(input);
  const modelKeys = Object.keys(models);
  const docIds = [...new Set(documents.map((doc) => doc.id))];
  const stats: VectorQueueStats = { queued: 0, skipped: 0, failed: 0 };
  if (docIds.length === 0 || modelKeys.length === 0) return stats;
  if (!hasIndexingJobsTable(db)) {
    stats.failed = docIds.length * modelKeys.length;
    return stats;
  }

  for (const docId of docIds) {
    const changed = changedIds.has(docId);
    for (const modelKey of modelKeys) {
      try {
        if (!needsVectorJob(db, docId, modelKey, changed)) {
          stats.skipped++;
          continue;
        }
        const jobs = enqueueIndexJob(db, { docId, modelKey, models });
        stats.queued += jobs.length;
        if (jobs.length === 0) stats.failed++;
      } catch {
        stats.failed++;
      }
    }
  }
  return stats;
}

function activeIndexerIdsForSource(
  db: OracleDb,
  sourceFile: string,
  currentIds: string[],
  tenantId?: string,
): string[] {
  if (currentIds.length === 0) return [];
  const rows = db.select({ id: oracleDocuments.id })
    .from(oracleDocuments)
    .where(and(
      eq(oracleDocuments.sourceFile, sourceFile),
      notInArray(oracleDocuments.id, currentIds),
      activeIndexerWhere(tenantId),
    ))
    .all();
  return rows.map((row) => row.id);
}

/**
 * Active (non-superseded) indexer-owned rows. This is the ONLY predicate the
 * smart-delete plan may use: superseded rows are intentional history under
 * "Nothing is Deleted" and must never become prune candidates.
 */
export function activeIndexerWhere(tenantId?: string) {
  return and(
    or(eq(oracleDocuments.createdBy, 'indexer'), isNull(oracleDocuments.createdBy))!,
    isNull(oracleDocuments.supersededBy),
    isNull(oracleDocuments.supersededAt),
    tenantId ? eq(oracleDocuments.tenantId, tenantId) : undefined,
  )!;
}

/**
 * Does the vector job queue exist?
 *
 * This returned `false` unconditionally, so `enqueueVectorReindexJobs` short-circuited on
 * every run and **the indexer never queued a single vector job**. Measured on a fresh DB
 * where the table demonstrably exists:
 *
 * ```
 * raw sqlite sees table          : true
 * db.get(sql`SELECT name …`)     : ["indexing_jobs"]     ← a positional array
 * row?.name === 'indexing_jobs'  : false
 * ```
 *
 * Drizzle's `db.get()` with a raw `sql` template yields the row as an **array**, not an
 * object. The `<{ name: string }>` type argument described a shape that never existed at
 * runtime — a generic is an assertion, not a check, so `tsc` had nothing to catch. The two
 * `tests/indexer/reindex-hardening.test.ts` cases have been failing on this since #2434 and
 * were invisible because CI did not run `tests/indexer/` (#2853).
 *
 * Both shapes are handled: a raw `sql` template gives the array, while a query built from a
 * Drizzle table gives the object, and this helper should not care which the caller used.
 */
function hasIndexingJobsTable(db: OracleDb): boolean {
  try {
    const row = db.get<{ name?: string } | [string] | undefined>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'indexing_jobs'`,
    );
    if (!row) return false;
    const name = Array.isArray(row) ? row[0] : row.name;
    return name === 'indexing_jobs';
  } catch {
    return false;
  }
}

function needsVectorJob(
  db: OracleDb,
  docId: string,
  modelKey: string,
  changed: boolean,
): boolean {
  const rows = db.select({ status: indexingJobs.status })
    .from(indexingJobs)
    .where(and(eq(indexingJobs.docId, docId), eq(indexingJobs.modelKey, modelKey)))
    .orderBy(desc(indexingJobs.createdAt))
    .all();
  if (changed) return !rows.some((row) => row.status === 'pending');
  return !rows.some((row) => row.status === 'pending'
    || row.status === 'claimed'
    || row.status === 'done');
}
