/**
 * Caller-project scoping for oracle_verify (P1, plan 2026-09-04).
 *
 * The shared DB holds documents from many projects; verify used to compare
 * ALL rows against one caller root, producing false orphans for every other
 * project's documents. This module resolves the caller's project identity and
 * classifies each DB row's relationship to it. Rows with project=NULL stay
 * "ambient" (legacy behavior, Class E — never auto-flagged); rows positively
 * owned by another project are excluded.
 *
 * Fail-closed rules (Riddler delta, rounds 2-3):
 * - An explicit project override that does not normalize is refused outright.
 * - Mutation (check:false) requires an EXPLICIT project that matches the
 *   project detected from repoRoot. Omitted project refuses mutation exactly
 *   like a mismatch (fail-closed until alias-resolution exists). Read-only
 *   runs may proceed unscoped (legacy report) or with an operator override.
 */
import { detectProject } from '../server/project-detect.ts';
import { normalizeProject } from '../tools/learn-support.ts';

/** created_by values whose content is canonical in the DB (or imported from an
 *  external vault) — the source_file is nominal or lives outside any repo
 *  root. Never file-orphans. Sources: oracle_learn/arra_learn (learn tools),
 *  oracle_recovery (rescue), zhuge (legacy principle import), seed
 *  (cli/commands/seed.ts), import-obsidian (routes/files/doc.ts). */
const DB_NATIVE_CREATORS = new Set([
  'oracle_learn', 'arra_learn', 'oracle_recovery', 'zhuge', 'seed', 'import-obsidian',
]);

export function isDbNativeCreator(createdBy: string | null | undefined): boolean {
  return createdBy != null && DB_NATIVE_CREATORS.has(createdBy);
}

export type CallerScope = {
  /** Effective scope project (override wins), or null = unscoped legacy read. */
  project: string | null;
  /** Project detected from repoRoot (independent of override), or null. */
  detected: string | null;
  variants: string[] | null;
  /** True when mutation (check:false) is permitted under this scope. */
  mutationAllowed: boolean;
  /** Human-readable reason when mutation is not permitted. */
  mutationRefusedReason?: string;
};

/** Resolve the caller scope. Throws on an invalid explicit override. */
export function resolveCallerScope(repoRoot: string, override?: string | null): CallerScope {
  const detected = detectProject(repoRoot);
  const hasExplicit = override != null && override.trim() !== '';
  let project = detected;
  if (hasExplicit) {
    const normalized = normalizeProject(override);
    if (!normalized) {
      throw new Error(`oracle_verify: invalid project override '${override}' — refusing (fail-closed)`);
    }
    project = normalized;
  }
  const variants = project ? projectVariants(project) : null;
  const refused = (reason: string): CallerScope => ({
    project, detected, variants, mutationAllowed: false, mutationRefusedReason: reason,
  });
  if (!detected) {
    return refused(`repoRoot '${repoRoot}' does not resolve to a project — check:false refused (fail-closed)`);
  }
  if (!hasExplicit) {
    // Round 3: an omitted project must refuse mutation exactly like a
    // mismatch — the caller has not proven it means THIS root's identity.
    return refused(`check:false requires an explicit project matching the repoRoot's project '${detected}' — omitted (fail-closed until alias-resolution)`);
  }
  if (project !== detected) {
    return refused(`project override '${project}' does not match the repoRoot's project '${detected}' — check:false refused (fail-closed)`);
  }
  return { project, detected, variants, mutationAllowed: true };
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
