/**
 * Gateway-proxied search logging (OM-BL-2026-09-20-04).
 *
 * When VECTOR_URL is set the gateway proxies /api/search to the readonly vector sidecar. On parent
 * code the sidecar's logSearch throws SQLITE_READONLY (caught) and the main never logs, so proxied
 * searches are recorded NOWHERE. Fix: logSearch skips cleanly on a readonly handle, and the gateway
 * logs the proxied search exactly once on the writable main — with a TRUTHFUL search_time_ms
 * (measured in the gateway) and a project resolved the same way as handlers.ts (cwd fallback +
 * lowercase). All assertions are RED on parent code and GREEN on the fix.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-proxlog-'));
const READONLY_ENV_KEYS = ['ORACLE_VECTOR_READONLY', 'ORACLE_READ_ONLY'];

function runInFreshProcess(script: string, caseEnv: Record<string, string> = {}) {
  const caseDir = fs.mkdtempSync(path.join(tmpRoot, 'case-'));
  const env: Record<string, string> = {
    ...process.env,
    HOME: tmpRoot,
    ORACLE_DATA_DIR: path.join(caseDir, 'data'),
    ORACLE_DB_PATH: path.join(caseDir, 'data', 'oracle.db'),
    ORACLE_REPO_ROOT: caseDir,
    ORACLE_GATEWAY_HOT_RELOAD: '0',
  } as Record<string, string>;
  for (const k of [...READONLY_ENV_KEYS, 'VECTOR_URL', 'ORACLE_VECTOR_SERVER']) delete env[k];
  Object.assign(env, caseEnv);
  const proc = Bun.spawnSync({ cmd: [process.execPath, '--eval', script], cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe' });
  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);
  if (proc.exitCode !== 0) throw new Error(stderr || stdout);
  const line = stdout.split('\n').reverse().find((l) => l.startsWith('RESULT_JSON:'));
  if (!line) throw new Error(`no RESULT_JSON.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  return JSON.parse(line.slice('RESULT_JSON:'.length)) as Record<string, any>;
}

// Boots a writable main + a stub sidecar (optional response delay), drives ONE proxied /api/search
// with the given querystring, and returns the persisted search_log row.
const PROXY_ONE = (query: string, delayMs = 0) => `
  const stub = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/api/search') {
      ${delayMs > 0 ? `await new Promise((r)=>setTimeout(r, ${delayMs}));` : ''}
      return Response.json({ results: [{ id:'x', type:'learning', content:'hit', score:0.9 }], total: 1, mode: 'hybrid' });
    }
    if (u.pathname === '/api/vector/health') return Response.json({ status:'ok', engines:[], checked_at:new Date().toISOString() });
    return Response.json({ error:'x' }, { status: 404 });
  }});
  const dbmod = await import('./src/db/index.ts');
  dbmod.createDatabase(process.env.ORACLE_DB_PATH); // create schema (search_log etc.), writable
  const { Elysia } = await import('elysia');
  const { gatewayPlugin } = await import('./src/gateway/index.ts');
  const app = new Elysia().use(gatewayPlugin(process.env.ORACLE_DATA_DIR, 'http://127.0.0.1:' + stub.port));
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch });
  const res = await fetch('http://127.0.0.1:' + server.port + '${query}');
  const status = res.status;
  const bodyOk = Array.isArray((await res.json()).results); // client still gets a valid body
  const rows = dbmod.sqlite.prepare('SELECT COUNT(*) AS c FROM search_log').get().c;
  const row = dbmod.sqlite.prepare('SELECT query, search_time_ms AS ms, project FROM search_log ORDER BY id DESC LIMIT 1').get() || {};
  console.log('RESULT_JSON:' + JSON.stringify({ status, bodyOk, rows, query: row.query, ms: row.ms, project: row.project }));
  server.stop(true); stub.stop(true); process.exit(0);
`;

describe('gateway-proxied search logging (OM-BL-2026-09-20-04)', () => {
  test('logSearch on a readonly handle: no throw, no write-failure logged, no row', () => {
    const r = runInFreshProcess(`
      const errors = []; const orig = console.error; console.error = (...a) => errors.push(a.map(String).join(' '));
      const dbmod = await import('./src/db/index.ts');
      dbmod.createDatabase(process.env.ORACLE_DB_PATH).sqlite.close();
      process.env.ORACLE_VECTOR_READONLY = '1';
      const logging = await import('./src/server/logging.ts');
      logging.logSearch('roquery', 'all', 'hybrid', 0, 1, [], undefined);
      console.error = orig;
      const cnt = dbmod.sqlite.prepare('SELECT COUNT(*) AS c FROM search_log WHERE query=?').get('roquery');
      console.log('RESULT_JSON:' + JSON.stringify({
        readonly: dbmod.defaultStorageReadonly(),
        searchFailLogged: errors.some((m) => m.includes('Failed to log search')), rows: cnt.c }));
      process.exit(0);
    `);
    expect(r.readonly).toBe(true);
    expect(r.searchFailLogged).toBe(false);
    expect(r.rows).toBe(0);
  });

  test('proxied /api/search → exactly ONE row, client still gets 200 + body', () => {
    const r = runInFreshProcess(PROXY_ONE('/api/search?q=proxlogonce&type=all&mode=hybrid'));
    expect(r.status).toBe(200);
    expect(r.bodyOk).toBe(true); // best-effort logging must not break the proxied response
    expect(r.rows).toBe(1);
    expect(r.query).toBe('proxlogonce');
  });

  test('search_time_ms is the gateway-measured duration, not 0', () => {
    const r = runInFreshProcess(PROXY_ONE('/api/search?q=proxlogdur&mode=hybrid', 80));
    expect(r.rows).toBe(1);
    expect(r.ms).toBeGreaterThan(0);   // RED on parent: body carries no elapsedMs → persisted 0
    expect(r.ms).toBeGreaterThanOrEqual(40); // roughly reflects the ~80ms stub delay
  });

  test('project persists resolved+lowercased from a mixed-case project param', () => {
    const r = runInFreshProcess(PROXY_ONE('/api/search?q=proxlogproj&project=GitHub.com/TTT3P/Foo'));
    expect(r.rows).toBe(1);
    expect(r.project).toBe('github.com/ttt3p/foo'); // RED on parent: raw 'GitHub.com/TTT3P/Foo'
  });

  test('project persists resolved from cwd fallback (detectProject), lowercased', () => {
    const cwd = encodeURIComponent('/wt/ghq/github.com/TTT3P/GateFix');
    const r = runInFreshProcess(PROXY_ONE('/api/search?q=proxlogcwd&cwd=' + cwd));
    expect(r.rows).toBe(1);
    expect(r.project).toBe('github.com/ttt3p/gatefix'); // RED on parent: raw project null (cwd ignored)
  });
});

afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
