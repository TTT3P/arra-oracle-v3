/**
 * Endpoint compatibility gate for the Ollama URL fallback chain
 * (Riddler PR#11 rounds 2-3 — silent-corruption guard with bounded freshness).
 *
 * Two Ollama endpoints can both advertise the same model NAME while serving
 * different weights (different digest → different embedding space). Vectors
 * from a mismatched fallback would silently corrupt the store, so:
 *
 * - The fallback's digest must EQUAL the primary's before its embeds are
 *   accepted, and that proof EXPIRES: it is re-checked after
 *   ORACLE_EMBED_COMPAT_TTL_MS (default 30 s; 0 = every entry). A fallback
 *   whose digest drifts after a successful verification is refused on the
 *   next entry once the proof ages out — never grandfathered for process life.
 * - The primary anchor is re-read at the same cadence whenever reachable.
 *   If the primary's digest CHANGES, the gate re-baselines to the new digest,
 *   logs loudly, and invalidates the fallback proof (fail-closed until the
 *   fallback matches the NEW digest). Already-accepted embeds are history —
 *   the gate only governs future acceptance.
 * - Unverifiable (endpoint unreachable / model absent / anchor never learned)
 *   always refuses.
 */

type TagsResponse = { models?: Array<{ name?: string; digest?: string }> };

export const DEFAULT_COMPAT_TTL_MS = 30_000;

export function compatTtlMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.ORACLE_EMBED_COMPAT_TTL_MS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_COMPAT_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_COMPAT_TTL_MS;
}

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
  private primaryCheckedAt = 0;
  private verifiedDigest: string | null = null;
  private verifiedAt = 0;

  constructor(
    private readonly primaryUrl: string,
    private readonly fallbackUrl: string,
    private readonly model: string,
    private readonly fetchDigest: typeof fetchModelDigest = fetchModelDigest,
    private readonly logger: (message: string) => void = (message) => console.info(message),
    private readonly warn: (message: string) => void = (message) => console.warn(message),
  ) {}

  /** Learn the primary digest while the primary is healthy; never throws. */
  async prewarm(): Promise<void> {
    await this.refreshPrimaryAnchor(true);
  }

  /** Throws unless the fallback endpoint provably serves the primary's model NOW. */
  async ensure(): Promise<void> {
    const ttl = compatTtlMs();
    const now = Date.now();
    await this.refreshPrimaryAnchor(now - this.primaryCheckedAt >= ttl);
    if (!this.primaryDigest) {
      throw new Error(`fallback '${this.fallbackUrl}' unverifiable: primary model digest for '${this.model}' was never learned — refusing fallback (fail-closed)`);
    }
    const proofFresh = this.verifiedAt > 0 && now - this.verifiedAt < ttl
      && this.verifiedDigest === this.primaryDigest;
    if (proofFresh) return;
    const fallbackDigest = await this.fetchDigest(this.fallbackUrl, this.model);
    if (!fallbackDigest) {
      this.invalidate();
      throw new Error(`fallback '${this.fallbackUrl}' unverifiable: cannot read model digest for '${this.model}' — refusing fallback (fail-closed)`);
    }
    if (fallbackDigest !== this.primaryDigest) {
      this.invalidate();
      throw new Error(`fallback '${this.fallbackUrl}' serves a DIFFERENT '${this.model}' (digest ${short(fallbackDigest)} ≠ primary ${short(this.primaryDigest)}) — refusing fallback (fail-closed)`);
    }
    this.verifiedDigest = fallbackDigest;
    this.verifiedAt = now;
    this.logger(`[EmbedderChain] fallback ${this.fallbackUrl} verified: '${this.model}' digest ${short(fallbackDigest)} matches primary`);
  }

  /** Re-read the primary digest when due; a changed digest re-baselines the
   *  anchor and invalidates the fallback proof. Unreachable primary keeps the
   *  existing anchor (last-known-healthy identity). */
  private async refreshPrimaryAnchor(due: boolean): Promise<void> {
    if (!due && this.primaryDigest) return;
    const fresh = await this.fetchDigest(this.primaryUrl, this.model).catch(() => null);
    this.primaryCheckedAt = Date.now();
    if (!fresh) return;
    if (this.primaryDigest && fresh !== this.primaryDigest) {
      this.warn(`[EmbedderChain] PRIMARY digest for '${this.model}' changed ${short(this.primaryDigest)} → ${short(fresh)} — re-baselining and invalidating fallback verification (fail-closed until re-proven)`);
      this.invalidate();
    }
    this.primaryDigest = fresh;
  }

  private invalidate(): void {
    this.verifiedDigest = null;
    this.verifiedAt = 0;
  }
}

function short(digest: string): string {
  return digest.slice(0, 12);
}
