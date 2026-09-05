/**
 * Web auth "local network" check — audit 2026-09-05.
 *  - local = loopback only (RFC1918 dropped);
 *  - an address that cannot be resolved is NOT local (no 127.0.0.1 fallback), so
 *    `auth_local_bypass` cannot open the API to callers the server cannot place;
 *  - the real server hands Bun's server object to Elysia at request time, so
 *    `requestIP` works and a loopback caller is still recognised as local.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const savedDataDir = process.env.ORACLE_DATA_DIR;
const savedDbPath = process.env.ORACLE_DB_PATH;
const root = mkdtempSync(join(tmpdir(), 'arra-auth-local-'));
process.env.ORACLE_DATA_DIR = root;
process.env.ORACLE_DB_PATH = join(root, 'oracle.db');
const dbMod = await import('../../../src/db/index.ts');
dbMod.resetDefaultDatabaseForTests(process.env.ORACLE_DB_PATH);
const { setScopedSetting } = await import('../../../src/db/scoped-settings.ts');
const { isAuthenticated, isLocalIp, isLocalNetwork, remoteAddress } = await import('../../../src/routes/auth/index.ts');

const req = () => new Request('http://local/api/settings');
const serverWith = (address: string | null, throws = false) => ({
  requestIP: () => { if (throws) throw new Error('no socket'); return address === null ? null : { address, port: 1, family: 'IPv4' }; },
});

afterAll(() => {
  if (savedDataDir === undefined) delete process.env.ORACLE_DATA_DIR; else process.env.ORACLE_DATA_DIR = savedDataDir;
  if (savedDbPath === undefined) delete process.env.ORACLE_DB_PATH; else process.env.ORACLE_DB_PATH = savedDbPath;
  rmSync(root, { recursive: true, force: true });
});

describe('isLocalIp / remoteAddress / isLocalNetwork', () => {
  test('loopback only', () => {
    for (const ok of ['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1', ' ::1 ']) expect(isLocalIp(ok)).toBe(true);
    for (const no of ['192.168.50.158', '10.0.0.7', '172.16.0.1', '172.31.255.255', '100.114.64.85', '::ffff:192.168.1.2', '8.8.8.8', '']) {
      expect(isLocalIp(no)).toBe(false);
    }
  });

  test('unresolvable address is null, never loopback', () => {
    expect(remoteAddress(undefined, req())).toBeNull();
    expect(remoteAddress(null, req())).toBeNull();
    expect(remoteAddress({}, req())).toBeNull();
    expect(remoteAddress(serverWith(null), req())).toBeNull();
    expect(remoteAddress(serverWith('', false), req())).toBeNull();
    expect(remoteAddress(serverWith('x', true), req())).toBeNull();
    expect(remoteAddress(serverWith('127.0.0.1'), req())).toBe('127.0.0.1');
  });

  test('isLocalNetwork is false when the address is unknown or non-loopback', () => {
    expect(isLocalNetwork(undefined, req())).toBe(false);
    expect(isLocalNetwork(serverWith(null), req())).toBe(false);
    expect(isLocalNetwork(serverWith('192.168.50.10'), req())).toBe(false);
    expect(isLocalNetwork(serverWith('127.0.0.1'), req())).toBe(true);
    expect(isLocalNetwork(serverWith('::1'), req())).toBe(true);
  });
});

describe('isAuthenticated with auth enabled and local bypass on', () => {
  test('bypass applies to loopback callers only; unknown and LAN callers need a session', () => {
    setScopedSetting('auth_enabled', 'true');
    setScopedSetting('auth_local_bypass', 'true');
    try {
      expect(isAuthenticated(serverWith('127.0.0.1'), req(), undefined)).toBe(true);
      expect(isAuthenticated(undefined, req(), undefined)).toBe(false);          // no server handle → not local
      expect(isAuthenticated(serverWith(null), req(), undefined)).toBe(false);   // requestIP null → not local
      expect(isAuthenticated(serverWith('192.168.50.158'), req(), undefined)).toBe(false);
      expect(isAuthenticated(serverWith('100.114.64.85'), req(), undefined)).toBe(false);
      expect(isAuthenticated(serverWith('192.168.50.158'), req(), 'not-a-session')).toBe(false);
    } finally {
      setScopedSetting('auth_enabled', 'false');
    }
  });
});

const repoRoot = resolve(import.meta.dir, '../../..');
const procs: Array<{ kill: () => void; exited: Promise<number> }> = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const p of procs.splice(0)) { p.kill(); await p.exited; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('src/server.ts hands the Bun server to Elysia (integration)', () => {
  test('/api/auth/status from loopback reports isLocal=true (requestIP resolved, not a fallback)', async () => {
    const port = 51300 + Math.floor(Math.random() * 300);
    const dataDir = mkdtempSync(join(tmpdir(), 'arra-auth-int-data-'));
    const repo = mkdtempSync(join(tmpdir(), 'arra-auth-int-repo-'));
    dirs.push(dataDir, repo);
    const proc = Bun.spawn(['bun', 'src/server.ts'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
      env: {
        PATH: process.env.PATH!, HOME: process.env.HOME!,
        ORACLE_PORT: String(port), ORACLE_DATA_DIR: dataDir, ORACLE_DB_PATH: join(dataDir, 'oracle.db'),
        ORACLE_REPO_ROOT: repo, ORACLE_ENTITY_BACKFILL: '0', ORACLE_FILE_WATCHER: '0', ORACLE_EMBEDDER_PROBE_TIMEOUT_MS: '2000',
      },
    });
    procs.push(proc);
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${port}/api/health/live`, { signal: AbortSignal.timeout(1500) })).ok; } catch {}
      if (!up) await Bun.sleep(250);
    }
    expect(up).toBe(true);
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`, { signal: AbortSignal.timeout(5000) });
    expect(res.status).toBe(200);
    const body = await res.json() as { isLocal: boolean };
    expect(body.isLocal).toBe(true);
  }, 60000);
});
