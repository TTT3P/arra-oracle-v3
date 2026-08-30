import { afterEach, expect, test } from 'bun:test';
import {
  DEFAULT_WARM_INTERVAL_MS, embedderWarmKeepaliveStatus, ensureEmbedderWarmKeepalive,
  stopEmbedderWarmKeepalive, warmIntervalMs,
} from '../../src/vector/embedder-warm.ts';

/** PR-C (2026-08-30): one in-process timer keeps the embedder warm so a cold probe stays rare. */
const saved = process.env.ORACLE_EMBEDDER_WARM_INTERVAL_MS;
afterEach(() => {
  stopEmbedderWarmKeepalive();
  if (saved === undefined) delete process.env.ORACLE_EMBEDDER_WARM_INTERVAL_MS;
  else process.env.ORACLE_EMBEDDER_WARM_INTERVAL_MS = saved;
});

test('default interval is 3 minutes; env overrides; 0 disables', () => {
  delete process.env.ORACLE_EMBEDDER_WARM_INTERVAL_MS;
  expect(warmIntervalMs()).toBe(DEFAULT_WARM_INTERVAL_MS);
  expect(DEFAULT_WARM_INTERVAL_MS).toBe(180_000);
  expect(warmIntervalMs({ ORACLE_EMBEDDER_WARM_INTERVAL_MS: '5000' } as NodeJS.ProcessEnv)).toBe(5000);
  expect(warmIntervalMs({ ORACLE_EMBEDDER_WARM_INTERVAL_MS: 'nope' } as NodeJS.ProcessEnv)).toBe(DEFAULT_WARM_INTERVAL_MS);
  expect(ensureEmbedderWarmKeepalive(async () => {}, 0)).toBe(false);
  expect(embedderWarmKeepaliveStatus().running).toBe(false);
});

test('probes repeatedly on the interval, is idempotent, swallows failures, and stops', async () => {
  let calls = 0;
  const probe = async () => { calls++; if (calls % 2 === 0) throw new Error('cold'); };
  expect(ensureEmbedderWarmKeepalive(probe, 20)).toBe(true);
  expect(ensureEmbedderWarmKeepalive(probe, 20)).toBe(false);  // second caller is a no-op
  expect(embedderWarmKeepaliveStatus()).toEqual({ running: true, intervalMs: 20 });
  await Bun.sleep(130);
  expect(calls).toBeGreaterThanOrEqual(3);
  stopEmbedderWarmKeepalive();
  const after = calls;
  await Bun.sleep(60);
  expect(calls).toBe(after);
  expect(embedderWarmKeepaliveStatus().running).toBe(false);
});

test('readEmbedderRuntimeStatus arms the keepalive once per process', async () => {
  process.env.ORACLE_EMBEDDER = 'none';
  const { readEmbedderRuntimeStatus } = await import('../../src/vector/embedder-config.ts');
  await readEmbedderRuntimeStatus({ force: true });
  expect(embedderWarmKeepaliveStatus().running).toBe(true);
  delete process.env.ORACLE_EMBEDDER;
});
