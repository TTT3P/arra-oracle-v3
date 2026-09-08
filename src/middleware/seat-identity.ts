/**
 * Seat identity on the MCP → owner-core hop.
 *
 * The owner-core request log and audit_log were keyed by tenant/project/correlationId only,
 * so "which seat actually used oracle_search/read/learn" could not be answered from evidence
 * (CROO usage probe, 2026-09-08; OM-BL-2026-09-08-03). A proxying seat now sends four headers
 * — seat (from ORACLE_SEAT, exported by the launcher), profile (ORACLE_PROFILE), cwd, and the
 * MCP tool name — and the owner-core copies them into the structured request log and uses the
 * seat as the audit_log actor. Absent env = absent headers: unbound seats stay 'http'.
 */

export const SEAT_HEADER = 'x-oracle-seat';
export const SEAT_PROFILE_HEADER = 'x-oracle-profile';
export const SEAT_CWD_HEADER = 'x-oracle-cwd';
export const SEAT_TOOL_HEADER = 'x-oracle-tool';

export type SeatIdentity = {
  seat?: string;
  profile?: string;
  cwd?: string;
  tool?: string;
};

const MAX_HEADER_VALUE = 512;

/** Header-safe: no CR/LF (header injection), trimmed, bounded. Empty → undefined. */
export function seatHeaderValue(value: string | undefined | null): string | undefined {
  const cleaned = (value ?? '').replace(/[\r\n\0]+/g, ' ').trim().slice(0, MAX_HEADER_VALUE);
  return cleaned || undefined;
}

/** MCP side: the headers a proxied tool call carries, from the seat's own environment. */
export function seatIdentityHeaders(toolName: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Record<string, string> {
  const headers: Record<string, string> = {};
  const seat = seatHeaderValue(env.ORACLE_SEAT);
  if (!seat) return headers; // no seat name = no identity claim at all
  headers[SEAT_HEADER] = seat;
  const profile = seatHeaderValue(env.ORACLE_PROFILE);
  if (profile) headers[SEAT_PROFILE_HEADER] = profile;
  const safeCwd = seatHeaderValue(cwd);
  if (safeCwd) headers[SEAT_CWD_HEADER] = safeCwd;
  const tool = seatHeaderValue(toolName);
  if (tool) headers[SEAT_TOOL_HEADER] = tool;
  return headers;
}

/** Owner-core side: identity claimed by the request, undefined when no seat header is present. */
export function seatIdentityFromHeaders(headers: Headers): SeatIdentity | undefined {
  const seat = seatHeaderValue(headers.get(SEAT_HEADER));
  if (!seat) return undefined;
  const identity: SeatIdentity = { seat };
  const profile = seatHeaderValue(headers.get(SEAT_PROFILE_HEADER));
  const cwd = seatHeaderValue(headers.get(SEAT_CWD_HEADER));
  const tool = seatHeaderValue(headers.get(SEAT_TOOL_HEADER));
  if (profile) identity.profile = profile;
  if (cwd) identity.cwd = cwd;
  if (tool) identity.tool = tool;
  return identity;
}
