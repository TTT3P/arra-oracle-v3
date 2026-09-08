/**
 * OM-BL-2026-09-08-03: a proxying seat tells the owner-core who it is. ORACLE_SEAT (exported by
 * the launcher) is the claim; profile, cwd and the tool name ride along. No ORACLE_SEAT = no
 * identity headers at all, so unbound seats look exactly as they did before.
 */
import { afterEach, expect, test } from 'bun:test';
import { SEAT_CWD_HEADER, SEAT_HEADER, SEAT_PROFILE_HEADER, SEAT_TOOL_HEADER, seatIdentityHeaders } from '../../src/middleware/seat-identity.ts';
import { captureProxyRequest } from './support/http-proxy.ts';

const saved = { seat: process.env.ORACLE_SEAT, profile: process.env.ORACLE_PROFILE };
afterEach(() => {
  if (saved.seat === undefined) delete process.env.ORACLE_SEAT; else process.env.ORACLE_SEAT = saved.seat;
  if (saved.profile === undefined) delete process.env.ORACLE_PROFILE; else process.env.ORACLE_PROFILE = saved.profile;
});

test('a seat with ORACLE_SEAT sends seat, profile, cwd and tool headers on every proxied call', async () => {
  process.env.ORACLE_SEAT = 'erpproject';
  process.env.ORACLE_PROFILE = 'owner';
  const captured = await captureProxyRequest('oracle_search', { query: 'who called' });
  expect(captured.headers).toMatchObject({
    [SEAT_HEADER]: 'erpproject',
    [SEAT_PROFILE_HEADER]: 'owner',
    [SEAT_CWD_HEADER]: process.cwd(),
    [SEAT_TOOL_HEADER]: 'oracle_search',
  });
  const learn = await captureProxyRequest('oracle_learn', { pattern: 'attributed write' });
  expect((learn.headers as Record<string, string>)[SEAT_TOOL_HEADER]).toBe('oracle_learn');
});

test('without ORACLE_SEAT no identity header is sent (legacy behaviour unchanged)', async () => {
  delete process.env.ORACLE_SEAT;
  process.env.ORACLE_PROFILE = 'owner';
  const captured = await captureProxyRequest('oracle_search', { query: 'anonymous' });
  const headers = captured.headers as Record<string, string>;
  for (const name of [SEAT_HEADER, SEAT_PROFILE_HEADER, SEAT_CWD_HEADER, SEAT_TOOL_HEADER]) {
    expect(headers[name]).toBeUndefined();
  }
});

test('header values are header-safe: CR/LF stripped, trimmed, bounded, empties dropped', () => {
  const headers = seatIdentityHeaders('oracle_read', { ORACLE_SEAT: '  croo\r\nx-injected: 1 ', ORACLE_PROFILE: '' } as NodeJS.ProcessEnv, '/tmp/'.padEnd(700, 'a'));
  expect(headers[SEAT_HEADER]).toBe('croo x-injected: 1');
  expect(headers[SEAT_PROFILE_HEADER]).toBeUndefined();
  expect(headers[SEAT_CWD_HEADER]?.length).toBe(512);
  expect(headers[SEAT_TOOL_HEADER]).toBe('oracle_read');
  expect(seatIdentityHeaders('oracle_read', { ORACLE_SEAT: '   ' } as NodeJS.ProcessEnv)).toEqual({});
});
