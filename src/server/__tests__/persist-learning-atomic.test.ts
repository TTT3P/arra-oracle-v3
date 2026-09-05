/**
 * persistLearningDoc (huginn capture / trace distill / legacy handleLearn) and
 * persistSessionSummary — audit 2026-09-05: file + rows are one unit. A failing
 * row write rolls back and removes the file it just wrote. Hermetic env before
 * the dynamic import (same pattern as learn-slug-collision.test.ts).
 */
import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP_REPO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-persist-atomic-repo-'));
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-persist-atomic-data-'));
const ORIGINAL = { repo: process.env.ORACLE_REPO_ROOT, data: process.env.ORACLE_DATA_DIR, db: process.env.ORACLE_DB_PATH };
process.env.ORACLE_REPO_ROOT = TMP_REPO_ROOT;
process.env.ORACLE_DATA_DIR = TMP_DATA_DIR;

const { resetDefaultDatabaseForTests } = await import('../../db/index.ts');
resetDefaultDatabaseForTests(path.join(TMP_DATA_DIR, 'oracle.db'));
const { sqlite } = await import('../../db/index.ts');
const { handleLearn } = await import('../handlers.ts');
const { persistSessionSummary } = await import('../../routes/sessions/store.ts');

const list = (rel: string) => { const d = path.join(TMP_REPO_ROOT, rel); return fs.existsSync(d) ? fs.readdirSync(d) : []; };
const rows = (idLike: string) => (sqlite.query('SELECT COUNT(*) AS c FROM oracle_documents WHERE id LIKE ?').get(idLike) as { c: number }).c;

afterAll(() => {
  process.env.ORACLE_REPO_ROOT = ORIGINAL.repo;
  process.env.ORACLE_DATA_DIR = ORIGINAL.data;
  process.env.ORACLE_DB_PATH = ORIGINAL.db;
  fs.rmSync(TMP_REPO_ROOT, { recursive: true, force: true });
  fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
});

describe('persistLearningDoc / persistSessionSummary — atomic file + rows', () => {
  it('handleLearn success: file and row both exist', () => {
    const res = handleLearn('fine handler learning body');
    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(TMP_REPO_ROOT, res.file))).toBe(true);
    expect(rows(res.id)).toBe(1);
  });

  it('a failing row write rolls back and removes the learning file', () => {
    sqlite.exec("CREATE TRIGGER persist_boom BEFORE INSERT ON oracle_documents WHEN NEW.id LIKE '%boom%' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    try {
      const before = list('ψ/memory/learnings');
      expect(() => handleLearn('boom handler learning must not leave a file')).toThrow(/boom/);
      expect(list('ψ/memory/learnings')).toEqual(before);
      expect(rows('%boom%')).toBe(0);

      const summariesBefore = list('ψ/memory/session-summaries');
      expect(() => persistSessionSummary('boom-session', 'summary body that fails at the row', 'oracle')).toThrow(/boom/);
      expect(list('ψ/memory/session-summaries')).toEqual(summariesBefore);
      expect(rows('%boom-session%')).toBe(0);
    } finally {
      sqlite.exec('DROP TRIGGER persist_boom');
    }
  });

  it('persistSessionSummary success: file and row both exist', () => {
    const res = persistSessionSummary('fine-session', 'summary body that succeeds', 'oracle');
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(TMP_REPO_ROOT, res.source_file))).toBe(true);
    expect(rows(res.learning_id)).toBe(1);
  });
});
