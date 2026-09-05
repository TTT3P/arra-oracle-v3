/**
 * A proxied seat's `oracle_learn` must carry its ORACLE_MEMORY_OWNER_ROOT to the
 * owner core, so the learning file lands in the seat's memory tree instead of the
 * server's data dir (audit 2026-09-05). Other tools are untouched.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { proxyRequestForTool } from '../../src/mcp/http-proxy.ts';

const PRIOR = process.env.ORACLE_MEMORY_OWNER_ROOT;
afterEach(() => {
  if (PRIOR === undefined) delete process.env.ORACLE_MEMORY_OWNER_ROOT; else process.env.ORACLE_MEMORY_OWNER_ROOT = PRIOR;
});

describe('oracle_learn proxy body', () => {
  test('unbound seat: body is the args unchanged', () => {
    delete process.env.ORACLE_MEMORY_OWNER_ROOT;
    const req = proxyRequestForTool('oracle_learn', { pattern: 'p', concepts: ['a'] });
    expect(req?.method).toBe('POST');
    expect(req?.path).toBe('/api/learn');
    expect(req?.body).toEqual({ pattern: 'p', concepts: ['a'] });
  });

  test('bound seat: memoryOwnerRoot is forwarded from the seat env', () => {
    process.env.ORACLE_MEMORY_OWNER_ROOT = '/seat/owner/root';
    const req = proxyRequestForTool('oracle_learn', { pattern: 'p' });
    expect(req?.body).toEqual({ pattern: 'p', memoryOwnerRoot: '/seat/owner/root' });
  });

  test('an explicit memoryOwnerRoot argument wins over the env', () => {
    process.env.ORACLE_MEMORY_OWNER_ROOT = '/seat/owner/root';
    const req = proxyRequestForTool('oracle_learn', { pattern: 'p', memoryOwnerRoot: '/explicit' });
    expect(req?.body).toEqual({ pattern: 'p', memoryOwnerRoot: '/explicit' });
  });

  test('other args-bodied tools do not gain the field', () => {
    process.env.ORACLE_MEMORY_OWNER_ROOT = '/seat/owner/root';
    const req = proxyRequestForTool('oracle_supersede', { oldId: 'a', newId: 'b' });
    expect(req?.body).toEqual({ oldId: 'a', newId: 'b' });
  });
});
