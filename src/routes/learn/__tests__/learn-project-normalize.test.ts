/**
 * POST /api/learn (createLearning) — BL-223 write-path project-tag normalization.
 * The HTTP learn route used to store `body.project?.toLowerCase()` verbatim, so a variant tag
 * (bare slug / owner-repo) persisted and fragmented the project. It now mirrors the MCP
 * oracle_learn derivation: normalizeProject -> extractProjectFromSource -> detectProject(memoryOwnerRoot).
 *
 * Hermetic: ORACLE_REPO_ROOT / ORACLE_DATA_DIR are tmp dirs set BEFORE the dynamic import so
 * config.ts captures them (same pattern as learn-atomic-owner-root.test.ts).
 */
import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP_REPO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-learn-projnorm-repo-'));
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-learn-projnorm-data-'));
const ORIGINAL = { repo: process.env.ORACLE_REPO_ROOT, data: process.env.ORACLE_DATA_DIR, db: process.env.ORACLE_DB_PATH };
process.env.ORACLE_REPO_ROOT = TMP_REPO_ROOT;
process.env.ORACLE_DATA_DIR = TMP_DATA_DIR;

const { resetDefaultDatabaseForTests } = await import('../../../db/index.ts');
resetDefaultDatabaseForTests(path.join(TMP_DATA_DIR, 'oracle.db'));
const { sqlite } = await import('../../../db/index.ts');
const { createLearning } = await import('../crud.ts');

const projectOf = (id: string) =>
  (sqlite.query('SELECT project AS p FROM oracle_documents WHERE id = ?').get(id) as { p: string | null } | undefined)?.p ?? null;

afterAll(() => {
  process.env.ORACLE_REPO_ROOT = ORIGINAL.repo;
  process.env.ORACLE_DATA_DIR = ORIGINAL.data;
  process.env.ORACLE_DB_PATH = ORIGINAL.db;
  for (const dir of [TMP_REPO_ROOT, TMP_DATA_DIR]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('createLearning — project tag is host-qualified (BL-223)', () => {
  it('passes a canonical tag through, lowercased', () => {
    const r = createLearning({ pattern: 'canonical project stays canonical', project: 'github.com/TTT3P/orchestrator-vnext' });
    expect(r.status).toBe(200);
    expect(projectOf((r.body as { id: string }).id)).toBe('github.com/ttt3p/orchestrator-vnext');
  });

  it('host-qualifies a bare owner/repo instead of storing the variant', () => {
    const r = createLearning({ pattern: 'owner-repo gets host-qualified', project: 'ttt3p/orchestrator-vnext' });
    expect(r.status).toBe(200);
    expect(projectOf((r.body as { id: string }).id)).toBe('github.com/ttt3p/orchestrator-vnext');
  });

  it('does NOT persist a bare slug with no derivable root (null, not a variant)', () => {
    const r = createLearning({ pattern: 'bare slug must not persist as a variant', project: 'orchestrator-vnext', source: 'plain text no project' });
    expect(r.status).toBe(200);
    expect(projectOf((r.body as { id: string }).id)).toBeNull();
  });

  it('falls back to extractProjectFromSource when project is absent', () => {
    const r = createLearning({ pattern: 'derive project from source line', source: 'learned from github.com/ttt3p/oracle-maint-oracle during review' });
    expect(r.status).toBe(200);
    expect(projectOf((r.body as { id: string }).id)).toBe('github.com/ttt3p/oracle-maint-oracle');
  });
});
