import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Client address of the request being served, captured once at the outermost
 * fetch (where Bun's server and the ORIGINAL Request object are available) and
 * carried through the request with AsyncLocalStorage.
 *
 * Why not `server.requestIP(request)` at the route: the fetch wrappers
 * (`middleware/timeout.ts`, `middleware/api-version.ts`) hand Elysia a cloned
 * Request, and Bun only knows the socket of the original one, so `requestIP`
 * returns null there — which used to be silently treated as loopback and made
 * every caller "local" for the web-auth bypass (audit 2026-09-05).
 *
 * `null` means "could not be resolved" and callers must treat that as NOT
 * local. The value is never taken from request headers.
 */
const store = new AsyncLocalStorage<string | null>();

export function resolveRemoteAddress(server: unknown, request: Request): string | null {
  try {
    const info = (server as { requestIP?: (r: Request) => { address?: unknown } | null } | null | undefined)?.requestIP?.(request);
    const address = info?.address;
    if (typeof address === 'string' && address.trim()) return address;
  } catch {
    // no socket / unsupported server object → unknown
  }
  return null;
}

export function runWithRemoteAddress<T>(address: string | null, callback: () => T): T {
  return store.run(address, callback);
}

/** Captured address for the current request; `undefined` outside a served request. */
export function currentRemoteAddress(): string | null | undefined {
  return store.getStore();
}
