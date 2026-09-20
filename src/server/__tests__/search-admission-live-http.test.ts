/**
 * LIVE-HTTP admission gate (OM-BL-2026-09-20-02).
 *
 * Spins up the REAL Elysia searchEndpoint on a real TCP port (the sidecar's exact /api/search
 * surface — no gateway) and fires 8 genuinely concurrent HTTP requests. Two cases, each HERMETIC:
 * vector routing is pinned per-case in the child env and ambient VECTOR_URL / ORACLE_VECTOR_SERVER /
 * ORACLE_VECTOR_ENABLED are stripped, so an inherited VECTOR_URL can never turn the "FTS-only" case
 * into an async one (that false-green is what this rewrite closes).
 *
 *   - FTS-only case: ORACLE_VECTOR_SERVER=1 forces VECTOR_URL='' at config resolution
 *     (src/config.ts:105) regardless of any inherited value, and the vector section is left disabled,
 *     so the search path is genuinely synchronous FTS. On parent code this serialized to 8×200 /
 *     0×503 (the bug); with the post-acquire yield the gate sheds the excess. Measured here: 2+6×503.
 *   - async-embed case: owns its OWN stub and sets its OWN VECTOR_URL to it, so each request awaits a
 *     controlled-delay embed and holds its slot. The gate was already correct here (2+6×503); this
 *     case guards against a regression from the yield.
 *
 * Each case runs in a fresh spawned process so VECTOR_URL is fixed before config/handlers import and
 * the searchAdmission singleton is isolated.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-live-http-'));
const CLEAR_DOCS = 'DELETE FROM ' + 'oracle_documents';
const CLEAR_FTS = 'DELETE FROM ' + 'oracle_fts';

// Vector-routing env that must NOT leak from the ambient/parent environment into a child, or a
// hostile inherited VECTOR_URL would silently make the FTS-only case async (false green).
const VECTOR_ENV_KEYS = ['VECTOR_URL', 'ORACLE_VECTOR_SERVER', 'ORACLE_VECTOR_ENABLED', 'ORACLE_PROXY_VECTOR_URL'];

function runInFreshProcess(script: string, caseEnv: Record<string, string>) {
  const env: Record<string, string> = {
    ...process.env,
    HOME: tmpRoot,
    ORACLE_DATA_DIR: path.join(tmpRoot, 'data'),
    ORACLE_DB_PATH: path.join(tmpRoot, 'data', 'oracle.db'),
    ORACLE_REPO_ROOT: tmpRoot,
    OLLAMA_BASE_URL: 'http://127.0.0.1:1',
  } as Record<string, string>;
  for (const k of VECTOR_ENV_KEYS) delete env[k]; // strip ambient — each case pins its own routing
  Object.assign(env, caseEnv);

  const proc = Bun.spawnSync({
    cmd: [process.execPath, '--eval', script],
    cwd: process.cwd(),
    env,
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
  // Report the resolved routing so the assertions can prove the case is really in the mode it claims.
  const { VECTOR_URL } = await import('./src/config.ts');
  const { Elysia } = await import('elysia');
  const { searchEndpoint } = await import('./src/routes/search/search.ts');
  const app = new Elysia({ prefix: '/api' }).use(searchEndpoint);
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch });
  const base = 'http://127.0.0.1:' + server.port;
  const codes = await Promise.all(Array.from({ length: 8 }, () =>
    fetch(base + '/api/search?q=liveprobe&mode=hybrid').then((r) => r.status).catch(() => 0)));
  console.log('RESULT_JSON:' + JSON.stringify({
    ok: codes.filter((c)=>c===200).length, over: codes.filter((c)=>c===503).length, codes,
    vectorUrl: VECTOR_URL }));
  server.stop(true);
  process.exit(0); // any open stub/app server would otherwise keep this spawned process alive
`;

describe('LIVE HTTP admission gate (real TCP, 8 concurrent, max=2)', () => {
  test('async embed leg → gate bounds inflight (2 admitted + 6×503)', () => {
    // Owns its own stub + its own VECTOR_URL (not the ambient one). Vector proxy → slot held on await.
    const r = runInFreshProcess(SEED_AND_SERVE(`
      const stub = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (req) => {
        const u = new URL(req.url);
        if (u.pathname === '/api/search') { await new Promise((x)=>setTimeout(x,150)); return Response.json({ results: [], total: 0 }); }
        if (u.pathname === '/api/vector/health') return Response.json({ status:'ok', engines:[], checked_at:new Date().toISOString() });
        return Response.json({ error:'x' }, { status: 404 });
      }});
      process.env.VECTOR_URL = 'http://127.0.0.1:' + stub.port;
    `), { ORACLE_SEARCH_MAX_INFLIGHT: '2' });
    expect(r.codes).toBeDefined();
    expect((r as any).vectorUrl).toContain('http://127.0.0.1:'); // proves this case really is async/proxied
    expect(r.ok).toBe(2);
    expect(r.over).toBe(6);
  });

  test('FTS-only path → gate sheds the concurrent excess (post-fix; pre-fix was 0×503)', () => {
    // ORACLE_VECTOR_SERVER=1 forces VECTOR_URL='' (config.ts:105) even under a hostile inherited
    // VECTOR_URL; vector section left disabled → genuinely synchronous FTS. This is the RED case.
    const r = runInFreshProcess(SEED_AND_SERVE(``), {
      ORACLE_SEARCH_MAX_INFLIGHT: '2',
      ORACLE_VECTOR_SERVER: '1',
    });
    expect((r as any).vectorUrl).toBe(''); // proves this case is genuinely vector-off (synchronous FTS)
    expect(r.ok + r.over).toBe(8);
    expect(r.over).toBeGreaterThanOrEqual(1); // FAILS on pre-fix code (over === 0); passes with the yield fix
    expect(r.ok).toBeGreaterThanOrEqual(1);
  });
});

afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
