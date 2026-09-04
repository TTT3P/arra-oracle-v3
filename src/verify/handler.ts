/**
 * Oracle Verify Handler
 *
 * Compares ψ/ files on disk vs DB index.
 * Detects: healthy, missing, orphaned, drifted, untracked files.
 *
 * Philosophy: "Nothing is Deleted" — orphans are flagged, not removed.
 *
 * P1 scoping (plan 2026-09-04, Riddler round 2): rows owned by another
 * project are excluded; superseded rows (by either field) never participate;
 * DB-native rows are tagged, not orphaned; project=NULL rows are reported
 * separately and never auto-flagged (per-id guard). check:false is
 * fail-closed: it requires a root-proven scope and marks only owned ids.
 */

import path from 'path';
import { and, eq, isNull } from 'drizzle-orm';
import { db, oracleDocuments } from '../db/index.ts';
import { currentTenantId } from '../middleware/tenant.ts';
import { walkMarkdownFiles } from './files.ts';
import { flagOwnedOrphans } from './flag.ts';
import { normalizeSourceFile } from './paths.ts';
import { classifyRowScope, isDbNativeCreator, resolveCallerScope } from './scope.ts';
import type { VerifyMismatch, VerifyResult } from './types.ts';

export type { VerifyMismatch, VerifyResult } from './types.ts';

export function verifyKnowledgeBase(opts: {
  check?: boolean;
  type?: string;
  repoRoot: string;
  project?: string;
}): VerifyResult {
  const { check = true, type, repoRoot } = opts;
  const tenantId = currentTenantId();
  const scope = resolveCallerScope(repoRoot, opts.project); // throws on invalid override
  if (!check && !scope.mutationAllowed) {
    throw new Error(`oracle_verify: ${scope.mutationRefusedReason}`);
  }
  const callerVariants = scope.variants;

  // 1. Walk indexed directories on disk
  const indexedDirs = [
    'ψ/memory/resonance',
    'ψ/memory/learnings',
    'ψ/memory/retrospectives',
    'ψ/learn',
  ];
  const diskFiles = new Map<string, number>(); // relativePath -> mtimeMs
  for (const dir of indexedDirs) {
    const files = walkMarkdownFiles(path.join(repoRoot, dir), repoRoot);
    for (const f of files) diskFiles.set(f.relativePath, f.mtimeMs);
  }

  // 2. Query DB. Retired rows never participate: the learn CRUD soft-delete
  // sets superseded_at WITHOUT superseded_by, so filter on BOTH fields.
  const normalizedType = type?.trim();
  const typeFilter = normalizedType && normalizedType !== 'all' ? normalizedType : undefined;
  const conditions = [isNull(oracleDocuments.supersededBy), isNull(oracleDocuments.supersededAt)];
  if (typeFilter) conditions.push(eq(oracleDocuments.type, typeFilter));
  if (tenantId) conditions.push(eq(oracleDocuments.tenantId, tenantId));
  const dbRows = db.select({
    id: oracleDocuments.id,
    sourceFile: oracleDocuments.sourceFile,
    indexedAt: oracleDocuments.indexedAt,
    type: oracleDocuments.type,
    project: oracleDocuments.project,
    createdBy: oracleDocuments.createdBy,
  })
    .from(oracleDocuments)
    .where(and(...conditions))
    .all();

  // Build map: sourceFile -> { indexedAt, ids[], ownedIds[] }
  // Multiple DB entries can point to the same source file (chunked docs).
  // ownedIds tracks project-proven rows per id — the ONLY flaggable ids.
  const dbFileMap = new Map<string, { indexedAt: number; ids: string[]; ownedIds: string[] }>();
  const dbNativeSet = new Set<string>();
  let foreignExcluded = 0;
  for (const row of dbRows) {
    const sourceFile = normalizeSourceFile(row.sourceFile, repoRoot);
    if (!sourceFile) continue;
    if (isDbNativeCreator(row.createdBy)) {
      dbNativeSet.add(sourceFile);
      continue;
    }
    const rowScope = classifyRowScope(row.project, callerVariants);
    if (rowScope === 'foreign') {
      foreignExcluded++;
      continue;
    }
    let entry = dbFileMap.get(sourceFile);
    if (!entry) {
      entry = { indexedAt: row.indexedAt, ids: [], ownedIds: [] };
      dbFileMap.set(sourceFile, entry);
    }
    entry.ids.push(row.id);
    if (rowScope === 'owned') entry.ownedIds.push(row.id);
    if (row.indexedAt > entry.indexedAt) entry.indexedAt = row.indexedAt;
  }

  // 3. Classify
  const healthy: string[] = [];
  const missing: string[] = [];
  const drifted: string[] = [];
  const orphaned: string[] = [];
  const unattributedOrphans: string[] = [];

  // Tenant-scoped requests can only prove ownership for DB-backed files.
  // Keep global disk-only "missing"/"untracked" reporting for unscoped runs.
  const pathsToCheck = tenantId ? dbFileMap.keys() : diskFiles.keys();
  for (const relPath of pathsToCheck) {
    const mtimeMs = diskFiles.get(relPath);
    const dbEntry = dbFileMap.get(relPath);
    if (!dbEntry) {
      // File on disk, not in DB (DB-native rows don't claim the path)
      if (!dbNativeSet.has(relPath)) missing.push(relPath);
    } else if (mtimeMs === undefined) {
      continue;
    } else if (mtimeMs > dbEntry.indexedAt) {
      drifted.push(relPath);
    } else {
      healthy.push(relPath);
    }
  }

  // DB entries absent from disk: 'orphaned' only when project-proven rows
  // exist for the path; otherwise Class E (reported, never flagged).
  for (const [sourceFile, entry] of dbFileMap) {
    if (diskFiles.has(sourceFile)) continue;
    if (callerVariants && entry.ownedIds.length === 0) unattributedOrphans.push(sourceFile);
    else orphaned.push(sourceFile);
  }

  // 4. Count untracked files outside indexed dirs.
  const untracked: string[] = [];
  if (!tenantId) {
    for (const dir of ['ψ/inbox']) {
      const files = walkMarkdownFiles(path.join(repoRoot, dir), repoRoot);
      for (const f of files) untracked.push(f.relativePath);
    }
  }

  // 5. Flag owned orphan ids if check=false (mutation gate already passed)
  const fixedOrphans = !check && orphaned.length > 0
    ? flagOwnedOrphans(orphaned, dbFileMap, tenantId)
    : 0;

  // 6. Build recommendation
  const issues = missing.length + orphaned.length + drifted.length;
  let recommendation = '';
  if (issues === 0) {
    recommendation = 'Knowledge base is healthy. All files match DB index.';
  } else {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`${missing.length} missing from index`);
    if (orphaned.length > 0) parts.push(`${orphaned.length} orphaned in DB`);
    if (drifted.length > 0) parts.push(`${drifted.length} drifted since last index`);
    recommendation = `Run \`bun run index\` to fix ${issues} issues (${parts.join(', ')})`;
  }
  if (scope.detected && scope.project !== scope.detected) {
    recommendation += ` WARNING: scoped to '${scope.project}' but repoRoot is '${scope.detected}' — disk-side results describe the repoRoot, not the override.`;
  }
  if (unattributedOrphans.length > 0) {
    recommendation += ` ${unattributedOrphans.length} unattributed (project=NULL) rows lack a file under this root — held, not flagged.`;
  }
  if (fixedOrphans > 0) {
    recommendation += `. Flagged ${fixedOrphans} owned orphan rows as '_verified_orphan'.`;
  }

  const dbDetails = (sourceFile: string) => {
    const entry = dbFileMap.get(sourceFile);
    return entry ? { ids: entry.ids, indexedAt: entry.indexedAt } : {};
  };
  const mismatches: VerifyMismatch[] = [
    ...missing.map((sourceFile) => ({ kind: 'missing' as const, sourceFile, mtimeMs: diskFiles.get(sourceFile) })),
    ...orphaned.map((sourceFile) => ({ kind: 'orphaned' as const, sourceFile, ...dbDetails(sourceFile) })),
    ...drifted.map((sourceFile) => ({
      kind: 'drifted' as const,
      sourceFile,
      mtimeMs: diskFiles.get(sourceFile),
      ...dbDetails(sourceFile),
    })),
    ...untracked.map((sourceFile) => ({ kind: 'untracked' as const, sourceFile })),
  ];

  return {
    counts: {
      healthy: healthy.length,
      missing: missing.length,
      orphaned: orphaned.length,
      drifted: drifted.length,
      untracked: untracked.length,
      dbNative: dbNativeSet.size,
      foreignExcluded,
      unattributedOrphans: unattributedOrphans.length,
    },
    missing,
    orphaned,
    drifted,
    untracked,
    unattributedOrphans,
    dbNative: [...dbNativeSet],
    scope: {
      project: scope.project,
      detected: scope.detected,
      scoped: callerVariants !== null,
      mutationAllowed: scope.mutationAllowed,
    },
    mismatches,
    recommendation,
    ...(fixedOrphans > 0 ? { fixedOrphans } : {}),
  };
}
