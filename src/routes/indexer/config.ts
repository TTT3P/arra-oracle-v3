import { Elysia } from 'elysia';
import { resolveOllamaBaseUrl } from '../../vector/embeddings.ts';
import { getEmbeddingModels } from '../../vector/factory.ts';

export const configEndpoint = new Elysia().get('/indexer/config', async () => {
  const models = getEmbeddingModels();

  const modelList = Object.entries(models).map(([key, m]) => ({
    key,
    model: m.model,
    collection: m.collection,
    adapter: m.adapter || 'lancedb',
    dims: key === 'nomic' ? 768 : key === 'bge-m3' ? 1024 : 4096,
    speed: key === 'nomic' ? '~100 doc/s' : key === 'bge-m3' ? '~50 doc/s' : '~30 doc/s',
  }));

  const adapters = ['lancedb', 'sqlite-vec', 'chroma', 'qdrant', 'cloudflare-vectorize'];

  let ollamaModels: string[] = [];
  try {
    // Same resolver as the embedder (OLLAMA_BASE_URL / OLLAMA_HOST): a hardcoded
    // localhost:11434 hid every model behind a tunnel or remote host (2026-08-30).
    const res = await fetch(`${resolveOllamaBaseUrl(process.env.OLLAMA_BASE_URL, process.env.OLLAMA_HOST)}/api/tags`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (res.ok) {
      const data = await res.json() as { models?: Array<{ name: string }> };
      ollamaModels = (data.models || []).map(m => m.name);
    }
  } catch {}

  return { adapters, models: modelList, ollamaModels };
}, {
  detail: {
    tags: ['indexer'],
    menu: { group: 'tools', order: 110 },
    summary: 'Indexer configuration — adapters, models, Ollama status',
  },
});
