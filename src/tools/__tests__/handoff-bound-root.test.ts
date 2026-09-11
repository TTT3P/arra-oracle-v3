import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../db/index.ts';
import type { ToolContext } from '../types.ts';
import { handleHandoff } from '../handoff.ts';

// Local (non-proxied) oracle_handoff on a bound seat (OM-BL-2026-09-11-01): the seat's
// ORACLE_MEMORY_OWNER_ROOT outranks the MCP server's cwd/vault, mirroring tools/learn.ts.
const tempRoots: string[] = [];
const ORIGINAL = process.env.ORACLE_MEMORY_OWNER_ROOT;
function tempRoot(prefix: string) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempRoots.push(d); return d; }
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ORACLE_MEMORY_OWNER_ROOT; else process.env.ORACLE_MEMORY_OWNER_ROOT = ORIGINAL;
  for (const d of tempRoots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function files(root: string) { const d = path.join(root, 'ψ', 'inbox', 'handoff'); return fs.existsSync(d) ? fs.readdirSync(d) : []; }

describe('handleHandoff on a bound seat', () => {
  test('writes under ORACLE_MEMORY_OWNER_ROOT/ψ/inbox/handoff, never under the server cwd', async () => {
    const repoRoot = tempRoot('arra-handoff-cwd-');
    const ownerRoot = tempRoot('arra-handoff-owner-');
    fs.mkdirSync(path.join(ownerRoot, 'ψ'), { recursive: true });
    const { sqlite, db } = createDatabase(path.join(tempRoot('arra-handoff-db-'), 'oracle.db'));
    const ctx = { repoRoot, sqlite, db } as unknown as ToolContext;
    process.env.ORACLE_MEMORY_OWNER_ROOT = ownerRoot;
    const res = await handleHandoff(ctx, { content: '# bound-seat handoff\n\nfixture', slug: 'bound-seat' });
    const body = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(res.isError).toBeUndefined();
    expect(body.success).toBe(true);
    expect(files(ownerRoot)).toHaveLength(1);
    expect(files(ownerRoot)[0]).toMatch(/_bound-seat\.md$/);
    expect(files(repoRoot)).toHaveLength(0);
    sqlite.close();
  });
});
