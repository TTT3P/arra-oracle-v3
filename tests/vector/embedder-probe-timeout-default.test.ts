import { afterEach, expect, test } from 'bun:test';
import { DEFAULT_PROBE_TIMEOUT_MS, probeEmbeddingProvider } from '../../src/vector/embedder-config.ts';
import type { EmbeddingProvider } from '../../src/vector/types.ts';

/**
 * 2026-08-29: a cold Ollama model load takes several seconds; with a 2 s probe every
 * cold start was reported 'degraded' and search silently ran FTS-only. The default
 * budget is now 8 s (ORACLE_EMBEDDER_PROBE_TIMEOUT_MS still overrides it).
 */
const saved = process.env.ORACLE_EMBEDDER_PROBE_TIMEOUT_MS;
afterEach(() => {
  if (saved === undefined) delete process.env.ORACLE_EMBEDDER_PROBE_TIMEOUT_MS;
  else process.env.ORACLE_EMBEDDER_PROBE_TIMEOUT_MS = saved;
});

function slowProvider(delayMs: number): EmbeddingProvider {
  return {
    name: 'slow-ollama',
    dimensions: 3,
    async embed() { await Bun.sleep(delayMs); return [[1, 2, 3]]; },
  } as EmbeddingProvider;
}
const selection = { provider: 'ollama', source: 'auto-default', explicit: false } as const;

test('default probe budget is 8 s', () => {
  expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(8_000);
});

test('a 2.5 s cold load is "connected" under the default budget (it was "degraded" at 2 s)', async () => {
  delete process.env.ORACLE_EMBEDDER_PROBE_TIMEOUT_MS;
  const status = await probeEmbeddingProvider(slowProvider(2_500), selection as never);
  expect(status.status).toBe('connected');
}, 15_000);

test('ORACLE_EMBEDDER_PROBE_TIMEOUT_MS still shortens the budget', async () => {
  process.env.ORACLE_EMBEDDER_PROBE_TIMEOUT_MS = '200';
  const status = await probeEmbeddingProvider(slowProvider(1_000), selection as never);
  expect(status.status).toBe('degraded');  // reason is prettified for operators; the status is the contract
});
