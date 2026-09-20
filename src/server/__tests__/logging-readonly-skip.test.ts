/**
 * Readonly document-usage cleanup (OM-BL-2026-09-20-03).
 *
 * On a readonly sidecar (ORACLE_VECTOR_READONLY / ORACLE_READ_ONLY) every write in
 * logDocumentAccess — the documentAccess insert AND bumpDocumentUsage — throws SQLITE_READONLY on
 * every proxied search result (observed live: 34,690×). It is caught (search still returns), but
 * usage_count / last_accessed_at are never updated for these searches.
 *
 * Fix (option b): when the DB handle is readonly (single check: defaultStorageReadonly), skip the
 * writes cleanly and count the skip so the census gap is observable.
 *
 * RED (pre-fix): logDocumentAccess attempts the writes → catches → logs "Failed to log access" /
 * "Failed to bump document usage".
 * GREEN (post-fix): no write attempted, no failure logged, and documentAccessReadonlySkipCount() > 0.
 *
 * Runs in a fresh process: the schema file is created writable, then the default handle is opened
 * READONLY (resetDefaultDatabaseForTests always opens read-write, so we drive the lazy default via
 * ORACLE_VECTOR_READONLY instead).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-ro-skip-'));

function runInFreshProcess(script: string) {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, '--eval', script],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: tmpRoot,
      ORACLE_DATA_DIR: path.join(tmpRoot, 'data'),
      ORACLE_DB_PATH: path.join(tmpRoot, 'data', 'oracle.db'),
      ORACLE_REPO_ROOT: tmpRoot,
    },
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

describe('logDocumentAccess on a readonly handle (OM-BL-2026-09-20-03)', () => {
  test('skips cleanly with an observable counter and no write-failure logging', () => {
    const r = runInFreshProcess(`
      const errors = [];
      const orig = console.error;
      console.error = (...a) => { errors.push(a.map(String).join(' ')); };
      // 1) create the DB file + schema WRITABLE, then close it.
      const dbmod = await import('./src/db/index.ts');
      const seed = dbmod.createDatabase(process.env.ORACLE_DB_PATH);
      try { seed.sqlite.close(); } catch {}
      // 2) open the DEFAULT handle READONLY (first real use opens it under this flag).
      process.env.ORACLE_VECTOR_READONLY = '1';
      const logging = await import('./src/server/logging.ts');
      logging.logDocumentAccess('any-doc-id', 'search');
      console.error = orig;
      console.log('RESULT_JSON:' + JSON.stringify({
        readonly: dbmod.defaultStorageReadonly(),
        bumpFailLogged: errors.some((m) => m.includes('Failed to bump document usage')),
        accessFailLogged: errors.some((m) => m.includes('Failed to log access')),
        skips: (typeof logging.documentAccessReadonlySkipCount === 'function'
          ? logging.documentAccessReadonlySkipCount() : -1),
      }));
      process.exit(0);
    `);
    expect(r.readonly).toBe(true);
    // RED on pre-fix code: both of these are true (the writes throw and are logged).
    expect(r.bumpFailLogged).toBe(false);
    expect(r.accessFailLogged).toBe(false);
    // Observability: the skip is counted (pre-fix export is absent → -1).
    expect(r.skips).toBeGreaterThanOrEqual(1);
  });

  test('writable handle still records access (no regression to the writer path)', () => {
    const r = runInFreshProcess(`
      const errors = [];
      const orig = console.error;
      console.error = (...a) => { errors.push(a.map(String).join(' ')); };
      const dbmod = await import('./src/db/index.ts');
      dbmod.createDatabase(process.env.ORACLE_DB_PATH); // writable default (no readonly flag set)
      const logging = await import('./src/server/logging.ts');
      logging.logDocumentAccess('any-doc-id', 'search');
      console.error = orig;
      console.log('RESULT_JSON:' + JSON.stringify({
        readonly: dbmod.defaultStorageReadonly(),
        bumpFailLogged: errors.some((m) => m.includes('Failed to bump document usage')),
        skips: (typeof logging.documentAccessReadonlySkipCount === 'function'
          ? logging.documentAccessReadonlySkipCount() : -1),
      }));
      process.exit(0);
    `);
    expect(r.readonly).toBe(false);
    expect(r.bumpFailLogged).toBe(false); // writer path succeeds
    expect(r.skips).toBe(0);              // nothing skipped on a writable handle
  });
});

afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
