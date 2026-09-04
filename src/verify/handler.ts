/**
 * Oracle Verify Handler
 *
 * Compares ψ/ files on disk vs DB index.
 * Detects: healthy, missing, orphaned, drifted, untracked files.
 *
 * Philosophy: "Nothing is Deleted" — orphans are flagged, not removed.
 *
 * P1 scoping (plan 2026-09-04): the shared DB holds many projects' documents.
 * Rows owned by another project are excluded; rows with project=NULL stay
 * ambient but their orphans are reported separately and never auto-flagged
 * when the caller is scoped; superseded rows and DB-native rows never count.
 */

import path from 'path';
import { and, eq, isNull } from 'drizzle-orm';
import { db, oracleDocuments } from '../db/index.ts';
import { currentTenantId } from '../middleware/tenant.ts';
import { walkMarkdownFiles } from './files.ts';
import { normalizeSourceFile } from './paths.ts';
import { classifyRowScope, isDbNativeCreator, projectVariants, resolveCallerProject } from './scope.ts';
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
  const callerProject = resolveCallerProject(repoRoot, opts.project);
  const callerVariants = callerProject ? projectVariants(callerProject) : null;

  // 1. Walk indexed directories on disk
  const indexedDirs = [
    'ψ/memory/resonance',
    'ψ/memory/learnings',
    'ψ/memory/retrospectives',
    'ψ/learn',
  ];
  const diskFiles = new Map<string, number>(); // relativePath -> mtimeMs

  for (const dir of indexedDirs) {
    const fullDir = path.join(repoRoot, dir);
    const files = walkMarkdownFiles(fullDir, repoRoot);
    for (const f of files) {
      diskFiles.set(f.relativePath, f.mtimeMs);
    }
  }

  // 2. Query DB. Superseded rows are already retired — never re-classify them.
  const normalizedType = type?.trim();
  const typeFilter = normalizedType && normalizedType !== 'all' ? normalizedType : undefined;
  const conditions = [isNull(oracleDocuments.supersededBy)];
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

  // Build map: sourceFile -> { indexedAt, ids[], owned }
  // Multiple DB entries can point to the same source file (chunked docs)
  const dbFileMap = new Map<string, { indexedAt: number; ids: string[]; owned: boolean }>();
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
    const owned = rowScope === 'owned';
    const existing = dbFileMap.get(sourceFile);
    if (existing) {
      existing.ids.push(row.id);
      existing.owned ||= owned;
      // Use the latest indexedAt
      if (row.indexedAt > existing.indexedAt) {
        existing.indexedAt = row.indexedAt;
      }
    } else {
      dbFileMap.set(sourceFile, { indexedAt: row.indexedAt, ids: [row.id], owned });
    }
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
    } else {
      // File exists in both — check drift
      if (mtimeMs > dbEntry.indexedAt) {
        drifted.push(relPath);
      } else {
        healthy.push(relPath);
      }
    }
  }

  // Check each DB entry for orphans (in DB, not on disk). With a scoped
  // caller, only project-proven rows may be called orphaned; project=NULL
  // rows are reported separately (Class E) and never auto-flagged.
  for (const [sourceFile, entry] of dbFileMap) {
    if (diskFiles.has(sourceFile)) continue;
    if (callerVariants && !entry.owned) unattributedOrphans.push(sourceFile);
    else orphaned.push(sourceFile);
  }

  // 4. Count untracked files outside indexed dirs.
  const untrackedDirs = ['ψ/inbox'];
  const untracked: string[] = [];
  if (!tenantId) {
    for (const dir of untrackedDirs) {
      const fullDir = path.join(repoRoot, dir);
      const files = walkMarkdownFiles(fullDir, repoRoot);
      for (const f of files) {
        untracked.push(f.relativePath);
      }
    }
  }

  // 5. Auto-fix orphans if check=false — scoped 'orphaned' bucket only
  let fixedOrphans = 0;
  if (!check && orphaned.length > 0) {
    const now = Date.now();
    for (const sourceFile of orphaned) {
      const entry = dbFileMap.get(sourceFile);
      if (entry) {
        for (const id of entry.ids) {
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
          fixedOrphans++;
        }
      }
    }
  }

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
  if (unattributedOrphans.length > 0) {
    recommendation += ` ${unattributedOrphans.length} unattributed (project=NULL) rows lack a file under this root — held, not flagged.`;
  }
  if (fixedOrphans > 0) {
    recommendation += `. Flagged ${fixedOrphans} orphaned entries as '_verified_orphan'.`;
  }

  const dbDetails = (sourceFile: string) => dbFileMap.get(sourceFile) ?? {};
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
    scope: { project: callerProject, scoped: callerVariants !== null },
    mismatches,
    recommendation,
    ...(fixedOrphans > 0 ? { fixedOrphans } : {}),
  };
}
