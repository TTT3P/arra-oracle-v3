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
  /** How this run was scoped. project = effective scope (override wins);
   *  detected = project resolved from repoRoot; mutationAllowed = whether
   *  check:false would be permitted (requires an explicit project matching
   *  detected); mutationRefusedReason explains a false mutationAllowed. */
  scope: {
    project: string | null;
    detected: string | null;
    scoped: boolean;
    mutationAllowed: boolean;
    mutationRefusedReason?: string;
  };
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
