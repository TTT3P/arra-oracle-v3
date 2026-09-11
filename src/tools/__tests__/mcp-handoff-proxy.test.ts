import { afterEach, describe, expect, it } from 'bun:test';
import { ownerRootMisrouted, proxyRequestForTool } from '../../mcp/http-proxy.ts';
import { mcpRestMapByName } from '../mcp-rest-map.ts';

const ORIGINAL = process.env.ORACLE_MEMORY_OWNER_ROOT;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ORACLE_MEMORY_OWNER_ROOT; else process.env.ORACLE_MEMORY_OWNER_ROOT = ORIGINAL;
});

describe('oracle_handoff HTTP proxy mapping (OM-BL-2026-09-11-01)', () => {
  it('is owner-rooted: a bound seat forwards its ORACLE_MEMORY_OWNER_ROOT, a caller argument cannot redirect it', () => {
    expect(mcpRestMapByName.get('oracle_handoff')).toMatchObject({ remoteable: true, method: 'POST', path: '/api/handoff', body: 'owner-rooted' });
    process.env.ORACLE_MEMORY_OWNER_ROOT = '/seat/memory-root';
    expect(proxyRequestForTool('oracle_handoff', { content: '# h', slug: 's', memoryOwnerRoot: '/attacker/root' })).toEqual({
      method: 'POST', path: '/api/handoff', query: {},
      body: { content: '# h', slug: 's', memoryOwnerRoot: '/seat/memory-root' },
    });
  });

  it('an unbound seat forwards the args unchanged (legacy server root)', () => {
    delete process.env.ORACLE_MEMORY_OWNER_ROOT;
    expect(proxyRequestForTool('oracle_handoff', { content: '# h', slug: 's' })).toEqual({
      method: 'POST', path: '/api/handoff', query: {}, body: { content: '# h', slug: 's' },
    });
  });
});

describe('ownerRootMisrouted — fail-closed echo check', () => {
  const sent = { content: '# h', memoryOwnerRoot: '/seat/memory-root' };
  it('flags a successful write that did not echo memoryOwnerRoot (server predates owner routing)', () => {
    expect(ownerRootMisrouted(sent, { success: true, file: 'ψ/inbox/handoff/x.md' })).toBe(true);
    expect(ownerRootMisrouted(sent, { success: true, file: 'x.md', memoryOwnerRoot: '' })).toBe(true);
  });
  it('accepts an honoured write, and never flags failures or unbound calls', () => {
    expect(ownerRootMisrouted(sent, { success: true, file: 'x.md', memoryOwnerRoot: '/seat/memory-root' })).toBe(false);
    expect(ownerRootMisrouted(sent, { success: false, error: 'Invalid memoryOwnerRoot' })).toBe(false);
    expect(ownerRootMisrouted(sent, 'plain text')).toBe(false);
    expect(ownerRootMisrouted({ content: '# h' }, { success: true, file: 'x.md' })).toBe(false);
    expect(ownerRootMisrouted(undefined, { success: true })).toBe(false);
  });
});
