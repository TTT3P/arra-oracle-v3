/**
 * Gateway-proxied search logging (OM-BL-2026-09-20-04).
 *
 * When VECTOR_URL is set the gateway proxies /api/search to the readonly vector sidecar. On parent
 * code the sidecar's logSearch throws SQLITE_READONLY (caught) and the main never logs, so the
 * proxied search is recorded NOWHERE. Fix: logSearch skips cleanly on a readonly handle, and the
 * gateway logs the proxied search exactly once on the writable main.
 *
 * Case 1 (unit): logSearch on a readonly handle does not throw / does not log a write failure.
 * Case 2 (integration): a real gatewayPlugin app proxying /api/search to a stub sidecar writes
 *   EXACTLY ONE search_log row on the writable main db.
 * Both are RED on parent code and GREEN on the fix.
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

describe('gateway-proxied search logging (OM-BL-2026-09-20-04)', () => {
  test('logSearch on a readonly handle: no throw, no write-failure logged, no row', () => {
    const r = runInFreshProcess(`
      const errors = []; const orig = console.error; console.error = (...a) => errors.push(a.map(String).join(' '));
      const dbmod = await import('./src/db/index.ts');
      dbmod.createDatabase(process.env.ORACLE_DB_PATH).sqlite.close(); // create schema file, writable
      process.env.ORACLE_VECTOR_READONLY = '1';                        // default handle opens readonly
      const logging = await import('./src/server/logging.ts');
      logging.logSearch('roquery', 'all', 'hybrid', 0, 1, [], undefined);
      console.error = orig;
      const cnt = dbmod.sqlite.prepare('SELECT COUNT(*) AS c FROM search_log WHERE query=?').get('roquery');
      console.log('RESULT_JSON:' + JSON.stringify({
        readonly: dbmod.defaultStorageReadonly(),
        searchFailLogged: errors.some((m) => m.includes('Failed to log search')),
        rows: cnt.c }));
      process.exit(0);
    `);
    expect(r.readonly).toBe(true);
    expect(r.searchFailLogged).toBe(false); // RED on parent: the insert throws and is logged
    expect(r.rows).toBe(0);
  });

  test('gatewayPlugin proxies /api/search → exactly ONE search_log row on the writable main', () => {
    const r = runInFreshProcess(`
      // Stub readonly sidecar: returns search results + healthy vector health.
      const stub = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => {
        const u = new URL(req.url);
        if (u.pathname === '/api/search') return Response.json({ results: [{ id:'x', type:'learning', content:'hit', score:0.9 }], total: 1, mode: 'hybrid' });
        if (u.pathname === '/api/vector/health') return Response.json({ status:'ok', engines:[], checked_at:new Date().toISOString() });
        return Response.json({ error:'x' }, { status: 404 });
      }});
      // Writable main: create schema, keep default handle writable (no readonly flags).
      const dbmod = await import('./src/db/index.ts');
      dbmod.createDatabase(process.env.ORACLE_DB_PATH); // creates search_log etc.
      const { Elysia } = await import('elysia');
      const { gatewayPlugin } = await import('./src/gateway/index.ts');
      const app = new Elysia().use(gatewayPlugin(process.env.ORACLE_DATA_DIR, 'http://127.0.0.1:' + stub.port));
      const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch });
      const base = 'http://127.0.0.1:' + server.port;
      const res = await fetch(base + '/api/search?q=proxlogonce&type=all&mode=hybrid');
      const status = res.status;
      const cnt = dbmod.sqlite.prepare('SELECT COUNT(*) AS c FROM search_log WHERE query=?').get('proxlogonce');
      console.log('RESULT_JSON:' + JSON.stringify({ status, rows: cnt.c }));
      server.stop(true); stub.stop(true); process.exit(0);
    `);
    expect(r.status).toBe(200);   // proxied response served
    expect(r.rows).toBe(1);       // RED on parent (0 rows: gateway didn't log); GREEN on fix (exactly one)
  });
});

afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
