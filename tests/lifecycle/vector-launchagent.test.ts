import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../..');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// macOS only: scripts/install-vector-launchagent.sh renders a launchd plist and self-lints it
// with `plutil -lint` (line 93), which does not exist on Linux — on the ubuntu PR-gate runner
// the script exits 127 before writing the plist (ENOENT here; PR #25 run 33981405921, the
// first CI run to reach tests/lifecycle/). Skipped there, explicitly; still runs on every mac.
describe.skipIf(process.platform !== 'darwin')('vector sidecar LaunchAgent installer', () => {
  test('renders an idempotent login job without invoking launchctl in install-only mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'arra-vector-launchagent-'));
    roots.push(root);
    const launchAgents = join(root, 'LaunchAgents');
    const dataDir = join(root, 'data & logs');
    const fakeBun = join(root, 'bun');
    writeFileSync(fakeBun, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeBun, 0o755);

    const env = {
      ...process.env,
      ARRA_VECTOR_INSTALL_ONLY: '1',
      ARRA_VECTOR_LAUNCHAGENT_DIR: launchAgents,
      ARRA_VECTOR_BUN_BIN: fakeBun,
      ARRA_VECTOR_REPO_ROOT: repoRoot,
      ORACLE_DATA_DIR: dataDir,
    };
    const command = ['bash', 'scripts/install-vector-launchagent.sh'];
    const first = Bun.spawnSync(command, { cwd: repoRoot, env });
    const plistPath = join(launchAgents, 'com.tt3p.arra-vector.plist');
    const firstBytes = readFileSync(plistPath, 'utf8');
    const second = Bun.spawnSync(command, { cwd: repoRoot, env });

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(readFileSync(plistPath, 'utf8')).toBe(firstBytes);
    expect(firstBytes).toContain('<string>com.tt3p.arra-vector</string>');
    expect(firstBytes).toContain(`<string>${fakeBun}</string>`);
    expect(firstBytes).toContain('<string>src/vector-server.ts</string>');
    expect(firstBytes).toContain('<key>VECTOR_PORT</key>\n    <string>8081</string>');
    expect(firstBytes).toContain('<key>RunAtLoad</key>');
    expect(firstBytes).toContain('<key>KeepAlive</key>');
    expect(firstBytes).toContain(`${dataDir.replace('&', '&amp;')}/vector-server.log`);
  });

  test('rejects invalid port configuration before writing a plist', () => {
    const root = mkdtempSync(join(tmpdir(), 'arra-vector-launchagent-invalid-'));
    roots.push(root);
    const result = Bun.spawnSync(['bash', 'scripts/install-vector-launchagent.sh'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ARRA_VECTOR_INSTALL_ONLY: '1',
        ARRA_VECTOR_LAUNCHAGENT_DIR: join(root, 'LaunchAgents'),
        ARRA_VECTOR_BUN_BIN: process.execPath,
        ARRA_VECTOR_REPO_ROOT: repoRoot,
        ARRA_VECTOR_PORT: 'not-a-port',
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('ARRA_VECTOR_PORT');
  });
});
