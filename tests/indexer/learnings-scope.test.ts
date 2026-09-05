/**
 * `scope=learnings` containment: `OracleIndexer.indexLearnings()` reads and stores
 * ψ/memory/learnings only — never a retrospective (RUNBOOK §4 HOLD), never a prune,
 * never another source type — and the root validation fails closed.
 *
 * The fixture deliberately contains a retrospective and a resonance file next to the
 * learnings, plus pre-existing DB rows with no file on disk. The negative control runs
 * the full indexer (append mode) on the same fixture and shows the retro rows appear
 * there, so "0 retro rows" after the learnings pass is a property of the scope, not of
 * the fixture.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IndexerConfig } from '../../src/types.ts';
import { OracleIndexer } from '../../src/indexer/index.ts';
import { parseIndexerCliArgs } from '../../src/indexer/cli.ts';
import { validateLearningsRoot } from '../../src/indexer/learnings-pass.ts';

const originalEnv = { dataDir: process.env.ORACLE_DATA_DIR, dbPath: process.env.ORACLE_DB_PATH, owner: process.env.ORACLE_MEMORY_OWNER_ROOT };
let cleanup: string[] = [];

afterEach(() => {
  process.env.ORACLE_DATA_DIR = originalEnv.dataDir;
  process.env.ORACLE_DB_PATH = originalEnv.dbPath;
  if (originalEnv.owner === undefined) delete process.env.ORACLE_MEMORY_OWNER_ROOT; else process.env.ORACLE_MEMORY_OWNER_ROOT = originalEnv.owner;
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function harness(name: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `arra-learnings-${name}-`));
  cleanup.push(tmp);
  const dataDir = path.join(tmp, 'data');
  const repoRoot = path.join(tmp, 'repo');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.ORACLE_DATA_DIR = dataDir;
  process.env.ORACLE_DB_PATH = path.join(dataDir, 'oracle.db');
  const write = (rel: string, body: string) => {
    const full = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  };
  write('ψ/memory/learnings/2026-09-05_alpha.md', '# Alpha\n\nalpha learning body searchable');
  write('ψ/memory/learnings/2026-09-05_beta.md', '# Beta\n\nbeta learning body searchable');
  write('ψ/memory/retrospectives/2026-09/05/12.00_retro.md', '# Retro\n\n## What happened\n\nretro body must never be indexed by scope=learnings; this section is long enough for parseRetroFile to keep it.\n');
  write('ψ/memory/resonance/2026-09-05_res.md', '# Res\n\nresonance body');
  const config: IndexerConfig = {
    repoRoot, dbPath: process.env.ORACLE_DB_PATH!, chromaPath: '',
    sourcePaths: { resonance: 'ψ/memory/resonance', learnings: 'ψ/memory/learnings', retrospectives: 'ψ/memory/retrospectives', distillations: 'ψ/memory/distillations', learn: 'ψ/learn' },
  };
  return { tmp, dataDir, repoRoot, dbPath: config.dbPath, config };
}

function seedPreexisting(dbPath: string): void {
  // Open through the indexer once so migrations exist, then insert rows with no file on disk.
  const db = new Database(dbPath);
  const now = Date.now();
  const ins = db.query(`insert into oracle_documents (id, type, source_file, concepts, created_at, updated_at, indexed_at, created_by)
    values (?, ?, ?, '[]', ?, ?, ?, 'indexer')`);
  ins.run('pre-learning', 'learning', 'ψ/memory/learnings/2026-01-01_gone.md', now, now, now);
  ins.run('pre-retro', 'retrospective', 'ψ/memory/retrospectives/2026-01/01/gone.md', now, now, now);
  db.query('insert into oracle_fts (id, content, concepts) values (?, ?, ?)').run('pre-learning', 'gone learning', '');
  db.query('insert into oracle_fts (id, content, concepts) values (?, ?, ?)').run('pre-retro', 'gone retro', '');
  db.close();
}

function rows(dbPath: string, sql: string): any[] {
  const db = new Database(dbPath, { readonly: true });
  try { return db.query(sql).all(); } finally { db.close(); }
}
const count = (dbPath: string, where: string) => (rows(dbPath, `SELECT COUNT(*) AS c FROM oracle_documents WHERE ${where}`)[0] as { c: number }).c;

describe('scope=learnings containment', () => {
  test('stores learnings only; retro/resonance never enter; pre-existing rows untouched; rerun idempotent', async () => {
    const h = harness('contain');
    let indexer = new OracleIndexer(h.config);
    await indexer.close();
    seedPreexisting(h.dbPath);

    indexer = new OracleIndexer(h.config);
    const first = await indexer.indexLearnings();
    await indexer.close();

    expect(first.ok).toBe(true);
    expect(first.scope).toBe('learnings');
    expect(first.dryRun).toBe(false);
    expect(first.files).toBe(2);
    expect(first.documents).toBeGreaterThanOrEqual(2);
    expect(count(h.dbPath, "source_file LIKE 'ψ/memory/learnings/2026-09-05_%' AND created_by = 'indexer'")).toBe(first.chunks);
    expect(count(h.dbPath, "source_file LIKE 'ψ/memory/retrospectives/2026-09/%'")).toBe(0); // parser type is 'retro'
    expect(count(h.dbPath, "source_file LIKE 'ψ/memory/resonance/%'")).toBe(0);
    // Pre-existing rows with no file on disk: still present, still active (no prune, no supersede outside these files).
    expect(rows(h.dbPath, "SELECT id, superseded_by FROM oracle_documents WHERE id IN ('pre-learning','pre-retro') ORDER BY id"))
      .toEqual([{ id: 'pre-learning', superseded_by: null }, { id: 'pre-retro', superseded_by: null }]);
    expect(rows(h.dbPath, "SELECT COUNT(*) AS c FROM oracle_fts WHERE id IN ('pre-learning','pre-retro')")[0].c).toBe(2);
    const status = rows(h.dbPath, 'SELECT is_indexing, progress_current, progress_total FROM indexing_status WHERE id = 1')[0];
    expect(status.is_indexing).toBe(0);
    expect(status.progress_total).toBe(first.chunks);

    indexer = new OracleIndexer(h.config);
    const second = await indexer.indexLearnings();
    await indexer.close();
    expect(second.chunks).toBe(first.chunks);
    expect(second.superseded).toBe(0);
    expect(count(h.dbPath, "source_file LIKE 'ψ/memory/learnings/%' AND superseded_by IS NULL")).toBe(first.chunks + 1);
  });

  test('dry run lists the candidate files and writes nothing', async () => {
    const h = harness('dry');
    let indexer = new OracleIndexer(h.config);
    await indexer.close();
    seedPreexisting(h.dbPath);
    const before = count(h.dbPath, '1=1');
    const statusBefore = rows(h.dbPath, 'SELECT is_indexing, progress_total FROM indexing_status WHERE id = 1')[0];

    indexer = new OracleIndexer(h.config);
    const result = await indexer.indexLearnings({ dryRun: true });
    await indexer.close();

    expect(result.dryRun).toBe(true);
    expect(result.files).toBe(2);
    expect(result.sourceFiles).toEqual(['ψ/memory/learnings/2026-09-05_alpha.md', 'ψ/memory/learnings/2026-09-05_beta.md']);
    expect(result.sourceFiles!.some((f) => f.includes('retrospectives'))).toBe(false);
    expect(count(h.dbPath, '1=1')).toBe(before);
    expect(rows(h.dbPath, 'SELECT is_indexing, progress_total FROM indexing_status WHERE id = 1')[0]).toEqual(statusBefore);
  });

  test('negative control: the full indexer on the same fixture does store the retrospective', async () => {
    const h = harness('nc');
    const indexer = new OracleIndexer(h.config);
    await indexer.index({ append: true });
    await indexer.close();
    expect(count(h.dbPath, "type = 'retro' AND source_file LIKE 'ψ/memory/retrospectives/2026-09/%'")).toBeGreaterThan(0);
    expect(count(h.dbPath, "source_file LIKE 'ψ/memory/resonance/%'")).toBeGreaterThan(0);
  });
});

describe('scope=learnings root validation (fail-closed)', () => {
  test('refuses empty, non-directory, learnings-less, data-dir and seam-violating roots; accepts a valid one', () => {
    const h = harness('validate');
    expect(() => validateLearningsRoot(undefined)).toThrow(/repoRoot is required/);
    expect(() => validateLearningsRoot('   ')).toThrow(/repoRoot is required/);
    expect(() => validateLearningsRoot(path.join(h.tmp, 'nope'))).toThrow(/not a directory/);
    const bare = path.join(h.tmp, 'bare'); fs.mkdirSync(bare);
    expect(() => validateLearningsRoot(bare)).toThrow(/does not exist/);
    fs.mkdirSync(path.join(h.dataDir, 'ψ', 'memory', 'learnings'), { recursive: true });
    expect(() => validateLearningsRoot(h.dataDir)).toThrow(/Oracle data dir/);
    process.env.ORACLE_MEMORY_OWNER_ROOT = path.join(h.tmp, 'other-owner');
    expect(() => validateLearningsRoot(h.repoRoot)).toThrow(/bound memory owner/);
    process.env.ORACLE_MEMORY_OWNER_ROOT = h.repoRoot;
    expect(validateLearningsRoot(h.repoRoot)).toBe(path.resolve(h.repoRoot));
    delete process.env.ORACLE_MEMORY_OWNER_ROOT;
    expect(validateLearningsRoot(`${h.repoRoot}/`)).toBe(path.resolve(h.repoRoot));
  });
});

describe('indexer CLI --scope', () => {
  test('defaults to all; learnings requires --repo-root; dry-run and confirm-delete rules', () => {
    expect(parseIndexerCliArgs([]).scope).toBe('all');
    const ok = parseIndexerCliArgs(['--scope', 'learnings', '--repo-root', '/x', '--dry-run']);
    expect(ok).toMatchObject({ scope: 'learnings', repoRoot: '/x', dryRun: true });
    expect(parseIndexerCliArgs(['--scope=learnings', '--repo-root=/y']).scope).toBe('learnings');
    expect(() => parseIndexerCliArgs(['--scope', 'learnings'])).toThrow(/requires --repo-root/);
    expect(() => parseIndexerCliArgs(['--dry-run'])).toThrow(/only supported with --scope learnings/);
    expect(() => parseIndexerCliArgs(['--scope', 'retros', '--repo-root', '/x'])).toThrow(/--scope must be/);
    expect(() => parseIndexerCliArgs(['--scope', 'learnings', '--repo-root', '/x', '--confirm-delete', '0'])).toThrow(/never prunes/);
  });
});
