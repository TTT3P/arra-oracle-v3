/**
 * HTTP idle timeout for Bun.serve (OM-BL-2026-09-09-01).
 *
 * Bun closes a connection that has sent no bytes for `idleTimeout` seconds — default 10 s. A synchronous
 * FTS5 scan on the single event loop can exceed that, so clients saw `socket closed unexpectedly`
 * (http=000 at ~12 s) while the server went on to finish the work. Bun caps the value at 255 s.
 */
export const HTTP_IDLE_TIMEOUT_ENV = 'ORACLE_HTTP_IDLE_TIMEOUT_S';
export const BUN_MAX_IDLE_TIMEOUT_S = 255;
export const DEFAULT_HTTP_IDLE_TIMEOUT_S = BUN_MAX_IDLE_TIMEOUT_S;

export function httpIdleTimeoutSeconds(raw = process.env[HTTP_IDLE_TIMEOUT_ENV]): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_HTTP_IDLE_TIMEOUT_S;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_HTTP_IDLE_TIMEOUT_S;
  return Math.min(BUN_MAX_IDLE_TIMEOUT_S, Math.floor(n));
}
