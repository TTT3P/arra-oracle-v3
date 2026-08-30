/**
 * In-process warm keepalive for the embedder (2026-08-30, PR-C).
 *
 * Pinning the model (keep_alive:-1) stops Ollama from unloading it, but the
 * first embed after a long idle still measured 8.21 s on Mac Ollama (Metal
 * re-warm). Any process that reads the embedder runtime status — the HTTP
 * server and every MCP seat — starts one timer that forces a probe every
 * ORACLE_EMBEDDER_WARM_INTERVAL_MS (default 3 min; 0 disables). The timer is
 * unref'd so it never keeps a process alive, and one failure never throws.
 */

export const DEFAULT_WARM_INTERVAL_MS = 3 * 60_000;

type WarmProbe = () => Promise<unknown>;
type Handle = { timer: ReturnType<typeof setInterval>; intervalMs: number };

let handle: Handle | null = null;

export function warmIntervalMs(env = process.env): number {
  const raw = env.ORACLE_EMBEDDER_WARM_INTERVAL_MS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_WARM_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_WARM_INTERVAL_MS;
}

/** Idempotent: the first caller wins; later calls are no-ops until stopped. */
export function ensureEmbedderWarmKeepalive(probe: WarmProbe, intervalMs = warmIntervalMs()): boolean {
  if (handle || intervalMs <= 0) return false;
  const timer = setInterval(() => {
    probe().catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  handle = { timer, intervalMs };
  return true;
}

export function stopEmbedderWarmKeepalive(): void {
  if (!handle) return;
  clearInterval(handle.timer);
  handle = null;
}

export function embedderWarmKeepaliveStatus(): { running: boolean; intervalMs: number } {
  return { running: handle !== null, intervalMs: handle?.intervalMs ?? warmIntervalMs() };
}
