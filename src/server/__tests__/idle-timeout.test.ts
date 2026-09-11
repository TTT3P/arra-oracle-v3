import { describe, expect, test } from 'bun:test';
import { BUN_MAX_IDLE_TIMEOUT_S, DEFAULT_HTTP_IDLE_TIMEOUT_S, httpIdleTimeoutSeconds } from '../idle-timeout.ts';

describe('httpIdleTimeoutSeconds', () => {
  test('defaults to the Bun maximum (255 s) so a slow synchronous request is not cut at Bun\'s 10 s default', () => {
    expect(DEFAULT_HTTP_IDLE_TIMEOUT_S).toBe(255);
    expect(httpIdleTimeoutSeconds(undefined)).toBe(255);
    expect(httpIdleTimeoutSeconds('')).toBe(255);
    expect(httpIdleTimeoutSeconds('nope')).toBe(255);
    expect(httpIdleTimeoutSeconds('0')).toBe(255);
    expect(httpIdleTimeoutSeconds('-5')).toBe(255);
  });
  test('honours explicit values and clamps to the Bun maximum', () => {
    expect(httpIdleTimeoutSeconds('30')).toBe(30);
    expect(httpIdleTimeoutSeconds('30.9')).toBe(30);
    expect(httpIdleTimeoutSeconds('1000')).toBe(BUN_MAX_IDLE_TIMEOUT_S);
  });
  test('Bun.serve accepts the default value', () => {
    const server = Bun.serve({ port: 0, idleTimeout: httpIdleTimeoutSeconds(undefined), fetch: () => new Response('ok') });
    try { expect(server.port).toBeGreaterThan(0); } finally { server.stop(true); }
  });
});
