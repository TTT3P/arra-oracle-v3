import { describe, expect, it } from 'bun:test';
import { EmbeddingFallbackChain } from '../fallback-chain.ts';
import type { EmbeddingProvider } from '../types.ts';

type CountingProvider = EmbeddingProvider & { calls: number };

function provider(name: string, impl: () => Promise<number[][]>): CountingProvider {
  const p: CountingProvider = {
    name,
    dimensions: 4,
    calls: 0,
    async embed() { p.calls += 1; return impl(); },
  };
  return p;
}

const noSleep = () => Promise.resolve();
const silent = () => undefined;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('EmbeddingFallbackChain cooldown circuit breaker', () => {
  it('skips a failed provider during its cooldown', async () => {
    const a = provider('a', () => Promise.reject(new Error('down')));
    const b = provider('b', () => Promise.resolve([[1]]));
    const chain = new EmbeddingFallbackChain([a, b], {
      cooldownMs: 60_000, sticky: false, sleep: noSleep, logger: silent,
    });

    await chain.embed(['x']); // a fails, b serves, a enters cooldown
    await chain.embed(['x']); // a skipped — b serves directly

    expect(a.calls).toBe(1);
    expect(b.calls).toBe(2);
  });

  it('re-tries after cooldown with a bounded half-open probe, then recovers', async () => {
    let mode: 'reject' | 'hang' | 'ok' = 'reject';
    const a = provider('a', () => {
      if (mode === 'reject') return Promise.reject(new Error('down'));
      if (mode === 'hang') return new Promise<number[][]>(() => undefined);
      return Promise.resolve([[7]]);
    });
    const b = provider('b', () => Promise.resolve([[1]]));
    const chain = new EmbeddingFallbackChain([a, b], {
      cooldownMs: 20, halfOpenTimeoutMs: 30, sticky: false, sleep: noSleep, logger: silent,
    });

    await chain.embed(['x']); // a rejects → b
    mode = 'hang';
    await wait(25); // cooldown expired → half-open
    const hung = await chain.embed(['x']); // a probe times out at 30ms → b
    expect(hung).toEqual([[1]]);
    expect(a.calls).toBe(2);

    mode = 'ok';
    await wait(25);
    const recovered = await chain.embed(['x']); // a answers again → primary restored
    expect(recovered).toEqual([[7]]);
    expect(chain.getStats().lastProvider).toBe('a');
  });

  it('still attempts when every provider is cooling down', async () => {
    const a = provider('a', () => Promise.reject(new Error('down')));
    const chain = new EmbeddingFallbackChain([a], {
      cooldownMs: 60_000, sticky: false, sleep: noSleep, logger: silent,
    });

    await expect(chain.embed(['x'])).rejects.toThrow('down');
    await expect(chain.embed(['x'])).rejects.toThrow(); // not silently skipped
    expect(a.calls).toBe(2);
  });

  it('keeps legacy behavior when cooldown is disabled', async () => {
    const a = provider('a', () => Promise.reject(new Error('down')));
    const b = provider('b', () => Promise.resolve([[1]]));
    const chain = new EmbeddingFallbackChain([a, b], { sticky: false, sleep: noSleep, logger: silent });

    await chain.embed(['x']);
    await chain.embed(['x']);

    expect(a.calls).toBe(2); // no cooldown: primary re-tried every call
    expect(b.calls).toBe(2);
  });
});
