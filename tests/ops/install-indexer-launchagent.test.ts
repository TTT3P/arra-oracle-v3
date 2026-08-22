/**
 * Phase-4a fix 3 — committed launchd installer for the vector-drain daemon.
 * Runs scripts/install-indexer-launchagent.sh with INSTALL_ONLY=1 into a temp
 * LaunchAgent dir (no launchctl bootstrap) and asserts the generated plist is
 * valid and carries the daemon-specific identity + env — matching the
 * install-vector-launchagent.sh pattern but for the daemon (INDEXER_PORT, not
 * VECTOR_PORT; entry src/indexer/daemon.ts; label com.tt3p.arra-indexer).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..', '..');
const script = path.join(repoRoot, 'scripts', 'install-indexer-launchagent.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-indexer-install-'));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

function runInstaller(opts: { port?: string } = {}): { code: number; stderr: string; plistExists: boolean; plist: string } {
  const laDir = fs.mkdtempSync(path.join(tmp, 'la-'));
  const dataDir = fs.mkdtempSync(path.join(tmp, 'data-'));
  const proc = Bun.spawnSync(['bash', script], {
    env: {
      ...process.env,
      ARRA_INDEXER_INSTALL_ONLY: '1',
      ARRA_INDEXER_LAUNCHAGENT_DIR: laDir,
      ARRA_INDEXER_REPO_ROOT: repoRoot,
      ARRA_INDEXER_BUN_BIN: process.execPath,
      ORACLE_DATA_DIR: dataDir,
      ARRA_INDEXER_PORT: opts.port ?? '47779',
    },
  });
  const plistPath = path.join(laDir, 'com.tt3p.arra-indexer.plist');
  const plistExists = fs.existsSync(plistPath);
  return { code: proc.exitCode ?? -1, stderr: proc.stderr.toString(), plistExists, plist: plistExists ? fs.readFileSync(plistPath, 'utf8') : '' };
}

describe('install-indexer-launchagent.sh (Phase-4a fix 3)', () => {
  const { code, plist } = runInstaller();

  test('exits 0 and writes a plist under INSTALL_ONLY', () => {
    expect(code).toBe(0);
    expect(plist.length).toBeGreaterThan(0);
  });

  test('plist is lint-valid (the script self-lints via plutil)', () => {
    // Reaching INSTALL_ONLY exit 0 means `plutil -lint` already passed in-script;
    // re-assert the structural essentials here.
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('<string>com.tt3p.arra-indexer</string>');
    expect(plist).toContain('src/indexer/daemon.ts');
  });

  test('carries daemon identity + env (INDEXER_PORT, not VECTOR_PORT; OLLAMA/DATA_DIR)', () => {
    expect(plist).toContain('<key>INDEXER_PORT</key>');
    expect(plist).toContain('<key>OLLAMA_BASE_URL</key>');
    expect(plist).toContain('<key>ORACLE_DATA_DIR</key>');
    expect(plist).toContain('<key>ORACLE_VECTOR_DB</key>');
    expect(plist).not.toContain('VECTOR_PORT');
  });

  test('KeepAlive.SuccessfulExit=false + RunAtLoad (survives crashes, matches family)', () => {
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  });
});

describe('install-indexer-launchagent.sh — fail-closed on foreign port owner', () => {
  test('a foreign listener on the port makes the installer EXIT NON-ZERO with NO plist written', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('not the daemon') });
    try {
      const r = runInstaller({ port: String(server.port) });
      expect(r.code).not.toBe(0);              // fail closed
      expect(r.plistExists).toBe(false);        // no plist mutation before the refusal
      expect(r.stderr).toContain('foreign process');
    } finally {
      server.stop(true);
    }
  });
});

// Stub launchctl: `print` → not-loaded (exit 1); every other subcommand → no-op
// (exit 0). With no real daemon on the (free) port, the identity health check
// never passes → the rollback path runs.
function stubLaunchctl(): string {
  const p = path.join(tmp, `launchctl-stub-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(p, '#!/bin/bash\nif [[ "$1" == "print" ]]; then exit 1; fi\nexit 0\n', { mode: 0o755 });
  return p;
}
function freePort(): string {
  const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = s.port; s.stop(true); return String(port);
}
function runFull(env: Record<string, string>): { code: number; laDir: string; plistPath: string } {
  const laDir = fs.mkdtempSync(path.join(tmp, 'la-'));
  const dataDir = fs.mkdtempSync(path.join(tmp, 'data-'));
  const plistPath = path.join(laDir, 'com.tt3p.arra-indexer.plist');
  if (env.__PRIOR__) fs.writeFileSync(plistPath, env.__PRIOR__);
  const proc = Bun.spawnSync(['bash', script], {
    env: {
      ...process.env,
      ARRA_INDEXER_LAUNCHAGENT_DIR: laDir, ARRA_INDEXER_REPO_ROOT: repoRoot,
      ARRA_INDEXER_BUN_BIN: process.execPath, ORACLE_DATA_DIR: dataDir,
      ARRA_INDEXER_PORT: freePort(), ARRA_INDEXER_LAUNCHCTL: stubLaunchctl(), ARRA_INDEXER_HEALTH_TRIES: '1',
    },
  });
  return { code: proc.exitCode ?? -1, laDir, plistPath };
}

describe('install-indexer-launchagent.sh — health-failure rollback', () => {
  test('FRESH install: health fails → exit non-zero AND the new plist is removed (no broken plist left)', () => {
    const r = runFull({});
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(r.plistPath)).toBe(false);   // rolled back to pre-install (nothing)
  });

  test('UPGRADE: health fails → exit non-zero AND the PRIOR plist is restored (not the new one)', () => {
    const priorMarker = '<?xml version="1.0"?><!-- PRIOR-PLIST-SENTINEL -->';
    const r = runFull({ __PRIOR__: priorMarker });
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(r.plistPath)).toBe(true);      // prior restored, not removed
    expect(fs.readFileSync(r.plistPath, 'utf8')).toBe(priorMarker);
  });
});
