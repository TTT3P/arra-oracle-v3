import { describe, it, expect } from 'bun:test';
import { forEachYielding, yieldToEventLoop } from '../yield.ts';

describe('indexer cooperative yield (incident 2026-08-29)', () => {
  it('visits every item in order', async () => {
    const seen: number[] = [];
    await forEachYielding([1, 2, 3, 4, 5], (n) => seen.push(n), 2);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it('lets a pending timer run between batches instead of after the whole loop', async () => {
    const order: string[] = [];
    setTimeout(() => order.push('timer'), 0);
    await forEachYielding(['a', 'b', 'c', 'd'], (x) => order.push(x), 2);
    // Without the yield the timer would only fire once the loop finished ('a','b','c','d','timer').
    expect(order.indexOf('timer')).toBeLessThan(order.indexOf('d'));
  });

  it('yieldToEventLoop resolves', async () => {
    await expect(yieldToEventLoop()).resolves.toBeUndefined();
  });
});
