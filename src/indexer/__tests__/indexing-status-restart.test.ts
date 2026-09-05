/**
 * Slice (f): the durable `indexing_status` marker must survive a process restart.
 *
 * The batched retros reindex (PR#15) writes is_indexing=1 + progress per batch and, on a failed
 * batch, leaves is_indexing=1 + error + completed_at NULL as the "incomplete" signal. Server startup
 * used to blank is_indexing unconditionally, so a run interrupted by a restart (the 2026-09-05
 * containment: 238/4,969 docs committed, then `launchctl kickstart -k`) came back looking idle.
 * Negative control: restore the old unconditional `set({ isIndexing: 0 })` → the first test fails
 * (error stays NULL).
 */
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { createDatabase } from '../../db/index.ts';
import type { IndexerConfig } from '../../types.ts';
import { INTERRUPTED_INDEXING_ERROR, markInterruptedIndexingOnStartup, setIndexingStatus } from '../status.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const config = { repoRoot: '/tmp/repo' } as IndexerConfig;

function freshDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-status-restart-'));
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dbPath = path.join(tmp, 'oracle.db');
  const conn = createDatabase(dbPath);
  cleanups.push(() => conn.sqlite.close());
  const row = () => {
    const r = new Database(dbPath);
    try {
      return r.prepare('SELECT is_indexing, progress_current, progress_total, started_at, completed_at, error FROM indexing_status WHERE id = 1').get() as
        { is_indexing: number; progress_current: number; progress_total: number; started_at: number | null; completed_at: number | null; error: string | null };
    } finally { r.close(); }
  };
  return { ...conn, row };
}

test('a run still in progress at startup is marked interrupted — progress kept, completed_at stays NULL, error says so', () => {
  const { db, row } = freshDb();
  setIndexingStatus(db, config, true, 238, 4969); // mid-run, as left by a killed process
  const before = row();
  expect(markInterruptedIndexingOnStartup(db)).toBe(true);
  const after = row();
  expect(after.is_indexing).toBe(0);
  expect(after.error).toBe(INTERRUPTED_INDEXING_ERROR);
  expect(after.completed_at).toBeNull();
  expect([after.progress_current, after.progress_total]).toEqual([238, 4969]);
  expect(after.started_at).toBe(before.started_at);
  // Idempotent: a second startup finds nothing in progress.
  expect(markInterruptedIndexingOnStartup(db)).toBe(false);
  expect(row().error).toBe(INTERRUPTED_INDEXING_ERROR);
});

test('a run that already failed a batch keeps its own error and gains the interruption note', () => {
  const { db, row } = freshDb();
  setIndexingStatus(db, config, true, 12, 27, 'poison mid-run');
  expect(markInterruptedIndexingOnStartup(db)).toBe(true);
  const after = row();
  expect(after.is_indexing).toBe(0);
  expect(after.error).toBe(`poison mid-run; ${INTERRUPTED_INDEXING_ERROR}`);
  expect(after.completed_at).toBeNull();
});

test('a completed run and an idle row are left untouched', () => {
  const { db, row } = freshDb();
  setIndexingStatus(db, config, true, 0, 27);
  setIndexingStatus(db, config, false, 27, 27);
  const done = row();
  expect(done.completed_at).not.toBeNull();
  expect(markInterruptedIndexingOnStartup(db)).toBe(false);
  expect(row()).toEqual(done);

  const idle = freshDb();
  const seeded = idle.row(); // createDatabase seeds id=1 with is_indexing=0
  expect(seeded.is_indexing).toBe(0);
  expect(markInterruptedIndexingOnStartup(idle.db)).toBe(false);
  expect(idle.row()).toEqual(seeded);
});
