import fs from 'fs';
import type { Database } from 'bun:sqlite';

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
