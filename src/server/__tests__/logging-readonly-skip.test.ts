/**
 * Readonly document-usage cleanup (OM-BL-2026-09-20-03).
 *
 * On a readonly sidecar (ORACLE_VECTOR_READONLY / ORACLE_READ_ONLY) every write in logDocumentAccess
 * — the document_access insert AND bumpDocumentUsage — throws SQLITE_READONLY on every proxied search
 * result (observed live: 34,690×), caught but futile; usage_count / last_accessed_at never update.
 *
 * Fix (logging.ts): under the single readonly check (defaultStorageReadonly), skip both writes and
 * count the skip (documentAccessReadonlySkipCount).
 *
 * This test verifies real PERSISTENCE (Riddler delta): it seeds a real document and asserts the
 * writer path actually persists rows/usage/timestamp, and the readonly path persists NOTHING while
 * counting the skip. Because the writable case asserts persisted state, an unconditional early return
 * in logDocumentAccess (dropping legit writes too) makes the WRITABLE assertions RED — the gap the
 * previous version missed.
 *
 * Each case runs in a fresh process and pins the readonly signals explicitly (ambient
 * ORACLE_VECTOR_READONLY / ORACLE_READ_ONLY are stripped; each case sets what it needs).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-ro-skip-'));
const READONLY_ENV_KEYS = ['ORACLE_VECTOR_READONLY', 'ORACLE_READ_ONLY'];

function runInFreshProcess(script: string, caseEnv: Record<string, string> = {}) {
  const caseDir = fs.mkdtempSync(path.join(tmpRoot, 'case-')); // isolate the DB file per invocation
  const env: Record<string, string> = {
    ...process.env,
    HOME: tmpRoot,
    ORACLE_DATA_DIR: path.join(caseDir, 'data'),
    ORACLE_DB_PATH: path.join(caseDir, 'data', 'oracle.db'),
    ORACLE_REPO_ROOT: caseDir,
  } as Record<string, string>;
  for (const k of READONLY_ENV_KEYS) delete env[k]; // strip ambient — pin per case instead
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
  return JSON.parse(line.slice('RESULT_JSON:'.length)) as Record<string, any>;
}

// Seeds one real document with usage_count 0 / last_accessed_at NULL via a WRITABLE handle.
const SEED = `
  const seed = dbmod.createDatabase(process.env.ORACLE_DB_PATH); // always writable (create.ts)
  const t0 = Date.now();
  seed.db.insert(schema.oracleDocuments).values({ id:'seed-doc', type:'learning', sourceFile:'s.md',
    concepts:'[]', createdAt:t0, updatedAt:t0, indexedAt:t0, usageCount:0, lastAccessedAt:null,
    project:null }).run();
  seed.sqlite.close();
`;

describe('logDocumentAccess persistence by handle mode (OM-BL-2026-09-20-03)', () => {
  test('WRITABLE handle: 2 calls → 2 access rows, usage_count=2, last_accessed_at set', () => {
    const r = runInFreshProcess(`
      const dbmod = await import('./src/db/index.ts');
      const schema = await import('./src/db/schema.ts');
      ${SEED}
      // default handle stays writable (both readonly flags stripped) — the writer path.
      const logging = await import('./src/server/logging.ts');
      logging.logDocumentAccess('seed-doc', 'search');
      logging.logDocumentAccess('seed-doc', 'search');
      const row = dbmod.sqlite.prepare('SELECT usage_count AS u, last_accessed_at AS t FROM oracle_documents WHERE id=?').get('seed-doc');
      const cnt = dbmod.sqlite.prepare('SELECT COUNT(*) AS c FROM document_access WHERE document_id=?').get('seed-doc');
      console.log('RESULT_JSON:' + JSON.stringify({
        readonly: dbmod.defaultStorageReadonly(), accessRows: cnt.c, usageCount: row.u,
        lastAccessedSet: row.t != null, skips: logging.documentAccessReadonlySkipCount() }));
      process.exit(0);
    `);
    expect(r.readonly).toBe(false);
    expect(r.accessRows).toBe(2);          // access rows actually persisted
    expect(r.usageCount).toBe(2);          // usage_count incremented per call
    expect(r.lastAccessedSet).toBe(true);  // timestamp written
    expect(r.skips).toBe(0);               // nothing skipped on a writable handle
  });

  test('READONLY handle: 2 calls → 0 access rows, usage_count=0, last_accessed_at null, skips=2, 1 notice', () => {
    const r = runInFreshProcess(`
      const dbmod = await import('./src/db/index.ts');
      const schema = await import('./src/db/schema.ts');
      ${SEED}
      // Now pin readonly and let the DEFAULT handle open READONLY on first use.
      process.env.ORACLE_VECTOR_READONLY = '1';
      const errors = [];
      const orig = console.error;
      console.error = (...a) => { errors.push(a.map(String).join(' ')); };
      const logging = await import('./src/server/logging.ts');
      logging.logDocumentAccess('seed-doc', 'search');
      logging.logDocumentAccess('seed-doc', 'search');
      console.error = orig;
      const row = dbmod.sqlite.prepare('SELECT usage_count AS u, last_accessed_at AS t FROM oracle_documents WHERE id=?').get('seed-doc');
      const cnt = dbmod.sqlite.prepare('SELECT COUNT(*) AS c FROM document_access WHERE document_id=?').get('seed-doc');
      const notices = errors.filter((m) => m.includes('known census limitation') || m.includes('readonly handle')).length;
      const bumpFail = errors.some((m) => m.includes('Failed to bump document usage'));
      const accessFail = errors.some((m) => m.includes('Failed to log access'));
      console.log('RESULT_JSON:' + JSON.stringify({
        readonly: dbmod.defaultStorageReadonly(), accessRows: cnt.c, usageCount: row.u,
        lastAccessedNull: row.t == null, skips: logging.documentAccessReadonlySkipCount(),
        notices, bumpFail, accessFail }));
      process.exit(0);
    `, { ORACLE_READ_ONLY: '' }); // ORACLE_READ_ONLY explicitly clear; ORACLE_VECTOR_READONLY pinned in-script pre-open
    expect(r.readonly).toBe(true);
    expect(r.accessRows).toBe(0);        // NOTHING persisted
    expect(r.usageCount).toBe(0);        // usage_count untouched
    expect(r.lastAccessedNull).toBe(true);
    expect(r.skips).toBe(2);             // both calls counted
    expect(r.notices).toBe(1);           // single info notice (first skip only)
    expect(r.bumpFail).toBe(false);      // no SQLITE_READONLY thrown/logged
    expect(r.accessFail).toBe(false);
  });
});

afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
