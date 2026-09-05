/**
 * Auth routes — /api/auth/{status,login,logout}
 *
 * Shared session helpers live here so the settings/ and feed/ groups
 * can import them for their auth guards without an extra file.
 */

import { Elysia } from 'elysia';
import { createHmac, timingSafeEqual } from 'crypto';
import { getScopedSetting } from '../../db/scoped-settings.ts';
import { activeTenantId, DEFAULT_TENANT_ID } from '../../middleware/tenant.ts';
import { currentRemoteAddress, resolveRemoteAddress } from '../../middleware/remote-address.ts';
import { statusRoute } from './status.ts';
import { loginRoute } from './login.ts';
import { logoutRoute } from './logout.ts';

const SESSION_SECRET = process.env.ORACLE_SESSION_SECRET || crypto.randomUUID();
export const SESSION_COOKIE_NAME = 'oracle_session';
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
type SessionPayload = { exp: number; tenant: string };

/**
 * "Local" means the loopback interface only (audit 2026-09-05). The previous
 * RFC1918 whitelist (192.168/16, 10/8, 172.16/12) let any LAN or tailnet client
 * skip the password whenever `auth_local_bypass` was on.
 */
export function isLocalIp(ip: string): boolean {
  const value = ip.trim().toLowerCase();
  const normalized = value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

/**
 * Client address as Bun reports it, or null when it cannot be resolved (no
 * server handle — e.g. `app.fetch` outside `Bun.serve` — or `requestIP`
 * unavailable). Never a loopback default: an unknown address is not local.
 */
export function remoteAddress(server: any, request: Request): string | null {
  // Served requests: the address captured on the original Request (wrappers clone it).
  const captured = currentRemoteAddress();
  if (captured !== undefined) return captured;
  // Direct handler calls (tests, app.handle): ask the given server, unknown → null.
  return resolveRemoteAddress(server, request);
}

export function isLocalNetwork(server: any, request: Request): boolean {
  const address = remoteAddress(server, request);
  return address !== null && isLocalIp(address);
}

function signatureFor(value: string): string {
  return createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function safeCompare(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  return leftBuf.length === rightBuf.length && timingSafeEqual(leftBuf, rightBuf);
}

function encodePayload(payload: SessionPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodePayload(value: string): SessionPayload | null {
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof payload?.exp !== 'number' || typeof payload?.tenant !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

function verifyLegacySessionToken(token: string, tenantId: string): boolean {
  if (tenantId !== DEFAULT_TENANT_ID) return false;
  const colonIdx = token.indexOf(':');
  if (colonIdx === -1) return false;
  const expiresStr = token.substring(0, colonIdx);
  const signature = token.substring(colonIdx + 1);
  const expires = parseInt(expiresStr, 10);
  if (isNaN(expires) || expires < Date.now()) return false;

  return safeCompare(signature, signatureFor(expiresStr));
}

export function usablePassword(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  return value.trim().length > 0 ? value : null;
}

export async function passwordMatches(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

export function generateSessionToken(tenantId = activeTenantId()): string {
  const payload = encodePayload({ exp: Date.now() + SESSION_DURATION_MS, tenant: tenantId });
  return `v2.${payload}.${signatureFor(payload)}`;
}

export function verifySessionToken(token: string, tenantId = activeTenantId()): boolean {
  if (!token) return false;
  if (!token.startsWith('v2.')) return verifyLegacySessionToken(token, tenantId);

  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [, payloadPart, signature] = parts;
  if (!payloadPart || !signature || !safeCompare(signature, signatureFor(payloadPart))) return false;
  const payload = decodePayload(payloadPart);
  if (!payload || payload.exp < Date.now()) return false;
  return payload.tenant === tenantId;
}

export function isAuthenticated(
  server: any,
  request: Request,
  sessionValue: string | undefined,
): boolean {
  const authEnabled = getScopedSetting('auth_enabled') === 'true';
  if (!authEnabled) return true;

  const localBypass = getScopedSetting('auth_local_bypass') !== 'false';
  if (localBypass && isLocalNetwork(server, request)) return true;

  return verifySessionToken(sessionValue || '', activeTenantId());
}

export const authRoutes = new Elysia({ prefix: '/api/auth' })
  .use(statusRoute)
  .use(loginRoute)
  .use(logoutRoute);

export * from './model.ts';
