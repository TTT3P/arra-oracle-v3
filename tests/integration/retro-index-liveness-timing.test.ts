/**
 * Slice(d) round 2 — timing-sensitive liveness and memory-plateau cases, moved out of the PR gate
 * (audit 2026-09-05): they assert loop lag, real /health/live round-trips and a heap plateau, which
 * a loaded 2-core CI runner or a busy control node cannot measure reliably. Runs in the scheduled
 * `scheduled-smokes` workflow. The in-gate sibling src/indexer/__tests__/retro-index-liveness.test.ts
 * keeps the deterministic writer-concurrency case.
 */
import { afterEach, expect, test } from 'bun:test';
import { indexRetrospectives, type RetrosBatchInfo } from '../../src/indexer/retro-index.ts';
import { lagSampler, livenessProbe, percentile, retroEnv, runCleanups } from '../../src/indexer/__tests__/retro-index-fixtures.ts';

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

