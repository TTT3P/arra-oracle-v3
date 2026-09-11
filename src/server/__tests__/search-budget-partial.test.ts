import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Runs handleSearch / the search route in a FRESH process so config-bearing modules read pinned env
// (same pattern as search-vector-proxy-fallback.test.ts). The vector proxy is a stubbed fetch that
// records whether the vector leg was called.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-search-budget-'));

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
      VECTOR_URL: 'http://127.0.0.1:9',
      OLLAMA_BASE_URL: 'http://127.0.0.1:1',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);
  if (proc.exitCode !== 0) throw new Error(stderr || stdout);
  const line = stdout.split('\n').reverse().find((item) => item.startsWith('RESULT_JSON:'));
  if (!line) throw new Error(`Missing RESULT_JSON marker.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  return JSON.parse(line.slice('RESULT_JSON:'.length)) as Record<string, any>;
}

const STUB_FETCH = `
  globalThis.__vectorCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname === '/api/search') { globalThis.__vectorCalls += 1; return Response.json({ results: [], total: 0 }); }
    if (url.pathname === '/api/vector/health') return Response.json({ status: 'ok', engines: [], checked_at: new Date().toISOString() });
    return Response.json({ error: 'unexpected proxy call' }, { status: 404 });
  };
`;

describe('search budget → partial results (OM-BL-2026-09-09-01)', () => {
  test('FTS leg longer than the budget: FTS results returned, vector leg skipped, partial flagged', () => {
    const result = runInFreshProcess(`${STUB_FETCH}
      const { handleLearn, handleSearch } = await import('./src/server/handlers.ts');
      handleLearn('budgetprobe4471 fts ground truth survives a spent budget', 'test', ['budgetprobe4471']);
      // Simulate a 100 s synchronous FTS leg: the first Date.now() inside handleSearch is startTime,
      // every later reading is 100 s ahead — deterministic, no real waiting.
      const realNow = Date.now; let reads = 0;
      Date.now = () => realNow() + (reads++ === 0 ? 0 : 100_000);
      const r = await handleSearch('budgetprobe4471', 'all', 5, 0, 'hybrid');
      Date.now = realNow;
      console.log('RESULT_JSON:' + JSON.stringify({ ...r, vectorCalls: globalThis.__vectorCalls }));
    `, { ORACLE_SEARCH_BUDGET_MS: '5000' });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.partial).toBe(true);
    expect(result.budgetMs).toBe(5000);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(100_000);
    expect(result.vectorCalls).toBe(0);
    expect(String(result.warning)).toContain('budget');
  });

  test('generous budget: vector leg runs and no partial flag', () => {
    const result = runInFreshProcess(`${STUB_FETCH}
      const { handleLearn, handleSearch } = await import('./src/server/handlers.ts');
      handleLearn('budgetprobe4472 normal path', 'test', ['budgetprobe4472']);
      const r = await handleSearch('budgetprobe4472', 'all', 5, 0, 'hybrid');
      console.log('RESULT_JSON:' + JSON.stringify({ ...r, vectorCalls: globalThis.__vectorCalls }));
    `, { ORACLE_SEARCH_BUDGET_MS: '60000' });
    expect(result.partial).toBeUndefined();
    expect(result.vectorCalls).toBe(1);
  });
});

const SLOW_VECTOR_FETCH = `
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname === '/api/search') { await new Promise((r) => setTimeout(r, 400)); return Response.json({ results: [], total: 0 }); }
    if (url.pathname === '/api/vector/health') return Response.json({ status: 'ok', engines: [], checked_at: new Date().toISOString() });
    return Response.json({ error: 'unexpected proxy call' }, { status: 404 });
  };
`;

describe('search admission → 503 instead of queueing', () => {
  test('limit 1: a second search while the first awaits the vector leg throws SearchOverloadedError', () => {
    const result = runInFreshProcess(`${SLOW_VECTOR_FETCH}
      const { handleSearch } = await import('./src/server/handlers.ts');
      const { SearchOverloadedError } = await import('./src/search/budget.ts');
      const first = handleSearch('hold', 'all', 5, 0, 'hybrid');      // holds the only slot during the 400 ms vector await
      let out;
      try { await handleSearch('second', 'all', 5, 0, 'fts'); out = { thrown: false }; }
      catch (e) { out = { thrown: true, isOverloaded: e instanceof SearchOverloadedError, status: e.status, retryAfterSeconds: e.retryAfterSeconds }; }
      const a = await first;
      const afterRelease = await handleSearch('third', 'all', 5, 0, 'fts');  // slot released → admitted
      console.log('RESULT_JSON:' + JSON.stringify({ ...out, firstOk: Array.isArray(a.results), thirdOk: Array.isArray(afterRelease.results) }));
    `, { ORACLE_SEARCH_MAX_INFLIGHT: '1' });
    expect(result).toMatchObject({ thrown: true, isOverloaded: true, status: 503, firstOk: true, thirdOk: true });
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('GET /api/search answers 503 + Retry-After while the slot is held, never a hang or a 400', () => {
    const result = runInFreshProcess(`${SLOW_VECTOR_FETCH}
      const { handleSearch } = await import('./src/server/handlers.ts');
      const { searchEndpoint } = await import('./src/routes/search/search.ts');
      const first = handleSearch('hold', 'all', 5, 0, 'hybrid');
      const res = await searchEndpoint.handle(new Request('http://local/search?q=anything&mode=fts'));
      const body = await res.json();
      await first;
      const after = await searchEndpoint.handle(new Request('http://local/search?q=anything&mode=fts'));
      console.log('RESULT_JSON:' + JSON.stringify({ status: res.status, retryAfter: res.headers.get('retry-after'), body, afterStatus: after.status }));
    `, { ORACLE_SEARCH_MAX_INFLIGHT: '1' });
    expect(result.status).toBe(503);
    expect(Number(result.retryAfter)).toBeGreaterThan(0);
    expect(result.body.error).toContain('overloaded');
    expect(result.body.maxInflight).toBe(1);
    expect(result.afterStatus).toBe(200);
  });
});

afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
