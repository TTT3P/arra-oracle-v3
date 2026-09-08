/**
 * OM-BL-2026-09-08-03: the owner-core request log carries the caller's seat identity when the
 * request claims one, in both the structured entry and the nginx-style line; a request without
 * the headers logs exactly as before.
 */
import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { formatRequestLog } from '../../../src/middleware/logger.ts';
import { createRequestLoggingMiddleware, type StructuredRequestLogEntry } from '../../../src/middleware/request-logger.ts';
import { SEAT_CWD_HEADER, SEAT_HEADER, SEAT_PROFILE_HEADER, SEAT_TOOL_HEADER } from '../../../src/middleware/seat-identity.ts';

async function firstLog(logs: StructuredRequestLogEntry[]) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (logs[0]) return logs[0];
    await Bun.sleep(5);
  }
  throw new Error('request log was not emitted');
}

function app(logs: StructuredRequestLogEntry[]) {
  return new Elysia()
    .use(createRequestLoggingMiddleware({ log: (entry) => logs.push(entry), now: () => 0, timestamp: () => 't' }))
    .get('/api/search', () => ({ ok: true }));
}

describe('request log carries the seat identity', () => {
  test('seat headers land in the structured entry', async () => {
    const logs: StructuredRequestLogEntry[] = [];
    await app(logs).handle(new Request('http://local/api/search?q=x', {
      headers: { [SEAT_HEADER]: 'erpproject', [SEAT_PROFILE_HEADER]: 'owner', [SEAT_CWD_HEADER]: '/Users/x/erpproject-oracle', [SEAT_TOOL_HEADER]: 'oracle_search' },
    }));
    const entry = await firstLog(logs);
    expect(entry.seat).toEqual({ seat: 'erpproject', profile: 'owner', cwd: '/Users/x/erpproject-oracle', tool: 'oracle_search' });
    expect(formatRequestLog(entry, 'nginx')).toBe(
      `GET /api/search 200 0ms [${entry.correlationId.slice(0, 8)}] [${entry.sandbox}] [seat=erpproject profile=owner tool=oracle_search cwd=/Users/x/erpproject-oracle]`,
    );
    expect(JSON.parse(formatRequestLog(entry, 'json')).seat.seat).toBe('erpproject');
  });

  test('profile/cwd/tool without a seat name are ignored; no headers = no seat field', async () => {
    const logs: StructuredRequestLogEntry[] = [];
    await app(logs).handle(new Request('http://local/api/search', { headers: { [SEAT_PROFILE_HEADER]: 'owner', [SEAT_TOOL_HEADER]: 'oracle_search' } }));
    const orphan = await firstLog(logs);
    expect(orphan.seat).toBeUndefined();
    expect(formatRequestLog(orphan, 'nginx')).not.toContain('seat=');

    const plain: StructuredRequestLogEntry[] = [];
    await app(plain).handle(new Request('http://local/api/search'));
    expect((await firstLog(plain)).seat).toBeUndefined();
  });

  test('a header injection attempt is neutralised before it reaches the log line', async () => {
    const logs: StructuredRequestLogEntry[] = [];
    await app(logs).handle(new Request('http://local/api/search', { headers: { [SEAT_HEADER]: 'croo\tfake=1' } }));
    const entry = await firstLog(logs);
    expect(entry.seat?.seat).toBe('croo\tfake=1'.replace(/[\r\n]/g, ' '));
    expect(formatRequestLog(entry, 'nginx').split('\n')).toHaveLength(1);
  });
});
