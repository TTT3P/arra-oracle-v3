/**
 * Riddler round 2 #1: the HTTP surface must accept and apply an explicit
 * `project`, on both GET (query) and POST (body), and refuse fail-closed
 * combinations with 400 — these are the exact paths the owner proxy uses.
 */
import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-verify-scope-http-data-'));
const treeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-verify-scope-http-repo-'));
// repoRoot resolves to a project so scoped behavior (incl. check:false) is testable
const repoRoot = path.join(treeRoot, 'ghq', 'github.com', 'testowner', 'testrepo');
const CALLER = 'github.com/testowner/testrepo';
fs.mkdirSync(repoRoot, { recursive: true });

const originalDataDir = process.env.ORACLE_DATA_DIR;
const originalDbPath = process.env.ORACLE_DB_PATH;
const originalRepoRoot = process.env.ORACLE_REPO_ROOT;
process.env.ORACLE_DATA_DIR = dataDir;
process.env.ORACLE_DB_PATH = path.join(dataDir, 'oracle.db');
process.env.ORACLE_REPO_ROOT = repoRoot;

const dbModule = await import('../../../src/db/index.ts');
dbModule.resetDefaultDatabaseForTests(process.env.ORACLE_DB_PATH);
const { db, oracleDocuments } = dbModule;
const { verifyRoutes } = await import('../../../src/routes/verify/index.ts');

const now = Date.now();
const ownedOrphanPath = `ψ/memory/learnings/http-owned-orphan-${stamp}.md`;
const foreignPath = `ψ/memory/learnings/http-foreign-${stamp}.md`;

db.insert(oracleDocuments).values({
  id: `http-owned-orphan-${stamp}`, type: 'learning', concepts: '[]',
  sourceFile: ownedOrphanPath, createdAt: now, updatedAt: now, indexedAt: now,
  project: CALLER, createdBy: 'indexer',
}).run();
db.insert(oracleDocuments).values({
  id: `http-foreign-${stamp}`, type: 'learning', concepts: '[]',
  sourceFile: foreignPath, createdAt: now, updatedAt: now, indexedAt: now,
  project: 'github.com/other/project', createdBy: 'indexer',
}).run();

function request(url: string, init: RequestInit = {}) {
  return verifyRoutes.handle(new Request(`http://local${url}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  }));
}

afterAll(() => {
  dbModule.resetDefaultDatabaseForTests(':memory:');
  if (originalDataDir) process.env.ORACLE_DATA_DIR = originalDataDir; else delete process.env.ORACLE_DATA_DIR;
  if (originalDbPath) process.env.ORACLE_DB_PATH = originalDbPath; else delete process.env.ORACLE_DB_PATH;
  if (originalRepoRoot) process.env.ORACLE_REPO_ROOT = originalRepoRoot; else delete process.env.ORACLE_REPO_ROOT;
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(treeRoot, { recursive: true, force: true });
});

test('GET /api/verify?project= applies the explicit override', async () => {
  const res = await request(`/api/verify?project=${encodeURIComponent('github.com/other/project')}`);
  const body = await res.json() as { scope: { project: string; mutationAllowed: boolean }; orphaned: string[] };
  expect(res.status).toBe(200);
  expect(body.scope.project).toBe('github.com/other/project');
  expect(body.scope.mutationAllowed).toBe(false);
  expect(body.orphaned).toContain(foreignPath); // owned under the override
  expect(body.orphaned).not.toContain(ownedOrphanPath);
});

test('POST /api/verify with body project reaches the handler (proxy path shape)', async () => {
  const res = await request('/api/verify', {
    method: 'POST',
    body: JSON.stringify({ check: true, type: 'learning', project: CALLER }),
  });
  const body = await res.json() as { scope: { project: string; detected: string | null } };
  expect(res.status).toBe(200);
  expect(body.scope.project).toBe(CALLER);
  expect(body.scope.detected).toBe(CALLER);
});

test('POST check=false with a mismatching override is refused 400 and mutates nothing', async () => {
  const res = await request('/api/verify', {
    method: 'POST',
    body: JSON.stringify({ check: false, project: 'github.com/other/project' }),
  });
  const body = await res.json() as { error?: string };
  expect(res.status).toBe(400);
  expect(body.error).toContain('fail-closed');
  const rows = db.select({ supersededBy: oracleDocuments.supersededBy }).from(oracleDocuments).all();
  for (const row of rows) expect(row.supersededBy).toBeNull();
});

test('POST check=false with project OMITTED is refused 400 even on a canonical root (round 3)', async () => {
  const res = await request('/api/verify', {
    method: 'POST',
    body: JSON.stringify({ check: false, type: 'learning' }),
  });
  const body = await res.json() as { error?: string };
  expect(res.status).toBe(400);
  expect(body.error).toContain('fail-closed');
  const rows = db.select({ supersededBy: oracleDocuments.supersededBy }).from(oracleDocuments).all();
  for (const row of rows) expect(row.supersededBy).toBeNull();
});

test('POST /api/verify with an invalid project is refused 400', async () => {
  const res = await request('/api/verify', {
    method: 'POST',
    body: JSON.stringify({ check: true, project: '///bogus///' }),
  });
  expect(res.status).toBe(400);
});

test('POST check=false WITH explicit matching project flags owned orphans (runs last)', async () => {
  const res = await request('/api/verify', {
    method: 'POST',
    body: JSON.stringify({ check: false, type: 'learning', project: CALLER }),
  });
  const body = await res.json() as { fixed_orphans?: number };
  expect(res.status).toBe(200);
  expect(body.fixed_orphans).toBe(1);
  const flagged = db.select({ id: oracleDocuments.id, supersededBy: oracleDocuments.supersededBy })
    .from(oracleDocuments).all();
  const byId = Object.fromEntries(flagged.map((row) => [row.id, row.supersededBy]));
  expect(byId[`http-owned-orphan-${stamp}`]).toBe('_verified_orphan');
  expect(byId[`http-foreign-${stamp}`]).toBeNull();
});
