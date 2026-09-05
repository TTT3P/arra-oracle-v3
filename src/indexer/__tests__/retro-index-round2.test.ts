/**
 * Slice(d) round 2 — search semantics under partial runs, and real transaction boundaries.
 *
 * Riddler P1-1: a mid-run failure must never leave a source file with BOTH generations active
 * (legacy rows + partial new rows both `superseded_by IS NULL`), and a wait=false caller must be
 * able to see that the run did not finish. Fix: file-aligned batches + supersede per batch + the
 * durable indexing_status marker. Negative controls (run by hand, recorded in the PR):
 *   - supersede only at the end  → processed files show legacy AND new active (test e fails);
 *   - slice by doc count instead of file boundary → a straddled file's earlier chunks get
 *     superseded by its own later batch (test e "active == new set" fails).
 * Riddler P2: test b asserted a counter the code itself increments. Here the boundary is read off
 * the connection (raw BEGIN/COMMIT/ROLLBACK through `Database.run`, savepoints through
 * `Database.transaction`) and off a SECOND connection that must see each batch land before the
 * next one starts.
 * Riddler round-2 P1 (test h): a DB error in the supersede step after the store used to leave one
 * file with BOTH generations current through the real `handleSearch`. Fix: one outer transaction
 * per batch publishes store + supersede atomically. Negative control: remove the outer BEGIN/COMMIT
 * → h fails (mixed current results), b2 fails (outer counts).
 */
import { afterEach, expect, test } from 'bun:test';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { createDatabase } from '../../db/index.ts';
import { indexRetrospectives } from '../retro-index.ts';
import { handleSearch } from '../../tools/search/handler.ts';
import type { ToolContext } from '../../tools/types.ts';
import {
  countRows, dropPoison, poisonAfterInserts, retroEnv, runCleanups, seedLegacy, viewDb, withTxnCounter,
} from './retro-index-fixtures.ts';

afterEach(runCleanups);

/** Expected chunk ids per file, derived from the parser's id scheme (`retro_<basename>_<section>`). */
function idsByFile(ids: string[], relPaths: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const rel of relPaths) {
    const prefix = `retro_${path.basename(rel, '.md')}_`;
    out.set(rel, new Set(ids.filter((id) => id.startsWith(prefix))));
  }
  return out;
}

test('e. a mid-run failure leaves every source file on exactly one generation; the marker says incomplete; a rerun converges', async () => {
  // 9 files × 3 sections, each section long enough to chunk → 6 chunk rows per file, 27 docs.
  const { dbPath, repoRoot, relPaths } = retroEnv(9, 3, 900);
  const legacy = seedLegacy(dbPath, relPaths, 2);
  // Fixed N=4 closes at the next file boundary → 2 files (6 docs, 12 chunk rows) per batch.
  // Poison the 17th chunk insert: batch 1 (2 files) commits, batch 2 fails mid-file. Which files land
  // in which batch follows directory order (not sorted on APFS), so read the committed set off the
  // hook. (Slicing by doc count instead — the negative control — stores a file across two batches,
  // and this poison point then leaves that file half-stored with its legacy rows already superseded.)
  poisonAfterInserts(dbPath, 16);
  const committed = new Set<string>();
  await expect(indexRetrospectives(repoRoot, dbPath, {
    batchSize: 4, onBatch: (b) => { for (const f of b.sourceFiles) committed.add(f); },
  })).rejects.toThrow(/poison/);
  expect(committed.size).toBe(2);

  const partial = viewDb(dbPath);
  // Derive the new-generation ids from a clean run of the same corpus on a scratch DB.
  const reference = await indexRetrospectives(repoRoot, path.join(path.dirname(dbPath), 'reference.db'), { batchSize: 4 });
  const expected = idsByFile(reference.ids, relPaths);
  expect(reference.ids.length).toBe(54);

  for (const rel of relPaths) {
    const active = partial.activeBySource.get(rel) ?? new Set<string>();
    const newIds = expected.get(rel)!;
    const legacyIds = new Set(legacy.get(rel)!);
    if (committed.has(rel)) {
      // Processed: the whole new generation is active, every legacy row superseded by one of them.
      expect([...active].sort()).toEqual([...newIds].sort());
      for (const id of legacyIds) expect(newIds.has(partial.supersededBy.get(id)!)).toBe(true);
      for (const id of newIds) { expect(partial.ftsIds.has(id)).toBe(true); expect(partial.pointerDocIds.has(id)).toBe(true); }
    } else {
      // Failed or unreached: untouched legacy generation, and NO trace of the new one (rolled back).
      expect([...active].sort()).toEqual([...legacyIds].sort());
      for (const id of newIds) { expect(partial.ftsIds.has(id)).toBe(false); expect(partial.pointerDocIds.has(id)).toBe(false); }
    }
    // The property Riddler asked for, stated directly: never both generations active on one file.
    const mixed = [...active].some((id) => newIds.has(id)) && [...active].some((id) => legacyIds.has(id));
    expect(mixed).toBe(false);
  }
  // Durable incomplete marker for wait=false callers: still "indexing", with the error, never completed.
  expect(partial.status.is_indexing).toBe(1);
  expect(partial.status.error).toMatch(/poison/);
  expect(partial.status.completed_at).toBeNull();
  expect(partial.status.progress_current).toBe(6);
  expect(partial.status.progress_total).toBe(27);

  // Rerun without the poison: idempotent convergence, and the marker closes.
  dropPoison(dbPath);
  const rerun = await indexRetrospectives(repoRoot, dbPath, { batchSize: 4 });
  const done = viewDb(dbPath);
  for (const rel of relPaths) expect([...done.activeBySource.get(rel)!].sort()).toEqual([...expected.get(rel)!].sort());
  expect(rerun.ids.length).toBe(54);
  expect(done.status.is_indexing).toBe(0);
  expect(done.status.error).toBeNull();
  expect(done.status.completed_at).not.toBeNull();
  expect(done.status.progress_current).toBe(27);
  // A third run finds nothing left to supersede and changes no active set.
  const again = await indexRetrospectives(repoRoot, dbPath, { batchSize: 4 });
  expect(again.superseded).toBe(0);
  expect(countRows(dbPath, 'SELECT COUNT(*) AS n FROM oracle_documents WHERE superseded_by IS NULL')).toBe(54);
});

test('b2. one native transaction per batch, each visible to a second connection before the next starts; N=inf is one', async () => {
  const { dbPath, repoRoot } = retroEnv(9, 3); // 27 short docs, one chunk each
  createDatabase(dbPath).sqlite.close(); // migrate once so the baseline below is only the open cost
  const { txn: base } = await withTxnCounter(async () => { createDatabase(dbPath).sqlite.close(); });

  const reader = new Database(dbPath); // independent connection: sees only COMMITTED rows
  const seen: number[] = [];
  const { result, txn } = await withTxnCounter(() => indexRetrospectives(repoRoot, dbPath, {
    batchSize: 4,
    onBatch: () => seen.push((reader.prepare('SELECT COUNT(*) AS n FROM oracle_documents').get() as { n: number }).n),
  }));
  reader.close();
  expect(result.batches).toBe(5);
  // One raw outer BEGIN/COMMIT per batch (the atomic publish), storeDocuments' own transaction
  // nested inside it as a savepoint — never a commit of its own.
  expect(txn.outer).toEqual({ begin: 5, commit: 5, rollback: 0 });
  expect(txn.nested.begin - base.nested.begin).toBe(5);
  expect(txn.nested.rollback).toBe(0);
  expect(seen).toEqual([6, 12, 18, 24, 27]); // every batch durable before the loop moved on

  const single = retroEnv(9, 3);
  createDatabase(single.dbPath).sqlite.close();
  const reader2 = new Database(single.dbPath);
  const seen2: number[] = [];
  const { txn: one } = await withTxnCounter(() => indexRetrospectives(single.repoRoot, single.dbPath, {
    batchSize: 100000, onBatch: () => seen2.push((reader2.prepare('SELECT COUNT(*) AS n FROM oracle_documents').get() as { n: number }).n),
  }));
  reader2.close();
  expect(one.outer).toEqual({ begin: 1, commit: 1, rollback: 0 }); // the old single-transaction shape
  expect(seen2).toEqual([27]);

  const poisoned = retroEnv(9, 3);
  createDatabase(poisoned.dbPath).sqlite.close();
  poisonAfterInserts(poisoned.dbPath, 12);
  const { txn: failed } = await withTxnCounter(() =>
    indexRetrospectives(poisoned.repoRoot, poisoned.dbPath, { batchSize: 4 }).catch((err: Error) => err));
  expect(failed.outer).toEqual({ begin: 3, commit: 2, rollback: 1 }); // the failing batch rolled back, nothing else did
  expect(failed.nested.rollback).toBe(1);
});

test('h. a DB failure in the supersede step AFTER the store rolls the whole batch back — the real search handler never sees two current generations', async () => {
  // Riddler round-2 reproduction: 2 files × 3 sections, 2 legacy rows per file, and a trigger that
  // aborts the moment a legacy row would be superseded — a DB error after storeDocuments' own
  // transaction has run, i.e. exactly the window round 2 left open.
  const { dbPath, repoRoot, relPaths } = retroEnv(2, 3, 900);
  const legacy = seedLegacy(dbPath, relPaths, 2);
  const setup = createDatabase(dbPath);
  setup.sqlite.run("CREATE TRIGGER fail_supersede BEFORE UPDATE OF superseded_by ON oracle_documents WHEN OLD.id LIKE 'legacy_%' AND NEW.superseded_by IS NOT NULL BEGIN SELECT RAISE(ABORT, 'supersede failure after store'); END");
  setup.sqlite.close();
  await expect(indexRetrospectives(repoRoot, dbPath, { batchSize: 1 })).rejects.toThrow(/supersede failure after store/);

  const isLegacy = (id: string) => id.startsWith('legacy_');
  const search = async () => {
    const read = createDatabase(dbPath);
    const ctx = { ...read, repoRoot, vectorStatus: 'unavailable', version: 'test', vectorStore: null } as unknown as ToolContext;
    try {
      const body = JSON.parse((await handleSearch(ctx, { query: 'session', mode: 'fts', type: 'retro', limit: 100 })).content[0].text);
      return (body.results as Array<{ id: string; source_file: string; superseded: unknown }>);
    } finally { read.sqlite.close(); }
  };

  // Storage: the batch rolled back as a unit — legacy rows current, no trace of the new generation.
  const state = viewDb(dbPath);
  for (const rel of relPaths) expect([...state.activeBySource.get(rel)!].sort()).toEqual([...legacy.get(rel)!].sort());
  expect([...state.ftsIds].some((id) => !isLegacy(id))).toBe(false);
  expect(state.status.is_indexing).toBe(1);
  expect(state.status.error).toMatch(/supersede failure/);
  expect(state.status.completed_at).toBeNull();
  // The real read path: every current result is legacy, and no file mixes generations.
  const results = await search();
  expect(results.length).toBeGreaterThan(0);
  const current = results.filter((r) => r.superseded === null || r.superseded === undefined);
  expect(current.every((r) => isLegacy(r.id))).toBe(true);
  for (const rel of relPaths) {
    const ids = results.filter((r) => r.source_file === rel).map((r) => r.id);
    expect(ids.some(isLegacy) && ids.some((id) => !isLegacy(id))).toBe(false);
  }

  // Rerun once the fault is gone: converges, marker closes, search shows only the new generation as current.
  const fix = createDatabase(dbPath); fix.sqlite.run('DROP TRIGGER fail_supersede'); fix.sqlite.close();
  const rerun = await indexRetrospectives(repoRoot, dbPath, { batchSize: 1 });
  expect(rerun.ids.length).toBe(12);
  const after = viewDb(dbPath);
  expect(after.status.is_indexing).toBe(0);
  expect(after.status.error).toBeNull();
  const currentAfter = (await search()).filter((r) => r.superseded === null || r.superseded === undefined);
  expect(currentAfter.length).toBeGreaterThan(0);
  expect(currentAfter.some((r) => isLegacy(r.id))).toBe(false);
});
