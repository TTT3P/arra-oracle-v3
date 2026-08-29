/**
 * Origin/lifecycle log for `POST /api/indexer/reindex`.
 *
 * Incident 2026-08-29: 114 reindex POSTs in 21 h starved the event loop and
 * the nginx-style request log carries neither timestamp nor caller, so the
 * source could not be named. One `[reindex]` line per lifecycle event
 * (start / refused / complete / error) with wall-clock time and a bounded
 * caller fingerprint answers "who" on the next occurrence.
 *
 * Log boundary (Riddler P1-1, PR #5 verdict 2026-08-29): nothing caller-
 * controlled reaches the log verbatim. UA → product family + 8-hex fingerprint,
 * forwarded-for → 8-hex fingerprint only (no raw IP), seat → `claimed_seat`
 * (a request claim, never authenticated identity) sanitised to 32 chars,
 * correlation id → 8 chars, repoRoot → `<hash8>:<basename>` (no absolute path),
 * error → class/code (no message). Every field has a fixed maximum size.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

export const FIELD_MAX = { ua: 34, xff_fp: 8, claimed_seat: 32, cid: 8, repo: 49, error: 40 } as const;
const ALLOWED = /[^A-Za-z0-9 ._/:;,()+=@-]/g;
// A bearer/basic credential, or any opaque run long enough to be a token/key.
const CREDENTIAL = /\b(bearer|basic|token)\s+\S+/gi;
const OPAQUE_RUN = /[A-Za-z0-9_-]{20,}/g;
const REDACTED = '[redacted]';

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/** Allowlist charset, redact token-like content, cap length. Never throws. */
export function sanitizeLogField(value: string | null | undefined, max: number): string {
  if (value === null || value === undefined) return '-';
  // Allowlist first so the redaction markers below survive it.
  let out = String(value)
    .replace(ALLOWED, '?')
    .replace(CREDENTIAL, (_m, kind: string) => `${kind} ${REDACTED}`)
    .replace(OPAQUE_RUN, REDACTED);
  if (out.length > max) out = `${out.slice(0, max - 1)}…`;
  return out === '' ? '-' : out;
}

/** `curl#3f2a9c1d` — product family (before the first `/`) plus a fingerprint of the full UA. */
export function describeUserAgent(ua: string | null): string {
  if (!ua) return '-';
  const family = sanitizeLogField(ua.split('/')[0].trim().slice(0, 24), 25).replace(/…$/, '');
  return `${family}#${fingerprint(ua)}`;
}

/** `<sha256 first 8>:<basename>` — locatable by an operator, not a path disclosure. */
export function describeRepoRoot(repoRoot: string): string {
  return `${fingerprint(repoRoot)}:${sanitizeLogField(path.basename(repoRoot), 40)}`;
}

/** Error class + code only; the message (which may embed paths/input) stays out of the log. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    const name = sanitizeLogField(err.name, 24);
    return code ? `${name}/${sanitizeLogField(String(code), 15)}` : name;
  }
  return sanitizeLogField(typeof err, 12);
}

export function reindexOrigin(request: Request): Record<string, string> {
  const h = request.headers;
  const xff = h.get('x-forwarded-for');
  return {
    ua: describeUserAgent(h.get('user-agent')),
    xff_fp: xff ? fingerprint(xff) : '-',
    claimed_seat: sanitizeLogField(h.get('x-oracle-seat') ?? h.get('x-maw-agent'), FIELD_MAX.claimed_seat),
    // First 8 chars only, taken BEFORE sanitising: a UUID would otherwise trip the opaque-run redaction.
    cid: sanitizeLogField((h.get('x-correlation-id') ?? h.get('x-request-id'))?.slice(0, FIELD_MAX.cid), FIELD_MAX.cid),
  };
}

export function reindexLogLine(event: string, fields: Record<string, unknown>): string {
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(v ?? '-')}`);
  return `[reindex] ts=${new Date().toISOString()} event=${event} ${parts.join(' ')}`;
}
