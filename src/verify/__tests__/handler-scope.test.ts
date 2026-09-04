import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const dataDir = path.join(tmpdir(), `arra-verify-scope-data-${stamp}`);
// repoRoot embeds a host/owner/repo segment so detectProject resolves the caller
const treeRoot = path.join(tmpdir(), `arra-verify-scope-${stamp}`);
const repoRoot = path.join(treeRoot, 'ghq', 'github.com', 'testowner', 'testrepo');
const CALLER = 'github.com/testowner/testrepo';
const originalDataDir = process.env.ORACLE_DATA_DIR;
const originalDbPath = process.env.ORACLE_DB_PATH;
mkdirSync(dataDir, { recursive: true });
mkdirSync(repoRoot, { recursive: true });
process.env.ORACLE_DATA_DIR = dataDir;
process.env.ORACLE_DB_PATH = path.join(dataDir, 'oracle.db');

const dbModule = await import('../../db/index.ts');
dbModule.resetDefaultDatabaseForTests(process.env.ORACLE_DB_PATH);
const { db, oracleDocuments } = dbModule;
const { verifyKnowledgeBase } = await import('../handler.ts');

const now = Date.now();
const rel = (name: string) => `ψ/memory/learnings/${name}-${stamp}.md`;
const paths = {
  healthy: rel('healthy'),
  ownedOrphan: rel('owned-orphan'),
  shortFormOrphan: rel('shortform-orphan'),
  sharedPath: rel('shared-owned-plus-null'),
  foreign: rel('foreign'),
  superseded: rel('superseded'),
  softDeleted: rel('soft-deleted'),
  dbNativeLearn: rel('db-native-learn'),
  dbNativeSeed: rel('db-native-seed'),
  dbNativeObsidian: rel('db-native-obsidian'),
  unattributed: rel('unattributed'),
};

function seed(id: string, sourceFile: string, extra: Record<string, unknown> = {}) {
  db.insert(oracleDocuments).values({
    id, type: 'learning', concepts: '[]', sourceFile,
    createdAt: now, updatedAt: now, indexedAt: now + 60_000,
    ...extra,
  }).run();
}

const fullHealthy = path.join(repoRoot, paths.healthy);
mkdirSync(path.dirname(fullHealthy), { recursive: true });
writeFileSync(fullHealthy, '# healthy\n');

seed(`healthy-${stamp}`, paths.healthy, { project: CALLER, createdBy: 'indexer' });
seed(`owned-orphan-${stamp}`, paths.ownedOrphan, { project: CALLER, createdBy: 'retro_indexer' });
seed(`shortform-orphan-${stamp}`, paths.shortFormOrphan, { project: 'testowner/testrepo', createdBy: 'indexer' });
// Riddler #3: one source_file shared by an owned row AND a project=NULL row
seed(`shared-owned-${stamp}`, paths.sharedPath, { project: CALLER, createdBy: 'indexer' });
seed(`shared-null-${stamp}`, paths.sharedPath, { createdBy: 'indexer' });
seed(`foreign-${stamp}`, paths.foreign, { project: 'github.com/other/project', createdBy: 'indexer' });
seed(`superseded-${stamp}`, paths.superseded, {
  project: CALLER, createdBy: 'indexer',
  supersededBy: 'newer-doc', supersededAt: now, supersededReason: 'test',
});
// Riddler #4: learn CRUD soft-delete sets superseded_at WITHOUT superseded_by
seed(`soft-deleted-${stamp}`, paths.softDeleted, {
  project: CALLER, createdBy: 'indexer', supersededAt: now,
});
seed(`db-native-learn-${stamp}`, paths.dbNativeLearn, { project: CALLER, createdBy: 'oracle_learn' });
seed(`db-native-seed-${stamp}`, paths.dbNativeSeed, { project: CALLER, createdBy: 'seed' });
seed(`db-native-obsidian-${stamp}`, paths.dbNativeObsidian, { project: CALLER, createdBy: 'import-obsidian' });
seed(`unattributed-${stamp}`, paths.unattributed, { createdBy: 'indexer' }); // project NULL

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterAll(() => {
  dbModule.closeDb();
  restore('ORACLE_DATA_DIR', originalDataDir);
  restore('ORACLE_DB_PATH', originalDbPath);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(treeRoot, { recursive: true, force: true });
});

function flaggedById(): Record<string, string | null> {
  const rows = db.select({ id: oracleDocuments.id, supersededBy: oracleDocuments.supersededBy })
    .from(oracleDocuments).all();
  return Object.fromEntries(rows.map((row) => [row.id, row.supersededBy]));
}

describe('verifyKnowledgeBase caller-project scoping (P1, round 2)', () => {
  test('cross-project docs are excluded, never counted orphaned', () => {
    const result = verifyKnowledgeBase({ repoRoot });

    expect(result.scope).toEqual({
      project: CALLER, detected: CALLER, scoped: true,
      mutationAllowed: false, // round 3: mutation additionally needs an EXPLICIT project
      mutationRefusedReason: expect.stringContaining('omitted'),
    });
    expect(result.orphaned).not.toContain(paths.foreign);
    expect(result.counts.foreignExcluded).toBe(1);
    expect(result.orphaned.sort()).toEqual([paths.ownedOrphan, paths.shortFormOrphan, paths.sharedPath].sort());
    expect(result.counts.healthy).toBe(1);
  });

  test('rows retired by EITHER superseded field are excluded everywhere', () => {
    const result = verifyKnowledgeBase({ repoRoot });
    const everywhere = [...result.orphaned, ...result.unattributedOrphans, ...result.dbNative, ...result.missing];
    expect(everywhere).not.toContain(paths.superseded);
    expect(everywhere).not.toContain(paths.softDeleted); // superseded_at-only soft delete
  });

  test('DB-native rows (learn/seed/import-obsidian) are tagged, not file-orphaned', () => {
    const result = verifyKnowledgeBase({ repoRoot });
    for (const p of [paths.dbNativeLearn, paths.dbNativeSeed, paths.dbNativeObsidian]) {
      expect(result.orphaned).not.toContain(p);
      expect(result.dbNative).toContain(p);
    }
    expect(result.counts.dbNative).toBe(3);
  });

  test('invalid explicit project override is refused outright', () => {
    expect(() => verifyKnowledgeBase({ repoRoot, project: '///not a project///' }))
      .toThrow('fail-closed');
  });

  test('valid override that mismatches the repoRoot: read allowed with warning, mutation refused', () => {
    const readResult = verifyKnowledgeBase({ repoRoot, project: 'github.com/other/project' });
    expect(readResult.scope.project).toBe('github.com/other/project');
    expect(readResult.scope.detected).toBe(CALLER);
    expect(readResult.scope.mutationAllowed).toBe(false);
    expect(readResult.recommendation).toContain('WARNING');
    expect(readResult.counts.foreignExcluded).toBeGreaterThanOrEqual(1);

    expect(() => verifyKnowledgeBase({ repoRoot, project: 'github.com/other/project', check: false }))
      .toThrow('fail-closed');
    expect(flaggedById()[`foreign-${stamp}`]).toBeNull();
  });

  test('OMITTED project + check:false is refused and mutates nothing (round 3)', () => {
    expect(() => verifyKnowledgeBase({ repoRoot, check: false })).toThrow('fail-closed');
    for (const value of Object.values(flaggedById())) expect(value).not.toBe('_verified_orphan');
  });

  test('check:false with explicit matching project flags ONLY project-proven ids — per-id NULL guard', () => {
    const result = verifyKnowledgeBase({ repoRoot, project: CALLER, check: false });
    expect(result.unattributedOrphans).toEqual([paths.unattributed]);
    expect(result.orphaned).not.toContain(paths.unattributed);

    const flagged = flaggedById();
    expect(flagged[`owned-orphan-${stamp}`]).toBe('_verified_orphan');
    expect(flagged[`shortform-orphan-${stamp}`]).toBe('_verified_orphan');
    expect(flagged[`shared-owned-${stamp}`]).toBe('_verified_orphan');
    // the NULL-project row sharing the same source_file must NOT be flagged
    expect(flagged[`shared-null-${stamp}`]).toBeNull();
    expect(flagged[`unattributed-${stamp}`]).toBeNull();
    expect(flagged[`foreign-${stamp}`]).toBeNull();
    expect(flagged[`db-native-learn-${stamp}`]).toBeNull();
    expect(result.fixedOrphans).toBe(3);
  });
});
