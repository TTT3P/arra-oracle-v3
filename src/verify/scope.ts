/**
 * Caller-project scoping for oracle_verify (P1, plan 2026-09-04).
 *
 * The shared DB holds documents from many projects; verify used to compare
 * ALL rows against one caller root, producing false orphans for every other
 * project's documents. This module resolves the caller's project identity and
 * classifies each DB row's relationship to it. Rows with project=NULL stay
 * "ambient" (legacy behavior, Class E — never auto-flagged when the caller is
 * scoped); rows positively owned by another project are excluded.
 */
import { detectProject } from '../server/project-detect.ts';
import { normalizeProject } from '../tools/learn-support.ts';

/** created_by values whose content is canonical in the DB — the source_file
 *  is nominal and may never have existed on disk. Never file-orphans. */
const DB_NATIVE_CREATORS = new Set(['oracle_learn', 'arra_learn', 'oracle_recovery', 'zhuge']);

export function isDbNativeCreator(createdBy: string | null | undefined): boolean {
  return createdBy != null && DB_NATIVE_CREATORS.has(createdBy);
}

/** Resolve the caller's project: explicit override first, then repoRoot detection. */
export function resolveCallerProject(repoRoot: string, override?: string | null): string | null {
  if (override) return normalizeProject(override);
  return detectProject(repoRoot);
}

/** Accepted stored forms for one canonical project id (DB has both). */
export function projectVariants(canonical: string): string[] {
  const short = canonical.replace(/^github\.com\//, '');
  return short === canonical ? [canonical] : [canonical, short];
}

export type RowScope = 'owned' | 'ambient' | 'foreign';

/**
 * owned   — row.project matches the caller project
 * ambient — row.project is NULL (unattributable), or the caller is unscoped
 * foreign — row.project positively names another project
 */
export function classifyRowScope(
  rowProject: string | null | undefined,
  callerVariants: string[] | null,
): RowScope {
  if (!callerVariants) return 'ambient';
  if (rowProject == null || rowProject === '') return 'ambient';
  return callerVariants.includes(rowProject.toLowerCase()) ? 'owned' : 'foreign';
}
