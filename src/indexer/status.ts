/**
 * Indexing status updates for tray app
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { asOracleDb, type OracleDbInput } from '../db/drizzle-input.ts';
import { indexingStatus } from '../db/schema.ts';
import type { IndexerConfig } from '../types.ts';

/**
 * Update indexing status for tray app
 */
export function setIndexingStatus(
  input: OracleDbInput,
  config: IndexerConfig,
  isIndexing: boolean,
  current: number = 0,
  total: number = 0,
  error?: string
): void {
  const db = asOracleDb(input);
  // Ensure repo_root column exists (migration)
  try {
    db.run(sql`ALTER TABLE indexing_status ADD COLUMN repo_root TEXT`);
  } catch {
    // Column already exists
  }

  const now = Date.now();
  db.update(indexingStatus)
    .set({
      isIndexing: isIndexing ? 1 : 0,
      progressCurrent: current,
      progressTotal: total,
      startedAt: isIndexing ? sql`coalesce(${indexingStatus.startedAt}, ${now})` : sql`${indexingStatus.startedAt}`,
      completedAt: isIndexing ? null : now,
      error: error || null,
      repoRoot: config.repoRoot,
    })
    .where(eq(indexingStatus.id, 1))
    .run();
}

export const INTERRUPTED_INDEXING_ERROR = 'interrupted: indexer process restarted before the run completed';

/**
 * Startup reconciliation for `indexing_status` id=1. A run that was still marked in progress when
 * the process died (is_indexing=1, completed_at NULL) is marked INTERRUPTED — is_indexing cleared so
 * nothing looks alive, but progress, started_at and a NULL completed_at are kept and `error` records
 * the interruption (appended after any error the run itself left, e.g. a failed batch). A completed
 * or idle row is left untouched. Before this, startup blanked is_indexing and the incomplete run
 * became invisible (2026-09-05 slice(d) deploy receipt). Returns true when a run was marked.
 */
export function markInterruptedIndexingOnStartup(input: OracleDbInput): boolean {
  const db = asOracleDb(input);
  const row = db.select({ error: indexingStatus.error })
    .from(indexingStatus)
    .where(and(eq(indexingStatus.id, 1), eq(indexingStatus.isIndexing, 1), isNull(indexingStatus.completedAt)))
    .get();
  if (!row) return false;
  const error = row.error ? `${row.error}; ${INTERRUPTED_INDEXING_ERROR}` : INTERRUPTED_INDEXING_ERROR;
  db.update(indexingStatus).set({ isIndexing: 0, error }).where(eq(indexingStatus.id, 1)).run();
  return true;
}
