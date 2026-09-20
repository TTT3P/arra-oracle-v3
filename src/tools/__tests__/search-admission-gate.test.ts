/**
 * MCP local-search admission gate (OM-BL-2026-09-20-01).
 *
 * The embedded/local search path (read-mostly + delegate seats, where search stays local by the
 * Riddler-R1-verified design in src/mcp/http-proxy.ts — search/read do NOT proxy) was previously
 * UNGATED: N concurrent oracle_search calls each fired an embed with no cap, piling concurrent
 * embeds onto the single remote/GPU tunnel. This asserts the gate now bounds them.
 *
 * Runs in a FRESH spawned process (same pattern as search-budget-partial.test.ts) so pinned env
 * and the process-wide searchAdmission singleton stay isolated from the rest of the suite.
 *
 * RED (pre-fix): src/tools/search/handler.ts has no gate → all 8 fulfil, 0 overloaded.
 * GREEN (post-fix): handleSearch wraps handleSearchUnguarded with searchAdmission.acquire().
 */
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-mcp-admission-'));

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
      ORACLE_VECTOR_ENABLED: '1', // keep effectiveMode hybrid → vector leg awaits (holds the slot)
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

// Builds a ToolContext with a SLOW vector store so each handler awaits ~60ms while holding its slot.
const SETUP = `
  const { createDatabase, resetDefaultDatabaseForTests } = await import('./src/db/index.ts');
  resetDefaultDatabaseForTests(process.env.ORACLE_DB_PATH);
  const { oracleDocuments } = await import('./src/db/schema.ts');
  const { handleSearch } = await import('./src/tools/search.ts');
  const { SearchOverloadedError } = await import('./src/search/budget.ts');
  const { sqlite, db } = createDatabase(process.env.ORACLE_DB_PATH);
  sqlite.exec('DELETE FROM oracle_documents'); sqlite.exec('DELETE FROM oracle_fts');
  const now = Date.now();
  db.insert(oracleDocuments).values({ id: 'admission-doc', type: 'learning',
    sourceFile: 'x.md', concepts: '["admission"]', createdAt: now, updatedAt: now, indexedAt: now, project: null }).run();
  sqlite.prepare('INSERT INTO oracle_fts (id, content, concepts) VALUES (?, ?, ?)')
    .run('admission-doc', 'admissionprobe local search admission gate concurrency bound', 'admission gate');
  const ctx = { db, sqlite, repoRoot: process.env.ORACLE_REPO_ROOT, version: 'test', vectorStatus: 'ok',
    vectorStore: { name: 'slow', query: async () => { await new Promise((r) => setTimeout(r, 60));
      return { ids: [], documents: [], metadatas: [], distances: [] }; } } };
`;

describe('MCP local search admission gate (OM-BL-2026-09-20-01)', () => {
  test('max=2, 8 concurrent oracle_search → 2 admitted, 6 SearchOverloadedError', () => {
    const result = runInFreshProcess(`${SETUP}
      const settled = await Promise.allSettled(
        Array.from({ length: 8 }, () => handleSearch(ctx, { query: 'admissionprobe', mode: 'hybrid', limit: 5 })));
      let ok = 0, overloaded = 0, other = 0;
      for (const s of settled) {
        if (s.status === 'fulfilled') ok++;
        else if (s.reason instanceof SearchOverloadedError) overloaded++;
        else other++;
      }
      console.log('RESULT_JSON:' + JSON.stringify({ ok, overloaded, other }));
    `, { ORACLE_SEARCH_MAX_INFLIGHT: '2' });
    expect(result.other).toBe(0);
    expect(result.ok).toBe(2);
    expect(result.overloaded).toBe(6);
  });

  test('sequential searches all succeed (slot released each time)', () => {
    const result = runInFreshProcess(`${SETUP}
      let ok = 0;
      for (let i = 0; i < 5; i++) { const r = await handleSearch(ctx, { query: 'admissionprobe', mode: 'fts', limit: 5 });
        if (Array.isArray(JSON.parse(r.content[0].text).results)) ok++; }
      console.log('RESULT_JSON:' + JSON.stringify({ ok }));
    `, { ORACLE_SEARCH_MAX_INFLIGHT: '2' });
    expect(result.ok).toBe(5);
  });
});

afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
