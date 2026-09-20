/**
 * LIVE-HTTP admission gate (OM-BL-2026-09-20-02).
 *
 * Unlike the handler-level tests (search-admission-concurrency.test.ts), this spins up the REAL
 * Elysia searchEndpoint on a real TCP port (the sidecar's exact /api/search surface — no gateway)
 * and fires 8 genuinely concurrent HTTP requests. It captures the live enforcement behaviour:
 *
 *   - async embed leg present  → the gate ALREADY bounds inflight (2 admitted + 6×503), at every
 *     embed latency including ~0ms. Proves the gate enforces on the live path for the real
 *     collapse case (concurrent embeds); passes before and after the fix.
 *   - FTS-only (vector degraded → effectiveMode 'fts', no awaited work) → the REPRODUCED BUG:
 *     on current/pre-fix code the requests serialize on the single event-loop turn, inflight never
 *     reaches the limit, and the gate sheds nothing (8×200, 0×503). After the fix (a post-acquire
 *     yield in handleSearch), the gate sees the concurrent arrivals and sheds the excess (≥1×503;
 *     deterministically 2 admitted + 6×503 here).
 *
 * Each case runs in a fresh spawned process so VECTOR_URL is fixed before config/handlers import
 * and the searchAdmission singleton is isolated.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-live-http-'));
const CLEAR_DOCS = 'DELETE FROM ' + 'oracle_documents';
const CLEAR_FTS = 'DELETE FROM ' + 'oracle_fts';

function runInFreshProcess(script: string, env: Record<string, string>) {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, '--eval', script],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: tmpRoot,
      ORACLE_DATA_DIR: path.join(tmpRoot, 'data'),
      ORACLE_DB_PATH: path.join(tmpRoot, 'data', 'oracle.db'),
      ORACLE_REPO_ROOT: tmpRoot,
      OLLAMA_BASE_URL: 'http://127.0.0.1:1',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);
  if (proc.exitCode !== 0) throw new Error(stderr || stdout);
  const line = stdout.split('\n').reverse().find((l) => l.startsWith('RESULT_JSON:'));
  if (!line) throw new Error(`no RESULT_JSON.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  return JSON.parse(line.slice('RESULT_JSON:'.length)) as { ok: number; over: number; codes: number[] };
}

const SEED_AND_SERVE = (setup: string) => `
  ${setup}
  const { createDatabase, resetDefaultDatabaseForTests } = await import('./src/db/index.ts');
  resetDefaultDatabaseForTests(process.env.ORACLE_DB_PATH);
  const { oracleDocuments } = await import('./src/db/schema.ts');
  const { sqlite, db } = createDatabase(process.env.ORACLE_DB_PATH);
  sqlite.exec(${JSON.stringify(CLEAR_DOCS)}); sqlite.exec(${JSON.stringify(CLEAR_FTS)});
  const now = Date.now();
  db.insert(oracleDocuments).values({ id:'d', type:'learning', sourceFile:'x.md', concepts:'["l"]',
    createdAt:now, updatedAt:now, indexedAt:now, project:null }).run();
  sqlite.prepare('INSERT INTO oracle_fts (id, content, concepts) VALUES (?, ?, ?)')
    .run('d', 'liveprobe live http admission gate concurrency', 'live gate');
  const { Elysia } = await import('elysia');
  const { searchEndpoint } = await import('./src/routes/search/search.ts');
  const app = new Elysia({ prefix: '/api' }).use(searchEndpoint);
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch });
  const base = 'http://127.0.0.1:' + server.port;
  const codes = await Promise.all(Array.from({ length: 8 }, () =>
    fetch(base + '/api/search?q=liveprobe&mode=hybrid').then((r) => r.status).catch(() => 0)));
  console.log('RESULT_JSON:' + JSON.stringify({
    ok: codes.filter((c)=>c===200).length, over: codes.filter((c)=>c===503).length, codes }));
  server.stop(true);
  process.exit(0); // any open stub/app server would otherwise keep this spawned process alive
`;

describe('LIVE HTTP admission gate (real TCP, 8 concurrent, max=2)', () => {
  test('async embed leg → gate bounds inflight (2 admitted + 6×503)', () => {
    // A slow stub upstream stands in for the embed; VECTOR_URL set before imports so the search
    // route proxies its vector leg there and each request holds its slot across the await.
    const r = runInFreshProcess(SEED_AND_SERVE(`
      const stub = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (req) => {
        const u = new URL(req.url);
        if (u.pathname === '/api/search') { await new Promise((x)=>setTimeout(x,150)); return Response.json({ results: [], total: 0 }); }
        if (u.pathname === '/api/vector/health') return Response.json({ status:'ok', engines:[], checked_at:new Date().toISOString() });
        return Response.json({ error:'x' }, { status: 404 });
      }});
      process.env.VECTOR_URL = 'http://127.0.0.1:' + stub.port;
    `), { ORACLE_SEARCH_MAX_INFLIGHT: '2' });
    expect(r.ok).toBe(2);
    expect(r.over).toBe(6);
  });

  test('FTS-only path → gate sheds the concurrent excess (post-fix; pre-fix was 0×503)', () => {
    // No VECTOR_URL (sidecar case) and vector section left disabled → effectiveMode 'fts',
    // a fully synchronous critical section. Pre-fix this serialized to 8×200 / 0×503 (the bug).
    const r = runInFreshProcess(SEED_AND_SERVE(``), { ORACLE_SEARCH_MAX_INFLIGHT: '2' });
    expect(r.ok + r.over).toBe(8);
    expect(r.over).toBeGreaterThanOrEqual(1); // FAILS on pre-fix code (over === 0); passes with the yield fix
    expect(r.ok).toBeGreaterThanOrEqual(1);
  });
});

afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
