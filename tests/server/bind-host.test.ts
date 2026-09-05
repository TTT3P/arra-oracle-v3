/**
 * Owner-core HTTP bind address (audit 2026-09-05): the server must listen on
 * loopback by default so the API is not reachable from the LAN/tailnet while
 * web auth cannot see the real client address. `ORACLE_HOST` widens it on purpose.
 *
 * The integration case spawns the real `src/server.ts` on a random port with an
 * isolated data dir and proves the socket is bound to 127.0.0.1 only: a request
 * to the host's first non-loopback interface address is refused, loopback answers.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { networkInterfaces } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_BIND_HOST, resolveBindHost } from '../../src/config.ts';

describe('resolveBindHost', () => {
  test('defaults to loopback and honours an explicit ORACLE_HOST', () => {
    expect(DEFAULT_BIND_HOST).toBe('127.0.0.1');
    expect(resolveBindHost({})).toBe('127.0.0.1');
    expect(resolveBindHost({ ORACLE_HOST: '' })).toBe('127.0.0.1');
    expect(resolveBindHost({ ORACLE_HOST: '   ' })).toBe('127.0.0.1');
    expect(resolveBindHost({ ORACLE_HOST: '100.64.0.9' })).toBe('100.64.0.9');
    expect(resolveBindHost({ ORACLE_HOST: ' 0.0.0.0 ' })).toBe('0.0.0.0');
  });
});

const repoRoot = resolve(import.meta.dir, '../..');
const tempDirs: string[] = [];
const procs: Array<{ kill: () => void; exited: Promise<number> }> = [];

afterEach(async () => {
  for (const p of procs.splice(0)) { p.kill(); await p.exited; }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function firstNonLoopbackIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

async function waitLive(url: string, tries = 80): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.ok) return true; } catch {}
    await Bun.sleep(250);
  }
  return false;
}

describe('src/server.ts bind (integration)', () => {
  test('listens on 127.0.0.1 only: loopback answers, the LAN address is refused', async () => {
    const port = 50900 + Math.floor(Math.random() * 300);
    const dataDir = mkdtempSync(join(tmpdir(), 'arra-bind-data-'));
    const repo = mkdtempSync(join(tmpdir(), 'arra-bind-repo-'));
    tempDirs.push(dataDir, repo);
    const proc = Bun.spawn(['bun', 'src/server.ts'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
      env: {
        PATH: process.env.PATH!, HOME: process.env.HOME!,
        ORACLE_PORT: String(port), ORACLE_DATA_DIR: dataDir, ORACLE_DB_PATH: join(dataDir, 'oracle.db'),
        ORACLE_REPO_ROOT: repo, ORACLE_ENTITY_BACKFILL: '0', ORACLE_FILE_WATCHER: '0', ORACLE_EMBEDDER_PROBE_TIMEOUT_MS: '2000',
      },
    });
    procs.push(proc);
    expect(await waitLive(`http://127.0.0.1:${port}/api/health/live`)).toBe(true);

    const lan = firstNonLoopbackIPv4();
    if (!lan) return; // no non-loopback interface on this host: loopback reachability already proven
    let refused = false;
    try {
      await fetch(`http://${lan}:${port}/api/health/live`, { signal: AbortSignal.timeout(2000) });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  }, 60000);
});
