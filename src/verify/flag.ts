/**
 * check:false orphan flagging — the ONLY mutation oracle_verify can perform.
 *
 * Per-id guard (Riddler round 2 #3): rows sharing one source_file can mix
 * project-proven ('owned') and project=NULL rows; only the owned ids may be
 * supersede-marked. NULL rows are Class E — held, never auto-flagged.
 */
import { and, eq } from 'drizzle-orm';
import { db, oracleDocuments } from '../db/index.ts';

export type FlagEntry = { ownedIds: string[] };

export function flagOwnedOrphans(
  orphaned: string[],
  entries: Map<string, FlagEntry>,
  tenantId: string | null | undefined,
): number {
  const now = Date.now();
  let flagged = 0;
  for (const sourceFile of orphaned) {
    const entry = entries.get(sourceFile);
    if (!entry) continue;
    for (const id of entry.ownedIds) {
      const where = tenantId
        ? and(eq(oracleDocuments.id, id), eq(oracleDocuments.tenantId, tenantId))
        : eq(oracleDocuments.id, id);
      db.update(oracleDocuments)
        .set({
          supersededBy: '_verified_orphan',
          supersededAt: now,
          supersededReason: 'File missing from disk (oracle_verify)',
        })
        .where(where)
        .run();
      flagged++;
    }
  }
  return flagged;
}
