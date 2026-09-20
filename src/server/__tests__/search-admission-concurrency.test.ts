import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Reproduces the live 8-parallel admission-gate failure (OM incident: max=2 but 8×200, zero 503s).
// Same fresh-process harness as search-budget-partial.test.ts so config-bearing modules read pinned env.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-admission-conc-'));

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

// The vector leg (proxy /api/search) parks for 200ms so all N requests hold their slot concurrently.
const SLOW_VECTOR_FETCH = `
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname === '/api/search') { await new Promise((r) => setTimeout(r, 200)); return Response.json({ results: [], total: 0 }); }
    if (url.pathname === '/api/vector/health') return Response.json({ status: 'ok', engines: [], checked_at: new Date().toISOString() });
    return Response.json({ error: 'unexpected proxy call' }, { status: 404 });
  };
`;

describe('search admission gate bounds true N-way concurrency', () => {
  test('handleSearch level: max=2, 8 concurrent → 2 admitted, 6 SearchOverloadedError', () => {
    const result = runInFreshProcess(`${SLOW_VECTOR_FETCH}
      const { handleLearn, handleSearch } = await import('./src/server/handlers.ts');
      const { SearchOverloadedError } = await import('./src/search/budget.ts');
      handleLearn('concprobe8899 ground truth doc', 'test', ['concprobe8899']);
      const N = 8;
      const settled = await Promise.allSettled(
        Array.from({ length: N }, () => handleSearch('concprobe8899', 'all', 5, 0, 'hybrid'))
      );
      let ok = 0, overloaded = 0, other = 0;
      for (const s of settled) {
        if (s.status === 'fulfilled') ok++;
        else if (s.reason instanceof SearchOverloadedError) overloaded++;
        else { other++; }
      }
      console.log('RESULT_JSON:' + JSON.stringify({ N, ok, overloaded, other }));
    `, { ORACLE_SEARCH_MAX_INFLIGHT: '2' });
    expect(result.other).toBe(0);
    expect(result.ok).toBe(2);
    expect(result.overloaded).toBe(6);
  });

  test('HTTP route level: max=2, 8 concurrent GET /api/search → 2×200, 6×503', () => {
    const result = runInFreshProcess(`${SLOW_VECTOR_FETCH}
      const { handleLearn } = await import('./src/server/handlers.ts');
      const { searchEndpoint } = await import('./src/routes/search/search.ts');
      handleLearn('concprobe7788 ground truth doc', 'test', ['concprobe7788']);
      const N = 8;
      const responses = await Promise.all(
        Array.from({ length: N }, () =>
          searchEndpoint.handle(new Request('http://local/search?q=concprobe7788&mode=hybrid')))
      );
      const codes = responses.map((r) => r.status);
      const ok = codes.filter((c) => c === 200).length;
      const overloaded = codes.filter((c) => c === 503).length;
      console.log('RESULT_JSON:' + JSON.stringify({ N, ok, overloaded, codes }));
    `, { ORACLE_SEARCH_MAX_INFLIGHT: '2' });
    expect(result.ok).toBe(2);
    expect(result.overloaded).toBe(6);
  });
});

afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
