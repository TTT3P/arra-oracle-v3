/**
 * URL-level fallback for the Ollama embedder (TINE decision 2026-08-31):
 * the primary OLLAMA_BASE_URL (e.g. win GPU :11435) falls back to each URL in
 * OLLAMA_FALLBACK_BASE_URLS (comma-separated, e.g. Mac :11434) when it is down.
 * A failed endpoint is skipped for ORACLE_EMBED_COOLDOWN_MS and re-probed with
 * an ORACLE_EMBED_HALFOPEN_TIMEOUT_MS budget, so a dead primary costs its full
 * retry budget at most once per cooldown, and the chain returns to the primary
 * on its own once it answers again. Every endpoint switch is logged so pilot
 * measurements can attribute embeds to the backend that actually served them.
 */
import { EmbeddingFallbackChain } from './fallback-chain.ts';
import { OllamaEmbeddings, resolveOllamaBaseUrl } from './embeddings.ts';
import { OllamaCompatGate } from './ollama-compat.ts';
import type { EmbeddingProvider, EmbedType } from './types.ts';

export const DEFAULT_EMBED_COOLDOWN_MS = 60_000;
export const DEFAULT_HALFOPEN_TIMEOUT_MS = 2_500;

export type OllamaUrlChainConfig = { model?: string; baseUrl?: string; fastFail?: boolean };

export function resolveOllamaFallbackUrls(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.OLLAMA_FALLBACK_BASE_URLS?.trim();
  if (!raw) return [];
  return raw.split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolveOllamaBaseUrl(value));
}

export function ollamaEndpointLabel(baseUrl: string): string {
  return `ollama(${baseUrl})`;
}

export function createOllamaEmbedderWithUrlFallback(config: OllamaUrlChainConfig = {}): EmbeddingProvider {
  const primaryUrl = resolveOllamaBaseUrl(config.baseUrl, process.env.OLLAMA_BASE_URL, process.env.OLLAMA_HOST);
  const urls = [primaryUrl, ...resolveOllamaFallbackUrls()]
    .filter((url, index, all) => all.indexOf(url) === index);
  if (urls.length === 1) {
    return new OllamaEmbeddings({ model: config.model, baseUrl: primaryUrl, fastFail: config.fastFail });
  }
  const model = config.model || 'nomic-embed-text';
  const providers = urls.map((url, index) => {
    const inner = new OllamaEmbeddings({
      model: config.model,
      baseUrl: url,
      fastFail: config.fastFail,
      label: ollamaEndpointLabel(url),
    });
    if (index === 0) return inner; // primary needs no compat gate against itself
    // Silent-corruption guard: a fallback must PROVE it serves the primary's
    // model (same digest) before any of its vectors are accepted.
    const gate = new OllamaCompatGate(primaryUrl, url, model);
    void gate.prewarm(); // learn the primary digest while it is healthy
    return gatedProvider(inner, gate);
  });
  const chain = new EmbeddingFallbackChain(providers, {
    sticky: false, // always prefer the primary (win GPU) when it answers
    cooldownMs: cooldownMs(),
    halfOpenTimeoutMs: halfOpenTimeoutMs(),
    logger: () => undefined,
    onFallback: (event) => console.warn(
      event.to
        ? `[EmbedderChain] ${event.from} failed (${event.error}) → falling back to ${event.to}`
        : `[EmbedderChain] ${event.from} failed (${event.error}); no fallback endpoint left`,
    ),
  });
  return logEndpointSwitches(chain);
}

function gatedProvider(inner: OllamaEmbeddings, gate: OllamaCompatGate): EmbeddingProvider {
  return {
    name: inner.name,
    get dimensions() { return inner.dimensions; },
    async embed(texts: string[], type?: EmbedType, signal?: AbortSignal) {
      await gate.ensure(); // throws fail-closed on mismatch/unverifiable
      return inner.embed(texts, type, signal);
    },
  };
}

/** Log which endpoint serves embeds — only when it changes, never per call. */
function logEndpointSwitches(chain: EmbeddingFallbackChain): EmbeddingProvider {
  let lastServed = '';
  return {
    name: chain.name,
    get dimensions() { return chain.dimensions; },
    async embed(texts: string[], type?: EmbedType) {
      const vectors = await chain.embed(texts, type);
      const served = chain.getStats().lastProvider ?? chain.name;
      if (served !== lastServed) {
        console.info(`[EmbedderChain] embeddings now served by '${served}'`);
        lastServed = served;
      }
      return vectors;
    },
  };
}

function cooldownMs(): number {
  return nonNegativeInt(process.env.ORACLE_EMBED_COOLDOWN_MS, DEFAULT_EMBED_COOLDOWN_MS);
}

function halfOpenTimeoutMs(): number {
  return nonNegativeInt(process.env.ORACLE_EMBED_HALFOPEN_TIMEOUT_MS, DEFAULT_HALFOPEN_TIMEOUT_MS) || DEFAULT_HALFOPEN_TIMEOUT_MS;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
