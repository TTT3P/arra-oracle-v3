/**
 * MCP `oracle_learn` (embedded seat) — audit 2026-09-05: the markdown file and the
 * rows are one unit. A failing row write must roll back and remove the file it
 * just wrote; a succeeding write leaves file + row. Same sandboxing as
 * learn-memory-owner-seam.test.ts (env before the dynamic import); the vector
 * step is routed to the job queue (ORACLE_INDEXER_ENQUEUE=1) so no embedder runs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as schema from '../../db/schema.ts';
import type { ToolContext } from '../types.ts';

const SANDBOX_REPO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-learn-atomic-mcp-repo-'));
const SANDBOX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-learn-atomic-mcp-data-'));
const PRIOR = {
  repo: process.env.ORACLE_REPO_ROOT, data: process.env.ORACLE_DATA_DIR, vec: process.env.ORACLE_VECTOR_DB_PATH,
  owner: process.env.ORACLE_MEMORY_OWNER_ROOT, enqueue: process.env.ORACLE_INDEXER_ENQUEUE,
};
process.env.ORACLE_REPO_ROOT = SANDBOX_REPO_ROOT;
process.env.ORACLE_DATA_DIR = SANDBOX_DATA_DIR;
process.env.ORACLE_VECTOR_DB_PATH = path.join(SANDBOX_DATA_DIR, 'lancedb');
process.env.ORACLE_INDEXER_ENQUEUE = '1';
delete process.env.ORACLE_MEMORY_OWNER_ROOT;

let handleLearn: typeof import('../learn.ts')['handleLearn'];
beforeAll(async () => {
  ({ handleLearn } = await import('../learn.ts'));
  const { REPO_ROOT } = await import('../../config.ts');
  if (REPO_ROOT !== SANDBOX_REPO_ROOT) throw new Error(`REPO_ROOT isolation failed: ${REPO_ROOT}`);
});

const SCHEMA = `
CREATE TABLE oracle_documents (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, source_file TEXT NOT NULL, concepts TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL, valid_time INTEGER,
  superseded_by TEXT, superseded_at INTEGER, superseded_reason TEXT, origin TEXT, project TEXT,
  tenant_id TEXT NOT NULL DEFAULT 'default', created_by TEXT, usage_count INTEGER NOT NULL DEFAULT 0, last_accessed_at INTEGER
);
CREATE VIRTUAL TABLE oracle_fts USING fts5(id UNINDEXED, content, concepts, tokenize='porter unicode61');
CREATE TABLE indexing_jobs (
  id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, model_key TEXT NOT NULL, collection TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000), claimed_at INTEGER, finished_at INTEGER, error TEXT
);
CREATE TABLE learn_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'default',
  pattern_preview TEXT, source TEXT, concepts TEXT, created_at INTEGER NOT NULL, project TEXT
);
`;

let sqlite: Database;
function makeCtx(): ToolContext {
  return {
    db: drizzle(sqlite, { schema }), sqlite, repoRoot: SANDBOX_REPO_ROOT,
    vectorStore: null as unknown as ToolContext['vectorStore'], vectorStatus: 'disabled', vectorReason: 'test',
  } as unknown as ToolContext;
}
beforeEach(() => { sqlite = new Database(':memory:'); sqlite.exec(SCHEMA); });
afterEach(() => { try { sqlite.close(); } catch {} });
afterAll(() => {
  process.env.ORACLE_REPO_ROOT = PRIOR.repo; process.env.ORACLE_DATA_DIR = PRIOR.data; process.env.ORACLE_VECTOR_DB_PATH = PRIOR.vec;
  if (PRIOR.owner === undefined) delete process.env.ORACLE_MEMORY_OWNER_ROOT; else process.env.ORACLE_MEMORY_OWNER_ROOT = PRIOR.owner;
  if (PRIOR.enqueue === undefined) delete process.env.ORACLE_INDEXER_ENQUEUE; else process.env.ORACLE_INDEXER_ENQUEUE = PRIOR.enqueue;
  fs.rmSync(SANDBOX_REPO_ROOT, { recursive: true, force: true });
  fs.rmSync(SANDBOX_DATA_DIR, { recursive: true, force: true });
});

const learningsDir = path.join(SANDBOX_REPO_ROOT, 'ψ', 'memory', 'learnings');
const files = () => (fs.existsSync(learningsDir) ? fs.readdirSync(learningsDir) : []);
const parse = (res: Awaited<ReturnType<typeof handleLearn>>) => JSON.parse(res.content[0].text as string);

describe('oracle_learn — atomic file + rows', () => {
  test('success leaves file and row', async () => {
    const res = await handleLearn(makeCtx(), { pattern: 'atomic ok learning via mcp', source: 'atomic test' });
    const body = parse(res);
    expect(body.success).toBe(true);
    expect(fs.existsSync(path.join(SANDBOX_REPO_ROOT, body.file))).toBe(true);
    expect((sqlite.query('SELECT COUNT(*) AS c FROM oracle_documents WHERE id = ?').get(body.id) as { c: number }).c).toBe(1);
  });

  test('a failing row write is reported as an error and leaves no file behind', async () => {
    sqlite.exec("CREATE TRIGGER boom BEFORE INSERT ON oracle_documents WHEN NEW.id LIKE '%boom-learning%' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const before = files();
    // The handler may surface the failure either as a thrown error (the MCP dispatcher turns it
    // into an error response) or as an isError response; both are acceptable, silence is not.
    let failure = '';
    try {
      const res = await handleLearn(makeCtx(), { pattern: 'boom learning atomic must not leave a file', source: 'atomic test' });
      expect(res.isError).toBe(true);
      failure = res.content[0].text as string;
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    expect(failure).toContain('boom');
    expect(files()).toEqual(before);
    expect((sqlite.query('SELECT COUNT(*) AS c FROM oracle_documents').get() as { c: number }).c).toBe(0);
    expect((sqlite.query('SELECT COUNT(*) AS c FROM oracle_fts').get() as { c: number }).c).toBe(0);
  });
});
