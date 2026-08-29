/**
 * Cooperative yields for the indexer's long synchronous loops.
 *
 * Incident 2026-08-29: `POST /api/indexer/reindex` walked and parsed ~12k
 * files on the single Bun event loop for 7–87 s per call; 114 calls in 21 h
 * starved `/api/health` (3 s probes → 000) so every seat saw
 * `vectorAvailable:false` while the server was merely busy. The collectors
 * stay synchronous per file (readFileSync + parse is short) but hand the loop
 * back every `YIELD_EVERY_FILES` files so health probes and searches get a
 * turn between batches.
 */

export const YIELD_EVERY_FILES = 25;

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Run `fn` over `items`, yielding to the event loop every `every` items. */
export async function forEachYielding<T>(
  items: readonly T[],
  fn: (item: T) => void,
  every: number = YIELD_EVERY_FILES,
): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    fn(items[i]);
    if ((i + 1) % every === 0) await yieldToEventLoop();
  }
}
