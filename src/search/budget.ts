/**
 * Search budget + admission gate (OM-BL-2026-09-09-01).
 *
 * The owner core runs FTS5 queries synchronously on the single Bun event loop; bun:sqlite exposes no
 * interrupt, so a running statement cannot be cut short. What CAN be bounded:
 *   - the vector leg: skipped when the request has already spent its budget after the FTS leg, so a
 *     slow request returns PARTIAL (FTS-only) results instead of adding a proxy round-trip;
 *   - pile-ups: when more searches are in flight than the admission limit, a new one is refused with
 *     503 + Retry-After immediately instead of queueing for minutes (each queued search would run its
 *     own multi-second FTS scan once the loop frees up).
 * Moving the FTS scan off the loop (worker thread) is a separate change.
 */
export const SEARCH_BUDGET_MS_ENV = 'ORACLE_SEARCH_BUDGET_MS';
export const SEARCH_MAX_INFLIGHT_ENV = 'ORACLE_SEARCH_MAX_INFLIGHT';
export const DEFAULT_SEARCH_BUDGET_MS = 20_000;
export const DEFAULT_SEARCH_MAX_INFLIGHT = 4;
export const DEFAULT_RETRY_AFTER_SECONDS = 5;

// Config validation (src/config/validate.ts) requires INTEGER_ENV_KEYS to be positive integers; the
// same contract is applied here so an unvalidated caller (tests, embedded use) gets identical semantics.
function positiveInt(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Per-request wall-clock budget in ms (positive integer; anything else = default). */
export function searchBudgetMs(raw = process.env[SEARCH_BUDGET_MS_ENV]): number {
  return positiveInt(raw, DEFAULT_SEARCH_BUDGET_MS);
}

/** Maximum concurrently admitted searches (positive integer; anything else = default). */
export function searchMaxInflight(raw = process.env[SEARCH_MAX_INFLIGHT_ENV]): number {
  return positiveInt(raw, DEFAULT_SEARCH_MAX_INFLIGHT);
}

export function budgetExceeded(startedAt: number, budgetMs = searchBudgetMs(), now = Date.now()): boolean {
  return now - startedAt >= budgetMs;
}

export class SearchOverloadedError extends Error {
  readonly status = 503;
  constructor(readonly inflight: number, readonly maxInflight: number, readonly retryAfterSeconds = DEFAULT_RETRY_AFTER_SECONDS) {
    super(`search overloaded: ${inflight} in flight, limit ${maxInflight}; retry after ${retryAfterSeconds}s`);
    this.name = 'SearchOverloadedError';
  }
}

export interface SearchAdmission {
  /** Throws SearchOverloadedError when the limit is reached; otherwise returns the release function. */
  acquire(): () => void;
  readonly inflight: number;
}

export function createSearchAdmission(limit: () => number = searchMaxInflight): SearchAdmission {
  let inflight = 0;
  return {
    acquire() {
      const max = limit();
      if (inflight >= max) throw new SearchOverloadedError(inflight, max);
      inflight += 1;
      let released = false;
      return () => { if (!released) { released = true; inflight -= 1; } };
    },
    get inflight() { return inflight; },
  };
}

/** Process-wide gate for the HTTP search handler; reads the limit from env on every acquire. */
export const searchAdmission = createSearchAdmission();
