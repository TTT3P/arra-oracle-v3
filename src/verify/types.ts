/** Result shapes for oracle_verify. */

export interface VerifyResult {
  counts: {
    healthy: number;
    missing: number;
    orphaned: number;
    drifted: number;
    untracked: number;
    /** DB-native rows (content canonical in DB) — never file-orphans. */
    dbNative: number;
    /** Rows positively owned by another project — excluded from this run. */
    foreignExcluded: number;
    /** File-backed rows with project=NULL whose path is absent under the
     *  caller root — Class E: reported, never auto-flagged. */
    unattributedOrphans: number;
  };
  missing: string[];
  orphaned: string[];
  drifted: string[];
  untracked: string[];
  unattributedOrphans: string[];
  dbNative: string[];
  /** How this run was scoped: caller project id, or null = legacy unscoped. */
  scope: { project: string | null; scoped: boolean };
  mismatches: VerifyMismatch[];
  recommendation: string;
  fixedOrphans?: number;
}

export interface VerifyMismatch {
  kind: 'missing' | 'orphaned' | 'drifted' | 'untracked';
  sourceFile: string;
  ids?: string[];
  indexedAt?: number;
  mtimeMs?: number;
}
