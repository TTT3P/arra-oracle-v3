import { afterEach, describe, expect, it } from 'bun:test';
import { clearEmbedderRuntimeStatus } from '../embedder-runtime-state.ts';
import { createOllamaEmbedderWithUrlFallback, resolveOllamaFallbackUrls } from '../ollama-url-chain.ts';

const ENV_KEYS = [
  'OLLAMA_BASE_URL', 'OLLAMA_HOST', 'OLLAMA_FALLBACK_BASE_URLS',
  'ORACLE_EMBED_ATTEMPTS', 'ORACLE_EMBED_RETRY_DELAY_MS', 'ORACLE_EMBED_COOLDOWN_MS',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalInfo = console.info;
const originalWarn = console.warn;

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  globalThis.fetch = originalFetch;
  console.info = originalInfo;
  console.warn = originalWarn;
  clearEmbedderRuntimeStatus();
});

const DIM = 1024; // bge-m3 declared dims — mocks must be dimension-honest
const DIGEST = 'sha256:primary-weights';
type FleetState = { primaryUp: boolean; backupDigest?: string; backupDim?: number; calls: string[] };

/** Mock BOTH endpoints' /api/tags (digest gate) and /api/embed. */
function mockFleet(state: FleetState): void {
  globalThis.fetch = (async (url, init) => {
    const u = String(url);
    state.calls.push(u);
    const isPrimary = u.startsWith('http://primary:1');
    if (isPrimary && !state.primaryUp) throw new Error('ECONNREFUSED');
    if (u.includes('/api/tags')) {
      const digest = isPrimary ? DIGEST : (state.backupDigest ?? DIGEST);
      return Response.json({ models: [{ name: 'bge-m3:latest', digest }] });
    }
    const { input } = JSON.parse(String(init?.body)) as { input: string[] };
    const dim = isPrimary ? DIM : (state.backupDim ?? DIM);
    return Response.json({ embeddings: input.map(() => Array.from({ length: dim }, () => 0.1)) });
  }) as typeof fetch;
}

function chainEnv(): void {
  process.env.OLLAMA_BASE_URL = 'http://primary:1';
  process.env.OLLAMA_FALLBACK_BASE_URLS = 'http://backup:2';
  process.env.ORACLE_EMBED_ATTEMPTS = '1';
  process.env.ORACLE_EMBED_RETRY_DELAY_MS = '1';
  process.env.ORACLE_EMBED_COOLDOWN_MS = '60000';
  delete process.env.OLLAMA_HOST;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('createOllamaEmbedderWithUrlFallback (TINE 2026-08-31 fallback chain)', () => {
  it('falls back to a digest-verified URL and logs the serving endpoint', async () => {
    chainEnv();
    const state: FleetState = { primaryUp: true, calls: [] };
    mockFleet(state);
    const infoLines: string[] = [];
    console.info = (...args: unknown[]) => { infoLines.push(args.join(' ')); };
    console.warn = () => undefined;

    const embedder = createOllamaEmbedderWithUrlFallback({ model: 'bge-m3' });
    await settle(); // prewarm learns the primary digest while it is up
    state.primaryUp = false;

    const vectors = await embedder.embed(['hello'], 'passage');
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(DIM);
    expect(state.calls.some((u) => u.startsWith('http://backup:2') && u.includes('/api/embed'))).toBe(true);
    expect(infoLines.join('\n')).toContain("served by 'ollama(http://backup:2)'");
    expect(infoLines.join('\n')).toContain('digest');
  });

  it('skips the dead primary during cooldown on subsequent embeds', async () => {
    chainEnv();
    const state: FleetState = { primaryUp: true, calls: [] };
    mockFleet(state);
    console.info = () => undefined;
    console.warn = () => undefined;

    const embedder = createOllamaEmbedderWithUrlFallback({ model: 'bge-m3' });
    await settle();
    state.primaryUp = false;
    await embedder.embed(['a'], 'passage');
    state.calls.length = 0;
    await embedder.embed(['b'], 'passage');

    const embedCalls = state.calls.filter((u) => u.includes('/api/embed'));
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]!.startsWith('http://backup:2')).toBe(true);
  });

  it('REFUSES a fallback whose model digest differs from the primary (fail-closed)', async () => {
    chainEnv();
    const state: FleetState = { primaryUp: true, backupDigest: 'sha256:other-weights', calls: [] };
    mockFleet(state);
    console.info = () => undefined;
    console.warn = () => undefined;

    const embedder = createOllamaEmbedderWithUrlFallback({ model: 'bge-m3' });
    await settle();
    state.primaryUp = false;

    await expect(embedder.embed(['hello'], 'passage')).rejects.toThrow('DIFFERENT');
    // the mismatched backup must never have served an embed
    expect(state.calls.some((u) => u.startsWith('http://backup:2') && u.includes('/api/embed'))).toBe(false);
  });

  it('REFUSES fallback when the primary digest was never learned (unverifiable)', async () => {
    chainEnv();
    const state: FleetState = { primaryUp: false, calls: [] }; // primary dead from t0
    mockFleet(state);
    console.info = () => undefined;
    console.warn = () => undefined;

    const embedder = createOllamaEmbedderWithUrlFallback({ model: 'bge-m3' });
    await expect(embedder.embed(['hello'], 'passage')).rejects.toThrow('unverifiable');
    expect(state.calls.some((u) => u.startsWith('http://backup:2') && u.includes('/api/embed'))).toBe(false);
  });

  it('REJECTS wrong-dimension vectors from a digest-matching fallback (dimension guard)', async () => {
    chainEnv();
    const state: FleetState = { primaryUp: true, backupDim: 2, calls: [] };
    mockFleet(state);
    console.info = () => undefined;
    console.warn = () => undefined;

    const embedder = createOllamaEmbedderWithUrlFallback({ model: 'bge-m3' });
    await settle();
    state.primaryUp = false;

    await expect(embedder.embed(['hello'], 'passage')).rejects.toThrow('dimension guard');
  });

  it('returns a plain single-endpoint embedder when no fallback URLs are set', () => {
    delete process.env.OLLAMA_FALLBACK_BASE_URLS;
    process.env.OLLAMA_BASE_URL = 'http://primary:1';
    const embedder = createOllamaEmbedderWithUrlFallback({ model: 'bge-m3' });
    expect(embedder.name).toBe('ollama');
  });

  it('dedupes a fallback URL equal to the primary', () => {
    process.env.OLLAMA_BASE_URL = 'http://primary:1';
    process.env.OLLAMA_FALLBACK_BASE_URLS = 'http://primary:1';
    const embedder = createOllamaEmbedderWithUrlFallback({ model: 'bge-m3' });
    expect(embedder.name).toBe('ollama');
  });

  it('parses and normalizes OLLAMA_FALLBACK_BASE_URLS', () => {
    expect(resolveOllamaFallbackUrls({ OLLAMA_FALLBACK_BASE_URLS: ' host-a:11434 , http://b:1/ ' }))
      .toEqual(['http://host-a:11434', 'http://b:1']);
    expect(resolveOllamaFallbackUrls({})).toEqual([]);
  });
});
