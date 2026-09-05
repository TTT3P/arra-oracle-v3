/**
 * POST /api/learn (createLearning) — audit 2026-09-05:
 *  1. file + rows are atomic: a failing row write leaves no orphan file;
 *  2. a proxied seat's `memoryOwnerRoot` puts the file in the caller's memory
 *     tree, not the server root (which resolves to the data dir on the owner core);
 *  3. an invalid root fails closed (400) and writes nothing.
 *
 * Hermetic: ORACLE_REPO_ROOT / ORACLE_DATA_DIR are tmp dirs set BEFORE the dynamic
 * import so config.ts captures them (same pattern as learn-slug-collision.test.ts).
 */
import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP_REPO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-learn-atomic-repo-'));
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-learn-atomic-data-'));
const OWNER_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-learn-atomic-owner-'));
fs.mkdirSync(path.join(OWNER_ROOT, 'ψ'), { recursive: true });
const ORIGINAL = { repo: process.env.ORACLE_REPO_ROOT, data: process.env.ORACLE_DATA_DIR, db: process.env.ORACLE_DB_PATH };
process.env.ORACLE_REPO_ROOT = TMP_REPO_ROOT;
process.env.ORACLE_DATA_DIR = TMP_DATA_DIR;

const { resetDefaultDatabaseForTests } = await import('../../../db/index.ts');
resetDefaultDatabaseForTests(path.join(TMP_DATA_DIR, 'oracle.db'));
const { sqlite } = await import('../../../db/index.ts');
const { createLearning } = await import('../crud.ts');

const learningsDir = (root: string) => path.join(root, 'ψ', 'memory', 'learnings');
const files = (root: string) => (fs.existsSync(learningsDir(root)) ? fs.readdirSync(learningsDir(root)) : []);
const rowCount = (id: string) => (sqlite.query('SELECT COUNT(*) AS c FROM oracle_documents WHERE id = ?').get(id) as { c: number }).c;
const ftsCount = (id: string) => (sqlite.query('SELECT COUNT(*) AS c FROM oracle_fts WHERE id = ?').get(id) as { c: number }).c;

afterAll(() => {
  process.env.ORACLE_REPO_ROOT = ORIGINAL.repo;
  process.env.ORACLE_DATA_DIR = ORIGINAL.data;
  process.env.ORACLE_DB_PATH = ORIGINAL.db;
  for (const dir of [TMP_REPO_ROOT, TMP_DATA_DIR, OWNER_ROOT]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('createLearning — atomic file + rows', () => {
  it('success writes the file under the server root and the rows together', () => {
    const res = createLearning({ pattern: 'atomic success learning body', source: 'test' });
    expect(res.status).toBe(200);
    const body = res.body as { file: string; id: string };
    expect(fs.existsSync(path.join(TMP_REPO_ROOT, body.file))).toBe(true);
    expect(rowCount(body.id)).toBe(1);
    expect(ftsCount(body.id)).toBe(1);
  });

  it('a failing row write rolls back and removes the file it just wrote (no orphan file)', () => {
    sqlite.exec("CREATE TRIGGER learn_boom BEFORE INSERT ON oracle_documents WHEN NEW.id = 'learning_boom' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    try {
      const before = files(TMP_REPO_ROOT);
      expect(() => createLearning({ pattern: 'boom body must not leave a file', id: 'learning_boom' })).toThrow(/boom/);
      expect(files(TMP_REPO_ROOT)).toEqual(before);
      expect(fs.existsSync(path.join(learningsDir(TMP_REPO_ROOT), 'learning_boom.md'))).toBe(false);
      expect(rowCount('learning_boom')).toBe(0);
      expect(ftsCount('learning_boom')).toBe(0);
    } finally {
      sqlite.exec('DROP TRIGGER learn_boom');
    }
  });
});

describe('createLearning — memoryOwnerRoot', () => {
  it('writes the file under the caller root, not the server root; row source_file stays relative', () => {
    const before = files(TMP_REPO_ROOT);
    const res = createLearning({ pattern: 'owner root learning lands in the seat tree', memoryOwnerRoot: OWNER_ROOT });
    expect(res.status).toBe(200);
    const body = res.body as { file: string; id: string; memoryOwnerRoot?: string };
    expect(body.file).toMatch(/^ψ\/memory\/learnings\//);
    expect(fs.existsSync(path.join(OWNER_ROOT, body.file))).toBe(true);
    expect(fs.existsSync(path.join(TMP_REPO_ROOT, body.file))).toBe(false);
    expect(files(TMP_REPO_ROOT)).toEqual(before);
    expect(body.memoryOwnerRoot).toBe(fs.realpathSync(OWNER_ROOT));
    expect((sqlite.query('SELECT source_file FROM oracle_documents WHERE id = ?').get(body.id) as { source_file: string }).source_file).toBe(body.file);
  });

  it('refuses an invalid root (missing, no ψ, relative, the data dir) with 400 and writes nothing', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-learn-atomic-bare-'));
    fs.mkdirSync(path.join(TMP_DATA_DIR, 'ψ'), { recursive: true });
    const before = { repo: files(TMP_REPO_ROOT), owner: files(OWNER_ROOT), data: files(TMP_DATA_DIR) };
    try {
      for (const root of [path.join(os.tmpdir(), 'does-not-exist-arra'), bare, 'relative/root', TMP_DATA_DIR]) {
        const res = createLearning({ pattern: `refused root ${root}`, memoryOwnerRoot: root });
        expect(res.status).toBe(400);
        expect((res.body as { error: string }).error).toBe('Invalid memoryOwnerRoot');
      }
      expect(files(TMP_REPO_ROOT)).toEqual(before.repo);
      expect(files(OWNER_ROOT)).toEqual(before.owner);
      expect(files(TMP_DATA_DIR)).toEqual(before.data);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
