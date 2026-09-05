/**
 * README "Docker-first hero path" smoke: build the http-server image, run the advertised
 * container, and read /api/health from the /data volume.
 *
 * Moved out of tests/docs/readme-claims.test.ts (audit 2026-09-05 P1-1): it needs a Docker
 * daemon and a multi-minute image build, which kept the PR gate ("Typecheck and scoped
 * tests") red. tests/integration/ is deliberately not in the PR gate; this file runs in the
 * scheduled `docker-hero-smoke` workflow (and on workflow_dispatch). The README text
 * assertions for the same section stay in the PR gate.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smokeDockerHeroPath } from '../docs/readme-claim-smoke.ts';

function dockerIsAvailable(): boolean {
  try {
    return Bun.spawnSync(['docker', 'info'], { stdout: 'pipe', stderr: 'pipe' }).exitCode === 0;
  } catch {
    return false;
  }
}

const repoRoot = process.cwd();
let scratch = '';

beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), 'arra-readme-docker-hero-')); });
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

describe.skipIf(!dockerIsAvailable())('README Docker-first hero path (docker required)', () => {
  test('advertised container serves health from /data', async () => {
    const health = await smokeDockerHeroPath(repoRoot, scratch);
    expect(health.status).toBe('ok');
    expect(health.dbCheck.path).toBe('/data/oracle.db');
  }, 240_000);
});
