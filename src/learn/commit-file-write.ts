import fs from 'fs';
import path from 'path';
import type { Database } from 'bun:sqlite';

export const LEARNING_FILE_OUTSIDE_ROOT = 'Learning file path escapes the memory root';

const isWithin = (root: string, target: string): boolean => target === root || target.startsWith(root + path.sep);

function deepestExisting(dir: string): string {
  let current = dir;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/**
 * Create a learning file under `root` with exclusive create (`wx`).
 *
 * Containment is checked on REAL paths (Riddler PR#20 S1): the deepest existing
 * ancestor of the target directory is resolved through symlinks and must lie
 * inside the resolved root BEFORE any directory is created, so `ψ -> outside`
 * or `ψ/memory -> outside` can neither receive the file nor get new directories.
 * `wx` refuses an existing file or symlink at the target (F1), so a competing
 * writer's file is never overwritten — and therefore never removed by the
 * rollback, which only ever deletes the path this call returns.
 * Returns the real path of the created file.
 */
export function createContainedFile(root: string, filePath: string, content: string): string {
  const realRoot = fs.realpathSync(path.resolve(root));
  const target = path.resolve(filePath);
  const dir = path.dirname(target);
  if (!isWithin(realRoot, fs.realpathSync(deepestExisting(dir)))) throw new Error(LEARNING_FILE_OUTSIDE_ROOT);
  fs.mkdirSync(dir, { recursive: true });
  const realDir = fs.realpathSync(dir);
  if (!isWithin(realRoot, realDir)) throw new Error(LEARNING_FILE_OUTSIDE_ROOT);
  const realTarget = path.join(realDir, path.basename(target));
  fs.writeFileSync(realTarget, content, { encoding: 'utf-8', flag: 'wx' });
  return realTarget;
}

/**
 * Run the row half of a "write the markdown file, then the rows" learning write
 * inside one SQLite transaction. If any statement throws, the transaction rolls
 * back and the file this write just created is removed, so a failed learn leaves
 * neither a row without a file nor a file without a row.
 *
 * Background (audit 2026-09-05): every learn path wrote the file first and the
 * `oracle_documents` / `oracle_fts` / sidecar rows afterwards with no rollback; a
 * seat whose insert failed left a markdown file behind — 26 such orphan files
 * were found under the data dir with no row anywhere. Drizzle statements issued
 * through the same connection participate in the transaction.
 *
 * `filePath` must be the file created by the caller immediately before this
 * call (never a pre-existing file — the caller guarantees that with `wx` /
 * an existence check), because it is deleted on failure.
 */
export function commitRowsOrRemoveFile<T>(sqlite: Database, filePath: string, write: () => T): T {
  try {
    return sqlite.transaction(write)();
  } catch (err) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best effort: the row write already failed; the caller sees that error.
    }
    throw err;
  }
}
