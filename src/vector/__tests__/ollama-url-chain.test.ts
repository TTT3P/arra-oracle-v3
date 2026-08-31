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

function primaryDownFetch(urls: string[]): typeof fetch {
  return (async (url) => {
    urls.push(String(url));
    if (String(url).includes('primary')) throw new Error('ECONNREFUSED');
    return Response.json({ embeddings: [[1, 2]] });
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

describe('createOllamaEmbedderWithUrlFallback (TINE 2026-08-31 fallback chain)', () => {
  it('falls back to the next URL and logs the serving endpoint', async () => {
    chainEnv();
    const urls: string[] = [];
    globalThis.fetch = primaryDownFetch(urls);
    const infoLines: string[] = [];
    console.info = (...args: unknown[]) => { infoLines.push(args.join(' ')); };
    console.warn = () => undefined;

    const embedder = createOllamaEmbedderWithUrlFallback({ model: 'bge-m3' });
    const vectors = await embedder.embed(['hello'], 'passage');

    expect(vectors).toEqual([[1, 2]]);
    expect(urls.some((url) => url.startsWith('http://primary:1'))).toBe(true);
    expect(urls.some((url) => url.startsWith('http://backup:2'))).toBe(true);
    expect(infoLines.join('\n')).toContain("served by 'ollama(http://backup:2)'");
  });

  it('skips the dead primary during cooldown on subsequent embeds', async () => {
    chainEnv();
    const urls: string[] = [];
    globalThis.fetch = primaryDownFetch(urls);
    console.info = () => undefined;
    console.warn = () => undefined;

    const embedder = createOllamaEmbedderWithUrlFallback({ model: 'bge-m3' });
    await embedder.embed(['a'], 'passage');
    urls.length = 0;
    await embedder.embed(['b'], 'passage');

    expect(urls).toHaveLength(1);
    expect(urls[0]!.startsWith('http://backup:2')).toBe(true);
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
