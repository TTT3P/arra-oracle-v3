/**
 * Launcher env-default regressions (OM-BL-2026-09-20-01, Riddler delta).
 *
 * bin/start-mcp-owner.sh and bin/start-mcp-read-mostly.sh set embed/search env defaults. Two traps
 * the consumers care about:
 *   1. ORACLE_RETRIEVE_DEPTH must NOT shadow an explicitly-set legacy ORACLE_SEARCH_RETRIEVE_DEPTH
 *      (src/search/retrieve-depth.ts:4-6 reads both).
 *   2. OLLAMA_FALLBACK_BASE_URLS must distinguish unset (→ default :11434) from explicit-empty
 *      (deliberate no-fallback, must stay empty — src/vector/ollama-url-chain.ts:21).
 *
 * We drive each real launcher and intercept its final `exec "$BUN_BIN" …` via the ARRA_BUN_BIN
 * hook, pointing it at a stub that prints `env`. No bun/MCP server is started.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-launcher-env-'));
const stub = path.join(tmp, 'bun-stub.sh');
const OWNER = path.resolve(process.cwd(), 'bin/start-mcp-owner.sh');
const READ_MOSTLY = path.resolve(process.cwd(), 'bin/start-mcp-read-mostly.sh');

beforeAll(() => {
  fs.writeFileSync(stub, '#!/bin/sh\nenv\n');
  fs.chmodSync(stub, 0o755);
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Run a launcher with a clean, case-specific env; return the child's resolved env as a map. */
function runLauncher(script: string, caseEnv: Record<string, string>): Record<string, string> {
  const proc = Bun.spawnSync({
    cmd: [script],
    env: { PATH: process.env.PATH ?? '', HOME: tmp, ARRA_BUN_BIN: stub, ...caseEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new TextDecoder().decode(proc.stdout);
  if (proc.exitCode !== 0) throw new Error(new TextDecoder().decode(proc.stderr) || stdout);
  const env: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

for (const [name, script] of [['owner', OWNER], ['read-mostly', READ_MOSTLY]] as const) {
  describe(`${name} launcher env defaults`, () => {
    test('neither depth var set → ORACLE_RETRIEVE_DEPTH defaults to 60', () => {
      const env = runLauncher(script, {});
      expect(env.ORACLE_RETRIEVE_DEPTH).toBe('60');
    });

    test('explicit legacy ORACLE_SEARCH_RETRIEVE_DEPTH is preserved and NOT shadowed', () => {
      const env = runLauncher(script, { ORACLE_SEARCH_RETRIEVE_DEPTH: '99' });
      expect(env.ORACLE_SEARCH_RETRIEVE_DEPTH).toBe('99');
      // The script must NOT introduce ORACLE_RETRIEVE_DEPTH=60 (which would win over the legacy var).
      expect(env.ORACLE_RETRIEVE_DEPTH).toBeUndefined();
    });

    test('explicit current ORACLE_RETRIEVE_DEPTH is preserved', () => {
      const env = runLauncher(script, { ORACLE_RETRIEVE_DEPTH: '42' });
      expect(env.ORACLE_RETRIEVE_DEPTH).toBe('42');
    });

    test('unset OLLAMA_FALLBACK_BASE_URLS → defaults to the GPU tunnel fallback (BL-229)', () => {
      const env = runLauncher(script, {});
      expect(env.OLLAMA_FALLBACK_BASE_URLS).toBe('http://127.0.0.1:11435');
    });

    test('explicit EMPTY OLLAMA_FALLBACK_BASE_URLS stays empty (no-fallback preserved)', () => {
      const env = runLauncher(script, { OLLAMA_FALLBACK_BASE_URLS: '' });
      expect(env.OLLAMA_FALLBACK_BASE_URLS).toBe(''); // present but empty, NOT clobbered to a default
    });

    test('OLLAMA_BASE_URL defaults to the Mac CPU :11434 (BL-229, TINE 2026-10-09)', () => {
      const env = runLauncher(script, {});
      expect(env.OLLAMA_BASE_URL).toBe('http://127.0.0.1:11434');
    });
  });
}
