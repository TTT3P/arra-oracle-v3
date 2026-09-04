import { afterEach, describe, expect, it } from 'bun:test';
import { clearEmbedderRuntimeStatus, setEmbedderRuntimeStatus } from '../embedder-runtime-state.ts';
import { OllamaEmbeddings } from '../embeddings.ts';

const ENV_KEYS = [
  'ORACLE_EMBED_ATTEMPTS', 'ORACLE_EMBED_RETRY_DELAY_MS', 'ORACLE_EMBED_TIMEOUT_MS',
  'ORACLE_EMBED_DEGRADED_TIMEOUT_MS', 'OLLAMA_BASE_URL', 'OLLAMA_HOST',
  'ORACLE_EMBED_FASTFAIL_WHEN_DEGRADED', 'OLLAMA_FALLBACK_BASE_URLS',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  globalThis.fetch = originalFetch;
  clearEmbedderRuntimeStatus();
});

function markDegraded(): void {
  setEmbedderRuntimeStatus({
    status: 'degraded', provider: 'ollama', source: 'env', explicit: true,
    checkedAt: new Date().toISOString(), reason: 'test',
  });
}

describe('OllamaEmbeddings fast-fail while degraded (PR-B c)', () => {
  it('collapses retries to a single attempt when armed by env and degraded', async () => {
    process.env.ORACLE_EMBED_ATTEMPTS = '3';
    process.env.ORACLE_EMBED_RETRY_DELAY_MS = '1';
    process.env.ORACLE_EMBED_FASTFAIL_WHEN_DEGRADED = '1';
    markDegraded();
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; throw new Error('socket reset'); }) as typeof fetch;

    const embedder = new OllamaEmbeddings({ model: 'bge-m3' });
    await expect(embedder.embed(['hello'], 'passage')).rejects.toThrow('failed after 1 attempts');
    expect(calls).toBe(1);
  });

  it('keeps the full retry budget when fastFail is disabled (probe path)', async () => {
    process.env.ORACLE_EMBED_ATTEMPTS = '3';
    process.env.ORACLE_EMBED_RETRY_DELAY_MS = '1';
    markDegraded();
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; throw new Error('socket reset'); }) as typeof fetch;

    const embedder = new OllamaEmbeddings({ model: 'bge-m3', fastFail: false });
    await expect(embedder.embed(['hello'], 'passage')).rejects.toThrow('failed after 3 attempts');
    expect(calls).toBe(3);
  });

  it('keeps the full retry budget when the runtime is not degraded', async () => {
    process.env.ORACLE_EMBED_ATTEMPTS = '2';
    process.env.ORACLE_EMBED_RETRY_DELAY_MS = '1';
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; throw new Error('socket reset'); }) as typeof fetch;

    const embedder = new OllamaEmbeddings({ model: 'bge-m3' });
    await expect(embedder.embed(['hello'], 'passage')).rejects.toThrow('failed after 2 attempts');
    expect(calls).toBe(2);
  });

  it('is INERT without env: degraded but unarmed keeps the full retry budget (Riddler r2 #2)', async () => {
    delete process.env.ORACLE_EMBED_FASTFAIL_WHEN_DEGRADED;
    delete process.env.OLLAMA_FALLBACK_BASE_URLS;
    process.env.ORACLE_EMBED_ATTEMPTS = '3';
    process.env.ORACLE_EMBED_RETRY_DELAY_MS = '1';
    markDegraded();
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; throw new Error('socket reset'); }) as typeof fetch;

    const embedder = new OllamaEmbeddings({ model: 'bge-m3' });
    await expect(embedder.embed(['hello'], 'passage')).rejects.toThrow('failed after 3 attempts');
    expect(calls).toBe(3);
  });

  it('arms automatically when OLLAMA_FALLBACK_BASE_URLS is set (same env gate as the chain)', async () => {
    delete process.env.ORACLE_EMBED_FASTFAIL_WHEN_DEGRADED;
    process.env.OLLAMA_FALLBACK_BASE_URLS = 'http://backup:2';
    process.env.ORACLE_EMBED_ATTEMPTS = '3';
    process.env.ORACLE_EMBED_RETRY_DELAY_MS = '1';
    markDegraded();
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; throw new Error('socket reset'); }) as typeof fetch;

    const embedder = new OllamaEmbeddings({ model: 'bge-m3' });
    await expect(embedder.embed(['hello'], 'passage')).rejects.toThrow('failed after 1 attempts');
    expect(calls).toBe(1);
  });

  it('clamps the per-attempt timeout while armed and degraded', async () => {
    process.env.ORACLE_EMBED_ATTEMPTS = '3';
    process.env.ORACLE_EMBED_TIMEOUT_MS = '60000';
    process.env.ORACLE_EMBED_DEGRADED_TIMEOUT_MS = '10';
    process.env.ORACLE_EMBED_FASTFAIL_WHEN_DEGRADED = '1';
    markDegraded();
    globalThis.fetch = (async (_url, init) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
      return Response.json({ embeddings: [[1]] });
    }) as typeof fetch;

    const embedder = new OllamaEmbeddings({ model: 'bge-m3' });
    const started = Date.now();
    await expect(embedder.embed(['hello'], 'passage')).rejects.toThrow('failed after 1 attempts: aborted');
    expect(Date.now() - started).toBeLessThan(5_000); // nowhere near the 60 s budget
  });
});
