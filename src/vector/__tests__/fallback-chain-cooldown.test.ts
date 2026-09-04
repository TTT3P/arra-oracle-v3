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

  it('half-open is single-flight: concurrent callers do not herd the recovering provider', async () => {
    let mode: 'reject' | 'hang' = 'reject';
    const a = provider('a', () => mode === 'reject'
      ? Promise.reject(new Error('down'))
      : new Promise<number[][]>(() => undefined));
    const b = provider('b', () => Promise.resolve([[1]]));
    const chain = new EmbeddingFallbackChain([a, b], {
      cooldownMs: 20, halfOpenTimeoutMs: 30, sticky: false, sleep: noSleep, logger: silent,
    });

    await chain.embed(['x']); // a rejects → cooldown
    mode = 'hang';
    await wait(25); // cooldown expired → half-open eligible
    const results = await Promise.all([chain.embed(['x']), chain.embed(['x'])]);

    expect(results).toEqual([[[1]], [[1]]]);
    expect(a.calls).toBe(2); // 1 initial failure + exactly ONE half-open probe for the pair
    expect(b.calls).toBe(3);
  });

  it('half-open timeout ABORTS the underlying request (signal propagation)', async () => {
    let mode: 'reject' | 'hang' = 'reject';
    let sawAbort = false;
    const a: EmbeddingProvider = {
      name: 'a', dimensions: 4,
      embed(_texts, _type, signal) {
        if (mode === 'reject') return Promise.reject(new Error('down'));
        return new Promise<number[][]>((_resolve, reject) => {
          signal?.addEventListener('abort', () => { sawAbort = true; reject(new Error('aborted')); });
        });
      },
    };
    const b = provider('b', () => Promise.resolve([[1]]));
    const chain = new EmbeddingFallbackChain([a, b], {
      cooldownMs: 20, halfOpenTimeoutMs: 30, sticky: false, sleep: noSleep, logger: silent,
    });

    await chain.embed(['x']);
    mode = 'hang';
    await wait(25);
    const vectors = await chain.embed(['x']); // probe hangs → aborted at 30ms → b serves
    expect(vectors).toEqual([[1]]);
    await wait(5);
    expect(sawAbort).toBe(true);
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
