/**
 * Cooperative yields for the indexer's long synchronous loops.
 *
 * Incident 2026-08-29: `POST /api/indexer/reindex` walked and parsed ~12k
 * files on the single Bun event loop for 7–87 s per call; 114 calls in 21 h
 * starved `/api/health` (3 s probes → 000) so every seat saw
 * `vectorAvailable:false` while the server was merely busy.
 *
 * Three places hand the loop back: directory discovery (`walkMarkdownFiles`,
 * async readdir + a yield per directory), file read+parse (`forEachYielding`,
 * a yield every N files) and the SQLite store (`storeDocuments` commits in
 * batches of N*8 with a yield between them). N comes from
 * `ORACLE_INDEX_YIELD_EVERY` (default 25; `0` disables every yield — used by
 * `tests/indexer/reindex-loop-canary.test.ts` to measure the difference).
 */

import fs from 'fs';
import path from 'path';

export const DEFAULT_YIELD_EVERY_FILES = 25;

/** Files per batch before yielding; 0 = never yield (measurement baseline). */
export function yieldEvery(env = process.env): number {
  const raw = env.ORACLE_INDEX_YIELD_EVERY?.trim();
  if (raw === undefined || raw === '') return DEFAULT_YIELD_EVERY_FILES;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_YIELD_EVERY_FILES;
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Run `fn` over `items`, yielding to the event loop every `every` items (0 = never). */
export async function forEachYielding<T>(
  items: readonly T[],
  fn: (item: T) => void,
  every: number = yieldEvery(),
): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    fn(items[i]);
    if (every > 0 && (i + 1) % every === 0) await yieldToEventLoop();
  }
}

function skippableFsError(err: unknown): boolean {
  const code = err && typeof err === 'object' && 'code' in err
    ? (err as NodeJS.ErrnoException).code
    : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM';
}

/**
 * Async twin of `getAllMarkdownFiles` (collectors.ts): same result set and
 * ordering, but readdir is non-blocking and the loop is yielded once per
 * directory. Broken symlinks / vanished entries are skipped like the sync walk.
 */
export async function walkMarkdownFiles(dir: string, every: number = yieldEvery()): Promise<string[]> {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (skippableFsError(err)) return files;
    throw err;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDir = (await fs.promises.stat(fullPath)).isDirectory();
      } catch (err) {
        if (skippableFsError(err)) continue;
        throw err;
      }
    }
    if (isDir) {
      files.push(...await walkMarkdownFiles(fullPath, every));
    } else if (entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  if (every > 0) await yieldToEventLoop();
  return files;
}

/** Batches of whole source files, ~`every` docs each (0 = one batch). A source file's
 *  chunks must stay together: supersede compares each source's stale rows against them. */
export function groupBySourceFile<T extends { source_file: string }>(documents: T[], every: number): T[][] {
  const bySource = new Map<string, T[]>();
  for (const doc of documents) bySource.set(doc.source_file, [...(bySource.get(doc.source_file) ?? []), doc]);
  const groups: T[][] = [];
  let current: T[] = [];
  for (const docs of bySource.values()) {
    current.push(...docs);
    if (every > 0 && current.length >= every) { groups.push(current); current = []; }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
