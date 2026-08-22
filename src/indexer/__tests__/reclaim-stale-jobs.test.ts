/**
 * Phase-4a fix 1 — crashed-worker claimed-job leak. `reclaimStaleJobs` is the
 * set-wise recovery the daemon wires at startup (olderThanMs=0) + periodically.
 * The pre-existing single-id `reclaimStaleJob` was never called by any production
 * module; this guards the new behaviour: aged `claimed` → `pending` (re-claimable),
 * attempts preserved, threshold respected, terminal rows untouched.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import Database from 'bun:sqlite';
import { enqueueIndexJob, claimNextJob, markJobDone, markJobError, reclaimStaleJobs } from '../jobs.ts';

const MIGRATION_SQL = `
CREATE TABLE indexing_jobs (
  id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, model_key TEXT NOT NULL, collection TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  claimed_at INTEGER, finished_at INTEGER, error TEXT);`;
const MODELS = { 'bge-m3': { collection: 'oracle_knowledge_bge_m3' } };
let db: Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(MIGRATION_SQL); });

const claimOne = () => { enqueueIndexJob(db, { docId: 'd', models: MODELS }); return claimNextJob(db, 'bge-m3')!; };
const ageClaim = (id: string, ms: number) => db.query(`UPDATE indexing_jobs SET claimed_at=? WHERE id=?`).run(Date.now() - ms, id);
const row = (id: string) => db.query(`SELECT status, claimed_at, attempts FROM indexing_jobs WHERE id=?`).get(id) as any;

describe('reclaimStaleJobs (Phase-4a fix 1)', () => {
  it('reclaims an aged claimed job back to pending, re-claimable, attempts preserved', () => {
    const j = claimOne();
    expect(row(j.id).status).toBe('claimed');
    expect(row(j.id).attempts).toBe(1);        // incremented at claim
    ageClaim(j.id, 10 * 60_000);               // 10 min old
    const n = reclaimStaleJobs(db, 5 * 60_000); // 5 min threshold
    expect(n).toBe(1);
    expect(row(j.id).status).toBe('pending');
    expect(row(j.id).claimed_at).toBeNull();
    expect(row(j.id).attempts).toBe(1);        // NOT reset — crash-loop stays counted
    const reclaimed = claimNextJob(db, 'bge-m3');
    expect(reclaimed?.id).toBe(j.id);           // re-serveable
    expect(row(j.id).attempts).toBe(2);
  });

  it('does NOT reclaim a fresh claimed job (threshold respected)', () => {
    const j = claimOne();                        // claimed_at = now
    expect(reclaimStaleJobs(db, 5 * 60_000)).toBe(0);
    expect(row(j.id).status).toBe('claimed');
  });

  it('startup sweep (olderThanMs=0) reclaims every claimed row regardless of age', () => {
    const j = claimOne();                        // just claimed
    expect(reclaimStaleJobs(db, 0)).toBe(1);
    expect(row(j.id).status).toBe('pending');
  });

  it('never resurrects done or error rows', () => {
    const done = claimOne(); markJobDone(db, done.id);
    const err = claimOne(); markJobError(db, err.id, 'boom');
    expect(reclaimStaleJobs(db, 0)).toBe(0);
    expect(row(done.id).status).toBe('done');
    expect(row(err.id).status).toBe('error');
  });
});
