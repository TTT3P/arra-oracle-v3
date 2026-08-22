/**
 * ORA-MEC chapter 2 — ingest FTS-inline / vector-deferred consistency (Class C origin).
 *
 * Measured (lab M1 + 03-measured-evidence): the indexer/watcher write FTS + the
 * SQLite sidecars INLINE (storeDocuments/storeSqliteDocuments), then DEFER vector
 * work by enqueuing one `indexing_jobs` row per model — those rows only become
 * vector rows when the drain daemon (src/indexer/daemon.ts) runs. This pins the
 * deferral contract: enqueue writes PENDING jobs (never a vector row inline), one
 * per model, so a stopped/absent daemon leaves FTS current while vectors lag.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { enqueueIndexJob } from '../../src/indexer/jobs.ts';

function jobsDb(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE indexing_jobs (
    id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, model_key TEXT NOT NULL, collection TEXT NOT NULL,
    status TEXT DEFAULT 'pending' NOT NULL, attempts INTEGER DEFAULT 0 NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')*1000) NOT NULL,
    claimed_at INTEGER, finished_at INTEGER, error TEXT)`);
  return db;
}
const MODELS = { 'bge-m3': { collection: 'oracle_knowledge_bge_m3' }, nomic: { collection: 'oracle_knowledge' } };
const pending = (db: Database) => (db.query(`SELECT COUNT(*) AS n FROM indexing_jobs WHERE status='pending'`).get() as { n: number }).n;

describe('vector work is deferred to indexing_jobs, not written inline (Class C origin)', () => {
  test('enqueue writes one PENDING job per model', () => {
    const db = jobsDb();
    const out = enqueueIndexJob(db, { docId: 'learning_x', models: MODELS });
    expect(out.length).toBe(2);
    expect(pending(db)).toBe(2);
    const rows = db.query(`SELECT model_key, collection, status, attempts FROM indexing_jobs ORDER BY model_key`).all() as Array<any>;
    expect(rows.every((r) => r.status === 'pending' && r.attempts === 0)).toBe(true);
    expect(rows.map((r) => r.collection).sort()).toEqual(['oracle_knowledge', 'oracle_knowledge_bge_m3']);
    db.close();
  });

  test('model-scoped enqueue targets exactly that model', () => {
    const db = jobsDb();
    const out = enqueueIndexJob(db, { docId: 'learning_x', models: MODELS, modelKey: 'bge-m3' });
    expect(out.length).toBe(1);
    expect(out[0].collection).toBe('oracle_knowledge_bge_m3');
    expect(pending(db)).toBe(1);
    db.close();
  });

  test('unknown modelKey enqueues nothing (no silent inline fallback)', () => {
    const db = jobsDb();
    const out = enqueueIndexJob(db, { docId: 'learning_x', models: MODELS, modelKey: 'does-not-exist' });
    expect(out.length).toBe(0);
    expect(pending(db)).toBe(0);
    db.close();
  });
});
