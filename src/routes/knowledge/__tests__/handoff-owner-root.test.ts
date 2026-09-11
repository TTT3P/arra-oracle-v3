/**
 * POST /api/handoff owner routing (OM-BL-2026-09-11-01, cookbook incident 2026-09-11):
 *  1. a proxied seat's `memoryOwnerRoot` puts the file under <root>/ψ/inbox/handoff and is echoed;
 *  2. an absent field keeps the legacy server root (ORACLE_REPO_ROOT here);
 *  3. an invalid root (blank / relative / no ψ / the data dir) fails closed (400) and writes nothing.
 * Hermetic: ORACLE_REPO_ROOT / ORACLE_DATA_DIR are tmp dirs set BEFORE the dynamic import.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP_REPO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-handoff-repo-'));
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-handoff-data-'));
const OWNER_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-handoff-owner-'));
fs.mkdirSync(path.join(OWNER_ROOT, 'ψ'), { recursive: true });
const NO_PSI_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-handoff-nopsi-'));
const ORIGINAL = { repo: process.env.ORACLE_REPO_ROOT, data: process.env.ORACLE_DATA_DIR, db: process.env.ORACLE_DB_PATH };
process.env.ORACLE_REPO_ROOT = TMP_REPO_ROOT;
process.env.ORACLE_DATA_DIR = TMP_DATA_DIR;
process.env.ORACLE_DB_PATH = path.join(TMP_DATA_DIR, 'oracle.db');
const { handoffEndpoint } = await import('../handoff.ts');

const handoffDir = (root: string) => path.join(root, 'ψ', 'inbox', 'handoff');
const files = (root: string) => (fs.existsSync(handoffDir(root)) ? fs.readdirSync(handoffDir(root)) : []);
async function post(body: Record<string, unknown>) {
  const res = await handoffEndpoint.handle(new Request('http://local/handoff', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

afterAll(() => {
  process.env.ORACLE_REPO_ROOT = ORIGINAL.repo;
  process.env.ORACLE_DATA_DIR = ORIGINAL.data;
  process.env.ORACLE_DB_PATH = ORIGINAL.db;
  for (const dir of [TMP_REPO_ROOT, TMP_DATA_DIR, OWNER_ROOT, NO_PSI_ROOT]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/handoff — memoryOwnerRoot routing', () => {
  it('writes under the caller\'s memory root and echoes the resolved root', async () => {
    const r = await post({ content: '# owner-rooted handoff\n\nfixture', slug: 'owner-rooted', memoryOwnerRoot: OWNER_ROOT });
    expect(r.status).toBe(201);
    expect(r.body.success).toBe(true);
    expect(r.body.memoryOwnerRoot).toBe(fs.realpathSync(OWNER_ROOT));
    expect(String(r.body.file)).toMatch(/^ψ\/inbox\/handoff\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_owner-rooted\.md$/);
    expect(files(OWNER_ROOT)).toHaveLength(1);
    expect(files(TMP_REPO_ROOT)).toHaveLength(0);
    expect(files(TMP_DATA_DIR)).toHaveLength(0);
  });

  it('absent memoryOwnerRoot keeps the legacy server root and echoes no root', async () => {
    const r = await post({ content: '# legacy handoff', slug: 'legacy' });
    expect(r.status).toBe(201);
    expect(r.body.memoryOwnerRoot).toBeUndefined();
    expect(files(TMP_REPO_ROOT)).toHaveLength(1);
    expect(files(OWNER_ROOT)).toHaveLength(1);      // unchanged from the previous test
  });

  it('invalid roots fail closed with 400 and write nothing', async () => {
    const before = { owner: files(OWNER_ROOT).length, repo: files(TMP_REPO_ROOT).length, data: files(TMP_DATA_DIR).length };
    for (const bad of ['', '   ', 'relative/root', NO_PSI_ROOT, TMP_DATA_DIR, path.join(OWNER_ROOT, 'does-not-exist')]) {
      const r = await post({ content: '# should not land', slug: 'bad', memoryOwnerRoot: bad });
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toContain('memoryOwnerRoot');
    }
    expect({ owner: files(OWNER_ROOT).length, repo: files(TMP_REPO_ROOT).length, data: files(TMP_DATA_DIR).length }).toEqual(before);
    expect(files(NO_PSI_ROOT)).toHaveLength(0);
  });
});
