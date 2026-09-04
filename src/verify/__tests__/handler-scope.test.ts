import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const dataDir = path.join(tmpdir(), `arra-verify-scope-data-${stamp}`);
// repoRoot embeds a host/owner/repo segment so detectProject resolves the caller
const repoRoot = path.join(tmpdir(), `arra-verify-scope-${stamp}`, 'ghq', 'github.com', 'testowner', 'testrepo');
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
  foreign: rel('foreign'),
  superseded: rel('superseded'),
  dbNative: rel('db-native'),
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
seed(`foreign-${stamp}`, paths.foreign, { project: 'github.com/other/project', createdBy: 'indexer' });
seed(`superseded-${stamp}`, paths.superseded, {
  project: CALLER, createdBy: 'indexer',
  supersededBy: 'newer-doc', supersededAt: now, supersededReason: 'test',
});
seed(`db-native-${stamp}`, paths.dbNative, { project: CALLER, createdBy: 'oracle_learn' });
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
  rmSync(path.dirname(path.dirname(path.dirname(path.dirname(repoRoot)))), { recursive: true, force: true });
});

describe('verifyKnowledgeBase caller-project scoping (P1)', () => {
  test('cross-project docs are excluded, never counted orphaned', () => {
    const result = verifyKnowledgeBase({ repoRoot });

    expect(result.scope).toEqual({ project: CALLER, scoped: true });
    expect(result.orphaned).not.toContain(paths.foreign);
    expect(result.counts.foreignExcluded).toBe(1);
    // owned orphans (both stored project forms) are still detected
    expect(result.orphaned.sort()).toEqual([paths.ownedOrphan, paths.shortFormOrphan].sort());
    expect(result.counts.healthy).toBe(1);
  });

  test('superseded rows are excluded from every bucket', () => {
    const result = verifyKnowledgeBase({ repoRoot });
    const everywhere = [...result.orphaned, ...result.unattributedOrphans, ...result.dbNative, ...result.missing];
    expect(everywhere).not.toContain(paths.superseded);
  });

  test('DB-native rows are tagged, not file-orphaned', () => {
    const result = verifyKnowledgeBase({ repoRoot });
    expect(result.orphaned).not.toContain(paths.dbNative);
    expect(result.dbNative).toContain(paths.dbNative);
    expect(result.counts.dbNative).toBe(1);
  });

  test('project=NULL orphans are reported separately and never auto-flagged', () => {
    const result = verifyKnowledgeBase({ repoRoot, check: false });
    expect(result.unattributedOrphans).toEqual([paths.unattributed]);
    expect(result.orphaned).not.toContain(paths.unattributed);

    const rows = db.select({ id: oracleDocuments.id, supersededBy: oracleDocuments.supersededBy })
      .from(oracleDocuments).all();
    const flagged = Object.fromEntries(rows.map((row) => [row.id, row.supersededBy]));
    expect(flagged[`owned-orphan-${stamp}`]).toBe('_verified_orphan');
    expect(flagged[`shortform-orphan-${stamp}`]).toBe('_verified_orphan');
    expect(flagged[`unattributed-${stamp}`]).toBeNull();
    expect(flagged[`foreign-${stamp}`]).toBeNull();
    expect(flagged[`db-native-${stamp}`]).toBeNull();
  });

  test('explicit project override wins over path detection', () => {
    const result = verifyKnowledgeBase({ repoRoot, project: 'github.com/other/project' });
    expect(result.scope.project).toBe('github.com/other/project');
    // caller-owned rows are now foreign to the override
    expect(result.counts.foreignExcluded).toBeGreaterThanOrEqual(1);
  });
});
