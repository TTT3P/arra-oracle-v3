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
import type { SearchResult } from '../server/types.ts';

export async function logProxiedSearch(url: URL, response: Response): Promise<void> {
  try {
    if (response.status !== 200) return;
    const canonicalPath = url.pathname.replace(/^\/api\/v[^/]+(?=\/)/, '/api');
    if (canonicalPath !== '/api/search') return;
    const q = url.searchParams.get('q')?.trim();
    if (!q) return;
    const body = (await response.clone().json().catch(() => null)) as
      | { results?: unknown[]; total?: number; mode?: string; elapsedMs?: number }
      | null;
    if (!body || !Array.isArray(body.results)) return;
    const type = url.searchParams.get('type') ?? 'all';
    const mode = url.searchParams.get('mode') ?? (typeof body.mode === 'string' ? body.mode : 'hybrid');
    const total = typeof body.total === 'number' ? body.total : body.results.length;
    const elapsed = typeof body.elapsedMs === 'number' ? body.elapsedMs : 0;
    const project = url.searchParams.get('project') ?? undefined;
    logSearch(q, type, mode, total, elapsed, body.results as SearchResult[], project);
  } catch {
    /* logging must never break the proxy */
  }
}
