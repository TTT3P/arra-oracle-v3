import { Elysia, t } from 'elysia';
import { runOracleReindex, runOracleReindexLearnings, resolveIndexerRepoRoot } from '../../indexer/runner.ts';
import { indexRetrospectives, indexRetroFile } from '../../indexer/retro-index.ts';
import { currentTenantId, runWithTenant } from '../../middleware/tenant.ts';
import { describeError, describeRepoRoot, reindexLogLine, reindexOrigin } from './reindex-log.ts';

type ReindexResult =
  | Awaited<ReturnType<typeof runOracleReindex>>
  | Awaited<ReturnType<typeof indexRetrospectives>>
  | Awaited<ReturnType<typeof indexRetroFile>>
  | Awaited<ReturnType<typeof runOracleReindexLearnings>>;

export interface ReindexDeps {
  resolveRepoRoot: (repoRoot?: string | null) => string;
  runFull: (opts: { repoRoot?: string | null; append?: boolean }) => Promise<ReindexResult>;
  runRetros: (repoRoot: string) => Promise<ReindexResult>;
  runRetroFile: (repoRoot: string, filePath: string) => Promise<ReindexResult>;
  /** scope=learnings: explicit root, ψ/memory/learnings only, no prune, retros never read. */
  runLearnings: (opts: { repoRoot: string; dryRun?: boolean }) => Promise<ReindexResult>;
  /** Origin/lifecycle log sink (default console.log). Injected by tests. */
  log?: (line: string) => void;
}

const defaultDeps: ReindexDeps = {
  resolveRepoRoot: resolveIndexerRepoRoot,
  runFull: runOracleReindex,
  runRetros: indexRetrospectives,
  runRetroFile: indexRetroFile,
  runLearnings: runOracleReindexLearnings,
};

export function createReindexRoute(overrides: Partial<ReindexDeps> = {}) {
  const deps: ReindexDeps = { ...defaultDeps, ...overrides };
  const activeJobs = new Map<string, { id: string; startedAt: string }>();

  const log = deps.log ?? ((line: string) => console.log(line));

  return new Elysia().post('/indexer/reindex', async ({ body, set, request }) => {
    const requested = body ?? {};
    const scope = requested.scope ?? 'all';
    const wait = requested.wait !== false;
    const append = requested.append === true;
    const dryRun = requested.dryRun === true;
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
    log(reindexLogLine('start', { jobId, ...origin, repo: describeRepoRoot(repoRoot) }));

    const run = async () => {
      if (scope === 'learnings') {
        // No fallback root for a foreign-root write: the caller must name it.
        if (!requested.repoRoot?.trim()) throw new Error('repoRoot is required for scope=learnings');
        return deps.runLearnings({ repoRoot, dryRun });
      }
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
        log(reindexLogLine('error', { jobId, cid: origin.cid, durationMs: durationMs(), error: describeError(err) }));
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
        t.Literal('learnings'),
      ])),
      filePath: t.Optional(t.String()),
      wait: t.Optional(t.Boolean()),
      append: t.Optional(t.Boolean()),
      dryRun: t.Optional(t.Boolean()),
    })),
    detail: {
      tags: ['indexer'],
      summary: 'Run SQLite/FTS reindex from the server process',
    },
  });
}

export const reindexEndpoint = createReindexRoute();
