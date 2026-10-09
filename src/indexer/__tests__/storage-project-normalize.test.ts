/**
 * storeDocuments — BL-223 write-path project-tag normalization.
 * storage.ts used to store `(doc.project || project)?.toLowerCase()`, so a raw frontmatter
 * project tag (bare slug / owner-repo) persisted and fragmented the project. It now host-qualifies
 * to the canonical github.com/owner/repo form, preferring a host-qualified per-doc project, else
 * the (already detectProject-normalized) repo project. insertOnly/recovery writes are EXEMPT.
 *
 * Hermetic db (same reset pattern as the learn route tests).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { OracleDocument } from '../../types.ts';

const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-storage-projnorm-data-'));
const ORIGINAL = { data: process.env.ORACLE_DATA_DIR, db: process.env.ORACLE_DB_PATH };
process.env.ORACLE_DATA_DIR = TMP_DATA_DIR;

const { resetDefaultDatabaseForTests } = await import('../../db/index.ts');
resetDefaultDatabaseForTests(path.join(TMP_DATA_DIR, 'oracle.db'));
const { db, sqlite } = await import('../../db/index.ts');
const { storeDocuments } = await import('../storage.ts');

const now = Date.now();
const doc = (id: string, project: string | null | undefined): OracleDocument => ({
  id,
  type: 'learning',
  source_file: `ψ/memory/learnings/${id}.md`,
  content: `body for ${id}`,
  concepts: ['bl223'],
  created_at: now,
  updated_at: now,
  project,
});
const projectOf = (id: string) =>
  (sqlite.query('SELECT project AS p FROM oracle_documents WHERE id = ?').get(id) as { p: string | null } | undefined)?.p ?? null;

afterAll(() => {
  process.env.ORACLE_DATA_DIR = ORIGINAL.data;
  process.env.ORACLE_DB_PATH = ORIGINAL.db;
  fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
});

describe('storeDocuments — project tag is host-qualified (BL-223)', () => {
  it('a bare frontmatter slug does not override the canonical repo project', async () => {
    await storeDocuments(sqlite, db, null, 'github.com/ttt3p/orchestrator-vnext', [doc('bl223-bare', 'orchestrator-vnext')]);
    expect(projectOf('bl223-bare')).toBe('github.com/ttt3p/orchestrator-vnext');
  });

  it('host-qualifies a per-doc owner/repo when the repo project is null', async () => {
    await storeDocuments(sqlite, db, null, null, [doc('bl223-ownerrepo', 'ttt3p/oracle-maint-oracle')]);
    expect(projectOf('bl223-ownerrepo')).toBe('github.com/ttt3p/oracle-maint-oracle');
  });

  it('lowercases an already-canonical per-doc tag', async () => {
    await storeDocuments(sqlite, db, null, null, [doc('bl223-canon', 'github.com/TTT3P/Oracle-Maint-Oracle')]);
    expect(projectOf('bl223-canon')).toBe('github.com/ttt3p/oracle-maint-oracle');
  });

  it('EXEMPTS insertOnly/recovery writes — preserves the raw stored identity', async () => {
    await storeDocuments(sqlite, db, null, 'github.com/ttt3p/orchestrator-vnext', [doc('bl223-recovery', 'legacy-variant')], { insertOnly: true });
    expect(projectOf('bl223-recovery')).toBe('legacy-variant');
  });
});
