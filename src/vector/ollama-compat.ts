/**
 * Endpoint compatibility gate for the Ollama URL fallback chain
 * (Riddler PR#11 round 2 #1 — silent-corruption guard).
 *
 * Two Ollama endpoints can both advertise the same model NAME while serving
 * different weights (different digest → different embedding space). Vectors
 * from a mismatched fallback would silently corrupt the store. The gate
 * verifies the fallback's model digest EQUALS the primary's before any
 * fallback embed is accepted, and fails closed when it cannot verify
 * (primary digest unknown, endpoint unreachable, model absent).
 *
 * The primary digest is learned opportunistically (prewarm at chain build,
 * retried on demand) and kept for the process lifetime once learned — so a
 * later primary outage does not un-verify an already-proven fallback.
 */

type TagsResponse = { models?: Array<{ name?: string; digest?: string }> };

export async function fetchModelDigest(baseUrl: string, model: string, timeoutMs = 5_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    if (!response.ok) return null;
    const data = await response.json() as TagsResponse;
    const wanted = model.includes(':') ? [model] : [model, `${model}:latest`];
    const entry = data.models?.find((m) => m.name && wanted.includes(m.name));
    return entry?.digest || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class OllamaCompatGate {
  private primaryDigest: string | null = null;
  private verified = false;

  constructor(
    private readonly primaryUrl: string,
    private readonly fallbackUrl: string,
    private readonly model: string,
    private readonly fetchDigest: typeof fetchModelDigest = fetchModelDigest,
    private readonly logger: (message: string) => void = (message) => console.info(message),
  ) {}

  /** Learn the primary digest while the primary is healthy; never throws. */
  async prewarm(): Promise<void> {
    if (this.primaryDigest) return;
    this.primaryDigest = await this.fetchDigest(this.primaryUrl, this.model).catch(() => null);
  }

  /** Throws unless the fallback endpoint provably serves the primary's model. */
  async ensure(): Promise<void> {
    if (this.verified) return;
    if (!this.primaryDigest) await this.prewarm();
    if (!this.primaryDigest) {
      throw new Error(`fallback '${this.fallbackUrl}' unverifiable: primary model digest for '${this.model}' was never learned — refusing fallback (fail-closed)`);
    }
    const fallbackDigest = await this.fetchDigest(this.fallbackUrl, this.model);
    if (!fallbackDigest) {
      throw new Error(`fallback '${this.fallbackUrl}' unverifiable: cannot read model digest for '${this.model}' — refusing fallback (fail-closed)`);
    }
    if (fallbackDigest !== this.primaryDigest) {
      throw new Error(`fallback '${this.fallbackUrl}' serves a DIFFERENT '${this.model}' (digest ${short(fallbackDigest)} ≠ primary ${short(this.primaryDigest)}) — refusing fallback (fail-closed)`);
    }
    this.verified = true;
    this.logger(`[EmbedderChain] fallback ${this.fallbackUrl} verified: '${this.model}' digest ${short(fallbackDigest)} matches primary`);
  }
}

function short(digest: string): string {
  return digest.slice(0, 12);
}
