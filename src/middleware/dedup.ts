import { currentRemoteAddress } from './remote-address.ts';
import {
  LEGACY_TENANT_HEADER,
  ORG_HEADER,
  TENANT_API_KEY_HEADER,
  TENANT_HEADER,
  TENANT_TOKEN_HEADER,
} from './tenant.ts';

type FetchHandler = (request: Request) => Response | Promise<Response>;
type DedupKey = string | null;
type DedupKeyFn = (request: Request) => DedupKey;

type ResponseSnapshot = {
  body: ArrayBuffer | null;
  headers: [string, string][];
  status: number;
  statusText: string;
};

export type RequestDedupOptions = {
  key?: DedupKeyFn;
  store?: Map<string, Promise<ResponseSnapshot>>;
};

const COALESCED_METHODS = new Set(['GET', 'HEAD']);
const VARIANT_HEADERS = [
  'accept',
  'accept-encoding',
  'accept-language',
  'authorization',
  'cookie',
  'range',
  TENANT_HEADER,
  LEGACY_TENANT_HEADER,
  ORG_HEADER,
  TENANT_TOKEN_HEADER,
  TENANT_API_KEY_HEADER,
];
const defaultStore = new Map<string, Promise<ResponseSnapshot>>();

function variantScope(request: Request): string {
  return VARIANT_HEADERS.map((name) => `${name.toLowerCase()}:${request.headers.get(name) ?? ''}`).join('\n');
}

/**
 * Coalescing key. Bound to the trusted captured client address (Riddler PR#22):
 * a replayed response carries the first caller's authorization, so two callers
 * may share one only when they are the same socket address. A request whose
 * address is unknown (null) or that is not being served through the outer fetch
 * (undefined) is never coalesced — it runs its own route and auth guard.
 */
export function requestDedupKey(request: Request): DedupKey {
  const method = request.method.toUpperCase();
  if (!COALESCED_METHODS.has(method)) return null;
  const address = currentRemoteAddress();
  if (!address) return null;
  return `${method} ${request.url}\naddr:${address}\n${variantScope(request)}`;
}

async function responseSnapshot(response: Response): Promise<ResponseSnapshot> {
  return {
    body: response.body === null ? null : await response.arrayBuffer(),
    headers: [...response.headers.entries()],
    status: response.status,
    statusText: response.statusText,
  };
}

function snapshotResponse(snapshot: ResponseSnapshot): Response {
  const body = snapshot.body === null ? null : snapshot.body.slice(0);
  return new Response(body, {
    headers: snapshot.headers,
    status: snapshot.status,
    statusText: snapshot.statusText,
  });
}

export async function handleRequestDedup(
  request: Request,
  next: FetchHandler,
  options: RequestDedupOptions = {},
): Promise<Response> {
  const key = (options.key ?? requestDedupKey)(request);
  if (!key) return next(request);

  const store = options.store ?? defaultStore;
  const existing = store.get(key);
  if (existing) return snapshotResponse(await existing);

  const pending = Promise.resolve().then(() => next(request)).then(responseSnapshot);
  store.set(key, pending);

  try {
    return snapshotResponse(await pending);
  } finally {
    if (store.get(key) === pending) store.delete(key);
  }
}

export function createRequestDedupFetch(next: FetchHandler, options: RequestDedupOptions = {}): FetchHandler {
  const store = options.store ?? new Map<string, Promise<ResponseSnapshot>>();
  return (request) => handleRequestDedup(request, next, { ...options, store });
}
