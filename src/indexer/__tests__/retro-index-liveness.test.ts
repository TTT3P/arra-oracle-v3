/**
 * Slice(d) round 2 — liveness against the REAL budget, and a bounded JS live set.
 *
 * Riddler P1-2: the fleet health probe (`src/ensure-server.ts`) aborts at 2 s; a fixed 250-doc
 * batch blocked 4–13 s, so the old "the loop ticked between batches" assertion could pass while
 * every probe still timed out. Here the adaptive sizer must keep each batch near its target and
 * the run is measured two ways: setTimeout drift (event-loop lag) and real HTTP round-trips to the
 * real `/health/live` route with the fleet's own 2 s abort. The N=∞ control proves the instruments
 * see a blocked loop. Riddler memory: the loop must accumulate ids only, and release processed
 * files, so heap after the last batch is not the heap after the first plus the whole corpus.
 */
import { afterEach, expect, test } from 'bun:test';
import { createDatabase } from '../../db/index.ts';
import { indexRetrospectives, type RetrosBatchInfo } from '../retro-index.ts';
import { storeDocuments } from '../storage.ts';
import type { OracleDocument } from '../../types.ts';
import { lagSampler, livenessProbe, percentile, retroEnv, runCleanups } from './retro-index-fixtures.ts';

afterEach(runCleanups);

const TARGET_MS = 40;

test('f. adaptive batches keep loop lag and real /health/live round-trips far inside the 2 s abort; N=inf does not', async () => {
  const { dbPath, repoRoot } = retroEnv(300, 3, 600); // 900 docs — a single transaction blocks for well over a second
  const batches: RetrosBatchInfo[] = [];
  const lag = lagSampler(5);
  const probe = livenessProbe(5);
  const t0 = performance.now();
  const result = await indexRetrospectives(repoRoot, dbPath, { targetMs: TARGET_MS, initialBatchSize: 6, onBatch: (b) => batches.push(b) });
  const wall = performance.now() - t0;
  const lags = await lag.stop();
  const { latencies, aborts } = await probe.stop();

  expect(result.batches).toBeGreaterThan(3);
  // The sizer converged: after its first measurement every batch stays near the target (one file
  // is the floor, so a batch can never be split finer than that).
  const later = batches.slice(1).map((b) => b.wallMs);
  expect(Math.max(...later)).toBeLessThan(TARGET_MS * 3 + 50);
  // Loop lag stays a small multiple of the target — and nowhere near the fleet's 2 s budget.
  expect(percentile(lags, 0.99)).toBeLessThan(TARGET_MS * 4 + 100);
  expect(Math.max(...lags)).toBeLessThan(2000);
  // Real probes: none aborted, p99 round-trip inside the budget with room to spare.
  expect(aborts).toBe(0);
  expect(latencies.length).toBeGreaterThan(5);
  expect(percentile(latencies, 0.99)).toBeLessThan(TARGET_MS * 4 + 100);
  expect(percentile(latencies, 0.99)).toBeLessThan(2000);

  // Negative control: one transaction for the whole corpus — the instruments must see the block.
  const single = retroEnv(300, 3, 600);
  const lag2 = lagSampler(5);
  const probe2 = livenessProbe(5);
  const s0 = performance.now();
  await indexRetrospectives(single.repoRoot, single.dbPath, { batchSize: 100000 });
  const singleWall = performance.now() - s0;
  const lags2 = await lag2.stop();
  const { latencies: lat2 } = await probe2.stop();
  expect(Math.max(...lags2)).toBeGreaterThan(singleWall * 0.8); // the loop was held for the whole run
  expect(Math.max(...lags2)).toBeGreaterThan(Math.max(...lags) * 3);
  expect(Math.max(...lat2)).toBeGreaterThan(percentile(latencies, 0.99) * 3);
  expect(singleWall).toBeGreaterThan(wall * 0.3); // sanity: batching did not make the run pathologically slower
});

test('g. the JS live set plateaus: ids only, processed files released', async () => {
  // 240 files × 2 sections × 4,000 chars → 480 docs, 2,880 chunk rows, ~2 MB of source content.
  const { dbPath, repoRoot } = retroEnv(240, 2, 4000);
  const heap: number[] = [];
  const sample = () => { Bun.gc(true); heap.push(process.memoryUsage().heapUsed); };
  const result = await indexRetrospectives(repoRoot, dbPath, { batchSize: 40, onBatch: sample });
  expect(result.batches).toBe(12);
  expect(result.ids.length).toBe(2880);
  const growth = (heap[heap.length - 1] - heap[0]) / 1e6;
  // Measured (Bun 1.3, forced GC per batch): ids only + released file groups → +0.5 MB from the
  // first to the last batch; keeping the chunked documents with content and never releasing the
  // groups (v1 shape, the negative control) → +4.5 MB and still climbing.
  expect(growth).toBeLessThan(2);
});

test('i. a second same-process writer (Huginn-style createDatabase + storeDocuments) completes and persists while the reindex runs', async () => {
  // Riddler round-3 reproduction: two real connections from the production factory on one event
  // loop, no mocked storage, no changed busy_timeout. Round 3's outer BEGIN IMMEDIATE around
  // `await storeDocuments` left the write lock held while the loop ran the writer → SQLITE_BUSY.
  const { dbPath, repoRoot } = retroEnv(3, 3, 900);
  const writer = createDatabase(dbPath);
  const doc: OracleDocument = {
    id: 'concurrent_learning', type: 'learning', source_file: 'concurrent-learning.md',
    content: 'Concurrent Huginn-style storage while retrospective indexing runs.', concepts: ['review'],
    created_at: Date.now(), updated_at: Date.now(),
  };
  const indexing = indexRetrospectives(repoRoot, dbPath, { batchSize: 1 });
  let failure: unknown = null;
  try { await storeDocuments(writer.sqlite, writer.db, null, null, [doc]); } catch (err) { failure = err; }
  const result = await indexing;
  const persisted = writer.sqlite.query('SELECT id FROM oracle_documents WHERE id = ?').get(doc.id);
  expect(writer.sqlite.inTransaction).toBe(false);
  writer.sqlite.close();
  expect(failure).toBeNull();
  expect(persisted).not.toBeNull();
  expect(result.batches).toBe(3); // the reindex finished too
  expect(result.ids.length).toBe(18);
}, 15000);
