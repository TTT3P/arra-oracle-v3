import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { runWithRemoteAddress } from '../../../src/middleware/remote-address.ts';

// Coalescing is bound to the trusted client address (PR#22); these cases model one loopback caller.
const served = <T,>(fn: () => T): T => runWithRemoteAddress('127.0.0.1', fn);
import {
  createRequestDedupFetch,
  handleRequestDedup,
  requestDedupKey,
} from '../../../src/middleware/dedup.ts';
import {
  LEGACY_TENANT_HEADER,
  ORG_HEADER,
  TENANT_API_KEY_HEADER,
  TENANT_HEADER,
} from '../../../src/middleware/tenant.ts';

type Gate = { promise: Promise<void>; release: () => void };

function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    if (check()) return;
    await Bun.sleep(1);
  }
  throw new Error('condition was not met');
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://local${path}`, init);
}

function slowApp(block: Gate, hits: { count: number }) {
  return new Elysia()
    .get('/slow', async ({ request }) => {
      hits.count += 1;
      await block.promise;
      return Response.json({ hit: hits.count, url: request.url }, { headers: { 'x-hit': String(hits.count) } });
    })
    .post('/slow', async () => {
      hits.count += 1;
      await block.promise;
      return Response.json({ hit: hits.count });
    });
}

async function json(res: Response) {
  return await res.json() as Record<string, unknown>;
}

describe('request deduplication middleware', () => {
  test('coalesces duplicate in-flight GET requests to the same URL', async () => {
    const block = gate();
    const hits = { count: 0 };
    const app = slowApp(block, hits);
    const fetchDedup = createRequestDedupFetch((req) => app.handle(req));

    const first = served(() => fetchDedup(request('/slow?item=1')));
    await waitFor(() => hits.count === 1);
    const second = served(() => fetchDedup(request('/slow?item=1')));
    await Bun.sleep(1);

    expect(hits.count).toBe(1);
    block.release();
    const [a, b] = await Promise.all([first, second]);

    expect(hits.count).toBe(1);
    expect(a.headers.get('x-hit')).toBe('1');
    expect(b.headers.get('x-hit')).toBe('1');
    expect(await json(a)).toEqual(await json(b));
  });

  test('deduplicates only while the first matching request is in flight', async () => {
    let hits = 0;
    const app = new Elysia().get('/fast', () => Response.json({ hit: ++hits }));
    const fetchDedup = createRequestDedupFetch((req) => app.handle(req));

    const first = await served(() => fetchDedup(request('/fast')));
    const second = await served(() => fetchDedup(request('/fast')));

    expect(await json(first)).toEqual({ hit: 1 });
    expect(await json(second)).toEqual({ hit: 2 });
    expect(hits).toBe(2);
  });

  test('does not coalesce different URLs or unsafe methods', async () => {
    const block = gate();
    const hits = { count: 0 };
    const app = slowApp(block, hits);
    const fetchDedup = createRequestDedupFetch((req) => app.handle(req));

    const first = served(() => fetchDedup(request('/slow?item=1')));
    const second = served(() => fetchDedup(request('/slow?item=2')));
    const postA = served(() => fetchDedup(request('/slow?item=1', { method: 'POST' })));
    const postB = served(() => fetchDedup(request('/slow?item=1', { method: 'POST' })));
    await waitFor(() => hits.count === 4);

    block.release();
    await Promise.all([first, second, postA, postB]);

    expect(hits.count).toBe(4);
    expect(served(() => requestDedupKey(request('/slow')))).toContain('GET http://local/slow');
    expect(served(() => requestDedupKey(request('/slow')))).toContain('addr:127.0.0.1');
    expect(requestDedupKey(request('/slow'))).toBeNull(); // no captured address → never coalesced
    expect(served(() => requestDedupKey(request('/slow', { method: 'POST' })))).toBeNull();
  });

  test('keeps response variants isolated by key headers', async () => {
    const block = gate();
    const hits = { count: 0 };
    const app = slowApp(block, hits);
    const fetchDedup = createRequestDedupFetch((req) => app.handle(req));

    const plain = served(() => fetchDedup(request('/slow?item=1')));
    const gzip = served(() => fetchDedup(request('/slow?item=1', { headers: { 'Accept-Encoding': 'gzip' } })));
    const authorized = served(() => fetchDedup(request('/slow?item=1', { headers: { Authorization: 'Bearer one' } })));
    await waitFor(() => hits.count === 3);

    block.release();
    await Promise.all([plain, gzip, authorized]);

    expect(hits.count).toBe(3);
  });

  test('keeps HEAD and GET keys separate for the same URL', async () => {
    const block = gate();
    let hits = 0;
    const fetchDedup = createRequestDedupFetch(async (req) => {
      hits += 1;
      await block.promise;
      return new Response(req.method, { headers: { 'x-method': req.method } });
    });

    const get = served(() => fetchDedup(request('/same')));
    const head = served(() => fetchDedup(request('/same', { method: 'HEAD' })));
    await waitFor(() => hits === 2);
    block.release();
    const [getRes, headRes] = await Promise.all([get, head]);

    expect(hits).toBe(2);
    expect(getRes.headers.get('x-method')).toBe('GET');
    expect(headRes.headers.get('x-method')).toBe('HEAD');
  });

  test('allows a custom key function to opt out of coalescing', async () => {
    let hits = 0;
    const res = await served(() => handleRequestDedup(
      request('/custom'),
      () => Response.json({ hit: ++hits }),
      { key: () => null, store: new Map() },
    ));

    expect(await json(res)).toEqual({ hit: 1 });
    expect(hits).toBe(1);
  });

  test('keeps tenant selector variants isolated', async () => {
    const block = gate();
    const hits = { count: 0 };
    const app = slowApp(block, hits);
    const fetchDedup = createRequestDedupFetch((req) => app.handle(req));

    const tenantA = served(() => fetchDedup(request('/slow?item=tenant', { headers: { [TENANT_HEADER]: 'tenant-a' } })));
    const tenantB = served(() => fetchDedup(request('/slow?item=tenant', { headers: { [TENANT_HEADER]: 'tenant-b' } })));
    const legacyTenant = served(() => fetchDedup(request('/slow?item=tenant', { headers: { [LEGACY_TENANT_HEADER]: 'tenant-a' } })));
    const orgTenant = served(() => fetchDedup(request('/slow?item=tenant', { headers: { [ORG_HEADER]: 'tenant-a' } })));
    const apiKeyTenant = served(() => fetchDedup(request('/slow?item=tenant', { headers: { [TENANT_API_KEY_HEADER]: 'tenant-key' } })));
    await waitFor(() => hits.count === 5);

    block.release();
    await Promise.all([tenantA, tenantB, legacyTenant, orgTenant, apiKeyTenant]);

    expect(hits.count).toBe(5);
  });

  test('coalesces HEAD responses without materializing a body', async () => {
    const block = gate();
    let hits = 0;
    const fetchDedup = createRequestDedupFetch(async () => {
      hits += 1;
      await block.promise;
      return new Response(null, { status: 204, statusText: 'No Content', headers: { 'x-hit': String(hits) } });
    });

    const first = served(() => fetchDedup(request('/empty', { method: 'HEAD' })));
    await waitFor(() => hits === 1);
    const second = served(() => fetchDedup(request('/empty', { method: 'HEAD' })));
    block.release();
    const [a, b] = await Promise.all([first, second]);

    expect(hits).toBe(1);
    expect(a.status).toBe(204);
    expect(a.statusText).toBe('No Content');
    expect(b.headers.get('x-hit')).toBe('1');
    expect(await a.text()).toBe('');
    expect(await b.text()).toBe('');
  });

  test('clears in-flight entries when the upstream handler fails', async () => {
    const store = new Map();
    let hits = 0;
    const fail = () => {
      hits += 1;
      throw new Error('boom');
    };

    const first = served(() => handleRequestDedup(request('/fail'), fail, { store }));
    const second = served(() => handleRequestDedup(request('/fail'), fail, { store }));
    const results = await Promise.allSettled([first, second]);

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(hits).toBe(1);
    expect(store.size).toBe(0);

    await expect(served(() => handleRequestDedup(request('/open', { method: 'POST' }), fail, { store }))).rejects.toThrow('boom');
    expect(hits).toBe(2);
  });
});
