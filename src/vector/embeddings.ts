import type { EmbeddingProvider, EmbeddingProviderType, EmbedType } from './types.ts';
import { NoneEmbeddings, RemoteHttpEmbeddings } from './embedding-backends.ts';
import { degradedTimeoutMs, isEmbedderRuntimeDegraded } from './embedder-runtime-state.ts';
import { EmbeddingFallbackChain } from './fallback-chain.ts';
import { createOllamaEmbedderWithUrlFallback } from './ollama-url-chain.ts';
import { GeminiEmbeddings } from './providers/gemini.ts';
import { OpenAIEmbeddings } from './providers/openai.ts';
export { GeminiEmbeddings } from './providers/gemini.ts';
export { OpenAIEmbeddings };
export type FallbackEvent = { from: string; to?: string; error: string };
export type EmbeddingProviderOptions = { url?: string; dimensions?: number; fallbackChain?: EmbeddingProviderType[]; fallback?: EmbeddingProviderType; fastFail?: boolean };
export class ChromaDBInternalEmbeddings implements EmbeddingProvider {
  readonly name = 'chromadb-internal';
  readonly dimensions = 384; // all-MiniLM-L6-v2 default
  async embed(_texts: string[], _type?: EmbedType): Promise<number[][]> {
    throw new Error('ChromaDB handles embeddings internally. Use addDocuments() directly.');
  }
}
export class OllamaEmbeddings implements EmbeddingProvider {
  readonly name: string;
  dimensions: number;
  private baseUrl: string;
  private model: string;
  private _dimensionsDetected = false;
  private attempts: number;
  private retryDelayMs: number;
  private batchSize: number;
  private timeoutMs: number;
  /**
   * Ollama unloads a model after its keep-alive (default 5 min) — the next embed
   * cold-loads bge-m3 for several seconds, the boot probe times out and search
   * degrades to FTS-only until it warms (2026-08-29 CROO diagnosis). Pin it.
   * ORACLE_EMBED_KEEP_ALIVE accepts Ollama's forms: an integer (seconds; -1 = forever,
   * sent as a NUMBER — Ollama rejects "-1" as a string: 'missing unit in duration')
   * or a Go duration string ('30m', '24h').
   */
  private keepAlive: number | string;
  /** When runtime status is already degraded, skip retries and clamp the
   *  timeout — 3×30 s retries amplified the 08-31 outage into 24–112 s searches. */
  private fastFailWhenDegraded: boolean;
  /** KNOWN model dim, if any — responses that disagree are REJECTED, never adopted. */
  private declaredDims: number | undefined;
  constructor(config: { baseUrl?: string; model?: string; label?: string; fastFail?: boolean } = {}) {
    this.baseUrl = resolveOllamaBaseUrl(config.baseUrl, process.env.OLLAMA_BASE_URL, process.env.OLLAMA_HOST);
    this.name = config.label || 'ollama';
    this.fastFailWhenDegraded = config.fastFail ?? fastFailDefaultFromEnv();
    this.model = config.model || 'nomic-embed-text';
    this.attempts = positiveInt(process.env.ORACLE_EMBED_ATTEMPTS, 3);
    this.retryDelayMs = positiveInt(process.env.ORACLE_EMBED_RETRY_DELAY_MS, 150);
    this.batchSize = positiveInt(process.env.ORACLE_EMBED_BATCH_SIZE, 50);
    this.timeoutMs = positiveInt(process.env.ORACLE_EMBED_TIMEOUT_MS, 30_000);
    this.keepAlive = parseKeepAlive(process.env.ORACLE_EMBED_KEEP_ALIVE);
    this.declaredDims = KNOWN_DIMS[this.model];
    this.dimensions = this.declaredDims || 768;
  }
  async embed(texts: string[], type?: EmbedType, signal?: AbortSignal): Promise<number[][]> {
    const prepared = texts.map(text => this.prepareText(text, type));
    const embeddings: number[][] = [];
    for (let i = 0; i < prepared.length; i += this.batchSize) {
      const batch = prepared.slice(i, i + this.batchSize);
      const data = await this.embedBatchWithRetry(batch, signal);
      this.assertDimensions(data.embeddings);
      embeddings.push(...data.embeddings);
    }
    return embeddings;
  }
  /** Silent-corruption guard: wrong-sized vectors are rejected, not stored. */
  private assertDimensions(vectors: number[][]): void {
    const expected = this.declaredDims ?? (this._dimensionsDetected ? this.dimensions : vectors[0]?.length);
    for (const vector of vectors) {
      if (expected !== undefined && vector.length !== expected) {
        throw new Error(`Ollama endpoint ${this.baseUrl} returned a ${vector.length}-dim vector for model '${this.model}' (expected ${expected}) — rejected by dimension guard`);
      }
    }
    if (!this._dimensionsDetected && vectors[0]?.length) {
      if (this.declaredDims === undefined) this.dimensions = vectors[0].length;
      this._dimensionsDetected = true;
    }
  }
  private prepareText(text: string, type?: EmbedType): string {
    let truncated = text.length > 2000 ? text.slice(0, 2000) : text;
    const isQwen3 = this.model.includes('qwen3-embedding');
    const isE5 = this.model.includes('multilingual-e5') || this.model.includes('/e5-');
    const isBge = this.model.includes('bge');
    if (type === 'query') {
      if (isQwen3) {
        truncated = `Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ${truncated}`;
      } else if (isBge || isE5) {
        truncated = `query: ${truncated}`;
      }
    } else if (type === 'passage') {
      if (isBge || isE5) {
        truncated = `passage: ${truncated}`;
      }
    }
    return truncated;
  }
  private async embedBatchWithRetry(input: string[], signal?: AbortSignal): Promise<{ embeddings: number[][] }> {
    let lastError: unknown;
    const fastFail = this.fastFailWhenDegraded && isEmbedderRuntimeDegraded();
    const attempts = fastFail ? 1 : this.attempts;
    const timeoutMs = fastFail ? Math.min(this.timeoutMs, degradedTimeoutMs()) : this.timeoutMs;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (signal?.aborted) throw new Error('embed aborted by caller');
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort);
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${this.baseUrl}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, input, keep_alive: this.keepAlive }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Ollama API error (${response.status}): ${error}`);
        }
        const data = await response.json() as { embeddings?: number[][]; embedding?: number[] };
        const embeddings = data.embeddings ?? (data.embedding ? [data.embedding] : undefined);
        if (!embeddings || embeddings.length !== input.length) {
          throw new Error(`Ollama returned ${embeddings?.length ?? 0} embeddings for ${input.length} inputs`);
        }
        return { embeddings };
      } catch (err) {
        lastError = err;
        if (signal?.aborted) break; // caller cancelled — no point retrying
        if (attempt < attempts) await sleep(this.retryDelayMs * attempt);
      } finally {
        signal?.removeEventListener('abort', onAbort);
        clearTimeout(timeout);
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Ollama embedding failed after ${attempts} attempts: ${message}`, { cause: lastError });
  }
}
const KNOWN_DIMS: Record<string, number> = {
  'nomic-embed-text': 768,
  'qwen3-embedding': 1024,
  'qwen3-embedding:0.6b': 1024,
  'qwen3-embedding:4b': 2560,
  'qwen3-embedding:8b': 4096,
  'bge-m3': 1024,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
  'qllama/multilingual-e5-large-instruct': 1024,
  'qllama/multilingual-e5-large-instruct:latest': 1024,
  'multilingual-e5-large': 1024,
  'multilingual-e5-large-instruct': 1024,
  'snowflake-arctic-embed2': 1024,
};
/** fast-fail is env-armed so a deploy without env is a true no-op (Riddler PR#11 r2 #2):
 *  ORACLE_EMBED_FASTFAIL_WHEN_DEGRADED=1/0 wins; else on iff the URL-fallback env is set. */
function fastFailDefaultFromEnv(): boolean {
  const raw = process.env.ORACLE_EMBED_FASTFAIL_WHEN_DEGRADED?.trim().toLowerCase();
  if (raw) return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  return Boolean(process.env.OLLAMA_FALLBACK_BASE_URLS?.trim());
}
export function parseKeepAlive(raw: string | undefined): number | string {
  const value = raw?.trim();
  if (!value) return -1;
  return /^-?\d+$/.test(value) ? Number(value) : value;
}
function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
/** Single resolver for the Ollama base URL: explicit → OLLAMA_BASE_URL → OLLAMA_HOST → localhost:11434. */
export function resolveOllamaBaseUrl(...values: Array<string | undefined>): string {
  const raw = values.map((value) => value?.trim()).find(Boolean) || 'http://localhost:11434';
  const trimmed = raw.replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
export class FallbackEmbeddings implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  private readonly chain: EmbeddingFallbackChain;
  constructor(
    providers: EmbeddingProvider[],
    private readonly onFallback: (event: FallbackEvent) => void = defaultFallbackLogger,
  ) {
    if (providers.length === 0) throw new Error('FallbackEmbeddings requires at least one provider');
    this.name = providers.map((provider) => provider.name).join('>');
    this.dimensions = providers[0].dimensions;
    this.chain = new EmbeddingFallbackChain(providers, {
      logger: () => undefined,
      onFallback: this.onFallback,
    });
  }
  async embed(texts: string[], type?: EmbedType): Promise<number[][]> {
    return this.chain.embed(texts, type);
  }
}
function defaultFallbackLogger(event: FallbackEvent): void {
  if (event.to) console.warn(`[EmbedderFallback] ${event.from} failed: ${event.error}; trying ${event.to}`);
  else console.warn(`[EmbedderFallback] ${event.from} failed: ${event.error}; no fallback provider left`);
}
export function createEmbeddingProvider(
  type: EmbeddingProviderType = 'none',
  model?: string,
  options: EmbeddingProviderOptions = {},
): EmbeddingProvider {
  const fallbacks = options.fallbackChain ?? (options.fallback ? [options.fallback] : []);
  const chain = [type, ...fallbacks].filter((item, index, all) =>
    item !== 'none' && all.indexOf(item) === index
  );
  if (chain.length > 1) return new FallbackEmbeddings(chain.map((item) => createSingleEmbeddingProvider(item, model, options)));
  return createSingleEmbeddingProvider(type, model, options);
}
function createSingleEmbeddingProvider(
  type: EmbeddingProviderType,
  model?: string,
  options: { url?: string; dimensions?: number; fastFail?: boolean } = {},
): EmbeddingProvider {
  switch (type) {
    case 'none':
      return new NoneEmbeddings();
    case 'local':
    case 'ollama':
      return createOllamaEmbedderWithUrlFallback({ model, baseUrl: options.url, fastFail: options.fastFail });
    case 'remote':
      return new RemoteHttpEmbeddings({ model, url: options.url, dimensions: options.dimensions });
    case 'openai':
      return new OpenAIEmbeddings({ model });
    case 'gemini':
      return new GeminiEmbeddings({ model });
    case 'cloudflare-ai': {
      const { CloudflareAIEmbeddings } = require('./adapters/cloudflare-vectorize.ts');
      return new CloudflareAIEmbeddings({
        model,
        accountId: process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID,
        apiToken: process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN,
      });
    }
    case 'chromadb-internal':
    default:
      return new ChromaDBInternalEmbeddings();
  }
}
