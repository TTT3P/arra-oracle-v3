/**
 * Shared mutable embedder runtime status — a leaf module so both the
 * config/probe layer (embedder-config.ts) and the embedding providers
 * (embeddings.ts) can read it without an import cycle.
 */
import type { EmbeddingProviderType } from './types.ts';

export type EmbeddingProviderSelection = {
  provider: EmbeddingProviderType;
  source: 'configured' | 'legacy-env' | 'env' | 'auto-default';
  explicit: boolean;
};

export type EmbedderRuntimeStatus = {
  status: 'unknown' | 'connected' | 'degraded';
  provider: EmbeddingProviderType;
  source: EmbeddingProviderSelection['source'];
  explicit: boolean;
  checkedAt?: string;
  reason?: string;
  consecutiveFailures?: number;
};

let runtimeStatus: EmbedderRuntimeStatus | null = null;

export function peekEmbedderRuntimeStatus(): EmbedderRuntimeStatus | null {
  return runtimeStatus;
}

export function setEmbedderRuntimeStatus(status: EmbedderRuntimeStatus): EmbedderRuntimeStatus {
  runtimeStatus = status;
  return status;
}

export function clearEmbedderRuntimeStatus(): void {
  runtimeStatus = null;
}

export function isEmbedderRuntimeDegraded(): boolean {
  return runtimeStatus?.status === 'degraded';
}

/** Per-attempt embed budget while the runtime is already degraded. */
export function degradedTimeoutMs(): number {
  const raw = process.env.ORACLE_EMBED_DEGRADED_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2_500;
}
