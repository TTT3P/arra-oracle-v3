/**
 * Batched retros reindex (PR-B slice d) — makes `scope=retros` on a large root safe on the live
 * process. A whole-root pass was ONE giant `storeDocuments` transaction: it held the single Bun
 * event loop for ~2 min and buffered the entire change set, which memory-pressured the live server
 * into a 310 s zero-commit stall (slice-b live wedge, 2026-09-05). Batching commits every N docs
 * and yields the loop between batches.
 *
 * Every assertion is negative-controlled against N=∞ (one batch = the old single-transaction shape).
 */
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { createDatabase } from '../../db/index.ts';
import { indexRetrospectives } from '../retro-index.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function freshEnv(fileCount: number) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-retro-batched-'));
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dbPath = path.join(tmp, 'oracle.db');
  const repoRoot = path.join(tmp, 'repo');
  const dir = path.join(repoRoot, 'ψ', 'memory', 'retrospectives', '2026-07', '01');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    const n = String(i).padStart(3, '0');
    // Short single-section body → one document per file, so document count is predictable.
    fs.writeFileSync(path.join(dir, `10.${n}_session-${n}.md`),
      `# retro ${n}\n\n## Summary\n\nsession ${n} body with enough characters to satisfy the retro parser minimum section length requirement.\n`);
  }
  return { dbPath, repoRoot };
}

const isTenantScan = (sql: string): boolean =>
  /oracle_pointer_index/i.test(sql) && /"tenant_id" = \?/.test(sql) && !/"id" = \?/.test(sql);

function countTenantScans<T>(run: () => Promise<T>): Promise<{ result: T; scans: number }> {
  let scans = 0;
  const proto = Database.prototype as unknown as { prepare: (sql: string, ...rest: unknown[]) => unknown };
  const original = proto.prepare;
  proto.prepare = function (sql: string, ...rest: unknown[]) {
    if (typeof sql === 'string' && isTenantScan(sql)) scans++;
    return (original as (sql: string, ...rest: unknown[]) => unknown).call(this, sql, ...rest);
  };
  return run().then((result) => { proto.prepare = original; return { result, scans }; },
    (err) => { proto.prepare = original; throw err; });
}

const rowCount = (sqlite: Database, sql: string): number => (sqlite.prepare(sql).get() as { n: number }).n;

test('b. one commit per batch — batch count is ceil(docs / N), and N=inf collapses to one', async () => {
  const { dbPath, repoRoot } = freshEnv(11);
  const batched = await indexRetrospectives(repoRoot, dbPath, 3);
  expect(batched.batches).toBe(Math.ceil(batched.documents / 3));
  expect(batched.batches).toBeGreaterThan(1);

  const { dbPath: d2, repoRoot: r2 } = freshEnv(11);
  const single = await indexRetrospectives(r2, d2, 100000); // N=inf negative control
  expect(single.batches).toBe(1);
});

test('d. tenant pointer scans stay O(batches), not O(docs)', async () => {
  const { dbPath, repoRoot } = freshEnv(11);
  const { result: batched, scans } = await countTenantScans(() => indexRetrospectives(repoRoot, dbPath, 3));
  expect(scans).toBe(batched.batches); // one bulk pointer flush per batch

  const { dbPath: d2, repoRoot: r2 } = freshEnv(11);
  const { result: single, scans: singleScans } = await countTenantScans(() => indexRetrospectives(r2, d2, 100000));
  expect(single.batches).toBe(1);
  expect(singleScans).toBe(1); // the old single-transaction shape: one scan for the whole root
});

test('a. the event loop runs between batches — the whole run does not block it', async () => {
  const tick = (label: { n: number; on: boolean }) => { if (label.on) { label.n++; setImmediate(() => tick(label)); } };

  const { dbPath, repoRoot } = freshEnv(11);
  const batchedTicks = { n: 0, on: true };
  setImmediate(() => tick(batchedTicks));
  const batched = await indexRetrospectives(repoRoot, dbPath, 3);
  batchedTicks.on = false;
  expect(batched.batches).toBeGreaterThanOrEqual(4);
  expect(batchedTicks.n).toBeGreaterThanOrEqual(batched.batches - 1); // loop yielded between batches

  const { dbPath: d2, repoRoot: r2 } = freshEnv(11);
  const singleTicks = { n: 0, on: true };
  setImmediate(() => tick(singleTicks));
  await indexRetrospectives(r2, d2, 100000); // one blocking transaction
  singleTicks.on = false;
  expect(singleTicks.n).toBeLessThan(batchedTicks.n); // the un-batched run starves the loop
});

test('c. a mid-run batch failure keeps earlier batches; a rerun is idempotent', async () => {
  const { dbPath, repoRoot } = freshEnv(11);
  // A counter trigger that aborts once more than 3 documents have been inserted → the 2nd batch
  // (N=3) fails on its first insert while the 1st batch has already committed.
  {
    const { sqlite } = createDatabase(dbPath);
    sqlite.run('CREATE TABLE _ins(n INTEGER)');
    sqlite.run('INSERT INTO _ins VALUES (0)');
    sqlite.run(
      'CREATE TRIGGER poison_ins AFTER INSERT ON oracle_documents BEGIN ' +
      'UPDATE _ins SET n = n + 1; ' +
      "SELECT CASE WHEN (SELECT n FROM _ins) > 3 THEN RAISE(ABORT, 'poison batch 2') END; END",
    );
    sqlite.close();
  }
  await expect(indexRetrospectives(repoRoot, dbPath, 3)).rejects.toThrow(/poison/);

  const after = createDatabase(dbPath).sqlite;
  const committed = rowCount(after, 'SELECT COUNT(*) AS n FROM oracle_documents');
  expect(committed).toBe(3); // exactly the first batch survived; the failing batch rolled back
  after.run('DROP TRIGGER poison_ins');
  after.close();

  const rerun = await indexRetrospectives(repoRoot, dbPath, 3); // no trigger this time
  const done = createDatabase(dbPath).sqlite;
  const active = rowCount(done, 'SELECT COUNT(*) AS n FROM oracle_documents WHERE superseded_by IS NULL');
  done.close();
  expect(active).toBe(rerun.documents); // every doc present exactly once — rerun did not duplicate
});
