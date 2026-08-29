import { Elysia, t } from 'elysia';
import { runOracleReindex, resolveIndexerRepoRoot } from '../../indexer/runner.ts';
import { indexRetrospectives, indexRetroFile } from '../../indexer/retro-index.ts';
import { currentTenantId, runWithTenant } from '../../middleware/tenant.ts';

type ReindexResult =
  | Awaited<ReturnType<typeof runOracleReindex>>
  | Awaited<ReturnType<typeof indexRetrospectives>>
  | Awaited<ReturnType<typeof indexRetroFile>>;

export interface ReindexDeps {
  resolveRepoRoot: (repoRoot?: string | null) => string;
  runFull: (opts: { repoRoot?: string | null; append?: boolean }) => Promise<ReindexResult>;
  runRetros: (repoRoot: string) => Promise<ReindexResult>;
  runRetroFile: (repoRoot: string, filePath: string) => Promise<ReindexResult>;
  /** Origin/lifecycle log sink (default console.log). Injected by tests. */
  log?: (line: string) => void;
}

const defaultDeps: ReindexDeps = {
  resolveRepoRoot: resolveIndexerRepoRoot,
  runFull: runOracleReindex,
  runRetros: indexRetrospectives,
  runRetroFile: indexRetroFile,
};

/**
 * Who called reindex. Incident 2026-08-29: 114 reindex POSTs in 21 h starved the
 * event loop, and the nginx-style request log carries neither timestamp nor
 * caller, so the source could not be named. One `[reindex]` line per lifecycle
 * event (start / refused / complete / error) with wall-clock time and the
 * caller-identifying headers answers "who" on the next occurrence.
 */
export function reindexOrigin(request: Request): Record<string, string> {
  const h = request.headers;
  return {
    ua: h.get('user-agent') ?? '-',
    xff: h.get('x-forwarded-for') ?? '-',
    seat: h.get('x-oracle-seat') ?? h.get('x-maw-agent') ?? '-',
    cid: (h.get('x-correlation-id') ?? h.get('x-request-id') ?? '-').slice(0, 8),
  };
}

function reindexLogLine(event: string, fields: Record<string, unknown>): string {
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(v ?? '-')}`);
  return `[reindex] ts=${new Date().toISOString()} event=${event} ${parts.join(' ')}`;
}

export function createReindexRoute(deps: ReindexDeps = defaultDeps) {
  const activeJobs = new Map<string, { id: string; startedAt: string }>();

  const log = deps.log ?? ((line: string) => console.log(line));

  return new Elysia().post('/indexer/reindex', async ({ body, set, request }) => {
    const requested = body ?? {};
    const scope = requested.scope ?? 'all';
    const wait = requested.wait !== false;
    const append = requested.append === true;
    const repoRoot = deps.resolveRepoRoot(requested.repoRoot);
    const jobId = `reindex-${Date.now()}`;
    const tenantId = currentTenantId();
    const jobKey = tenantId ?? '*';
    const activeJob = activeJobs.get(jobKey) ?? null;
    const origin: Record<string, unknown> = { ...reindexOrigin(request), scope, wait, append, tenant: jobKey };

    if (activeJob) {
      log(reindexLogLine('refused', { ...origin, activeJob: activeJob.id, activeSince: activeJob.startedAt }));
      set.status = 409;
      return { ok: false, error: 'Reindex already running', activeJob };
    }
    const startedMs = performance.now();
    log(reindexLogLine('start', { jobId, ...origin, repoRoot }));

    const run = async () => {
      if (scope === 'retros') return deps.runRetros(repoRoot);
      if (scope === 'retro-file') {
        if (!requested.filePath) throw new Error('filePath is required for scope=retro-file');
        return deps.runRetroFile(repoRoot, requested.filePath);
      }
      return deps.runFull({ repoRoot, append });
    };

    activeJobs.set(jobKey, { id: jobId, startedAt: new Date().toISOString() });
    const durationMs = () => Math.round(performance.now() - startedMs);
    const task = runWithTenant(tenantId, run)
      .then((result) => {
        log(reindexLogLine('complete', { jobId, cid: origin.cid, durationMs: durationMs() }));
        return { jobId, status: 'complete' as const, ...result };
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log(reindexLogLine('error', { jobId, cid: origin.cid, durationMs: durationMs(), error: message }));
        return { ok: false as const, jobId, status: 'error' as const, repoRoot, error: message };
      })
      .finally(() => {
        activeJobs.delete(jobKey);
      });

    if (wait) return await task;

    // Ensure background failures are observed by the task catch above.
    void task;
    return { ok: true, jobId, status: 'started', repoRoot, scope, append };
  }, {
    body: t.Optional(t.Object({
      repoRoot: t.Optional(t.String()),
      scope: t.Optional(t.Union([
        t.Literal('all'),
        t.Literal('retros'),
        t.Literal('retro-file'),
      ])),
      filePath: t.Optional(t.String()),
      wait: t.Optional(t.Boolean()),
      append: t.Optional(t.Boolean()),
    })),
    detail: {
      tags: ['indexer'],
      summary: 'Run SQLite/FTS reindex from the server process',
    },
  });
}

export const reindexEndpoint = createReindexRoute();
