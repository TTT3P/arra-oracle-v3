/**
 * Log a gateway-proxied /api/search exactly once, on THIS server (OM-BL-2026-09-20-04).
 *
 * When VECTOR_URL is set the gateway proxies /api/search to the readonly vector sidecar, so the
 * main server's local searchEndpoint/handleSearch (and its logSearch) never run, and the sidecar's
 * logSearch is skipped because its DB handle is readonly (src/server/logging.ts). Result on parent
 * code: proxied searches are recorded NOWHERE, under-counting the read side. This helper closes that
 * gap by writing the single search_log row here — the gateway runs inside the writable main process,
 * so logSearch persists. It is best-effort and never throws into the proxy path.
 *
 * Exactly-once: it fires only for a successfully PROXIED /api/search (the local, non-proxied path
 * still logs via handleSearch, and the readonly sidecar logs nothing), so there is no double count.
 */
import { logSearch } from '../server/logging.ts';
import { detectProject } from '../server/project-detect.ts';
import type { SearchResult } from '../server/types.ts';

/**
 * @param elapsedMs the gateway-measured proxy round-trip duration (the truthful search_time_ms).
 *   The proxied response body does NOT carry a duration for normal responses (handlers.ts only
 *   sets elapsedMs on PARTIAL/budget-exceeded responses), so it must be measured here, not read.
 */
export async function logProxiedSearch(url: URL, response: Response, elapsedMs: number): Promise<void> {
  try {
    if (response.status !== 200) return;
    const canonicalPath = url.pathname.replace(/^\/api\/v[^/]+(?=\/)/, '/api');
    if (canonicalPath !== '/api/search') return;
    const q = url.searchParams.get('q')?.trim();
    if (!q) return;
    const body = (await response.clone().json().catch(() => null)) as
      | { results?: unknown[]; total?: number; mode?: string }
      | null;
    if (!body || !Array.isArray(body.results)) return;
    const type = url.searchParams.get('type') ?? 'all';
    const mode = url.searchParams.get('mode') ?? (typeof body.mode === 'string' ? body.mode : 'hybrid');
    const total = typeof body.total === 'number' ? body.total : body.results.length;
    // Resolve project the SAME way as handlers.ts:139 — cwd fallback + lowercase — so proxied rows
    // match the scope/normalization of locally-served rows.
    const rawProject = url.searchParams.get('project') ?? undefined;
    const rawCwd = url.searchParams.get('cwd') ?? undefined;
    const project = (rawProject ?? detectProject(rawCwd))?.toLowerCase() ?? undefined;
    logSearch(q, type, mode, total, Math.max(0, Math.round(elapsedMs)), body.results as SearchResult[], project);
  } catch {
    /* logging must never break the proxy */
  }
}
