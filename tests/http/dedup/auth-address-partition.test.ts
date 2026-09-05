/**
 * Riddler PR#22 P1: GET/HEAD deduplication must never replay a loopback caller's
 * authorized response to a remote or unresolved caller. Identical method, URL,
 * headers and cookie, issued concurrently under three captured client addresses:
 * loopback wins the pending key; remote and unknown must still execute their own
 * authorization and get 401 (settings) / authenticated:false (status).
 *
 * Note (pre-existing on live before PR#22): the address-blind key existed before
 * this branch; the loopback bind (PR#19) currently keeps remote callers off the
 * socket entirely. This test pins the in-process guarantee regardless of bind.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const savedDataDir = process.env.ORACLE_DATA_DIR;
const savedDbPath = process.env.ORACLE_DB_PATH;
const root = mkdtempSync(join(tmpdir(), 'arra-dedup-auth-'));
process.env.ORACLE_DATA_DIR = root;
process.env.ORACLE_DB_PATH = join(root, 'oracle.db');
const dbMod = await import('../../../src/db/index.ts');
dbMod.resetDefaultDatabaseForTests(process.env.ORACLE_DB_PATH);
const { setScopedSetting } = await import('../../../src/db/scoped-settings.ts');
const { authRoutes } = await import('../../../src/routes/auth/index.ts');
const { settingsRoutes } = await import('../../../src/routes/settings/index.ts');
const { createRequestDedupFetch } = await import('../../../src/middleware/dedup.ts');
const { runWithRemoteAddress } = await import('../../../src/middleware/remote-address.ts');

afterAll(() => {
  if (savedDataDir === undefined) delete process.env.ORACLE_DATA_DIR; else process.env.ORACLE_DATA_DIR = savedDataDir;
  if (savedDbPath === undefined) delete process.env.ORACLE_DB_PATH; else process.env.ORACLE_DB_PATH = savedDbPath;
  rmSync(root, { recursive: true, force: true });
});

const app = new Elysia().use(authRoutes).use(settingsRoutes);
const fetchDedup = createRequestDedupFetch((req) => app.handle(req));
const identical = (path: string) => new Request(`http://local${path}`, {
  method: 'GET',
  headers: { accept: 'application/json', cookie: 'oracle_session=; other=1', 'user-agent': 'same' },
});
const under = (address: string | null, path: string) => runWithRemoteAddress(address, () => fetchDedup(identical(path)));

describe('dedup is partitioned by the trusted client address', () => {
  test('identical concurrent GET /api/settings: loopback 200, remote 401, unknown 401', async () => {
    setScopedSetting('auth_enabled', 'true');
    setScopedSetting('auth_local_bypass', 'true');
    try {
      // Issue all three before awaiting so they overlap in flight with the same method/URL/headers/cookie.
      const [loop, remote, unknown] = await Promise.all([
        under('127.0.0.1', '/api/settings'),
        under('192.168.50.158', '/api/settings'),
        under(null, '/api/settings'),
      ]);
      expect(loop.status).toBe(200);
      expect(remote.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(await remote.json()).toMatchObject({ error: 'Unauthorized', requiresAuth: true });
    } finally {
      setScopedSetting('auth_enabled', 'false');
    }
  });

  test('identical concurrent GET /api/auth/status: only loopback is authenticated and local', async () => {
    setScopedSetting('auth_enabled', 'true');
    setScopedSetting('auth_local_bypass', 'true');
    try {
      const [loop, remote, unknown] = await Promise.all([
        under('127.0.0.1', '/api/auth/status'),
        under('100.114.64.85', '/api/auth/status'),
        under(null, '/api/auth/status'),
      ]);
      expect(await loop.json()).toMatchObject({ authenticated: true, isLocal: true });
      expect(await remote.json()).toMatchObject({ authenticated: false, isLocal: false });
      expect(await unknown.json()).toMatchObject({ authenticated: false, isLocal: false });
    } finally {
      setScopedSetting('auth_enabled', 'false');
    }
  });

  test('two callers on the same loopback address still coalesce; two remote callers on different addresses do not share', async () => {
    let hits = 0;
    const counting = new Elysia().get('/probe', () => Response.json({ hit: ++hits }));
    const dedup = createRequestDedupFetch(async (req) => { await Bun.sleep(5); return counting.handle(req); });
    const same = await Promise.all([
      runWithRemoteAddress('127.0.0.1', () => dedup(identical('/probe'))),
      runWithRemoteAddress('127.0.0.1', () => dedup(identical('/probe'))),
    ]);
    expect(hits).toBe(1);
    expect(await same[0].json()).toEqual(await same[1].json());
    const different = await Promise.all([
      runWithRemoteAddress('10.0.0.5', () => dedup(identical('/probe'))),
      runWithRemoteAddress('10.0.0.6', () => dedup(identical('/probe'))),
      runWithRemoteAddress(null, () => dedup(identical('/probe'))),
      runWithRemoteAddress(null, () => dedup(identical('/probe'))),
    ]);
    expect(hits).toBe(5); // 2 distinct remote partitions + 2 unknown callers never coalesced
    expect(different.length).toBe(4);
  });
});
