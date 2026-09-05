import { describe, it, expect, mock } from 'bun:test';
import { Elysia } from 'elysia';
import { createReindexRoute } from '../reindex.ts';

function post(app: Elysia, body: unknown) {
  return app.handle(new Request('http://localhost/indexer/reindex', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('POST /indexer/reindex', () => {
  it('runs the full reindex by default and waits for completion', async () => {
    const runFull = mock(async ({ repoRoot, append }: { repoRoot?: string | null; append?: boolean }) => ({ ok: true as const, repoRoot: repoRoot ?? '/repo', append: append === true }));
    const runRetros = mock(async (repoRoot: string) => ({ ok: true as const, repoRoot, documents: 0 }));
    const runRetroFile = mock(async (repoRoot: string, filePath: string) => ({ ok: true as const, repoRoot, filePath, documents: 0 }));
    const app = new Elysia().use(createReindexRoute({
      resolveRepoRoot: () => '/repo',
      runFull,
      runRetros,
      runRetroFile,
    }));

    const res = await post(app, {});
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe('complete');
    expect(body.repoRoot).toBe('/repo');
    expect(runFull).toHaveBeenCalledTimes(1);
    expect(runFull).toHaveBeenCalledWith({ repoRoot: '/repo', append: false });
    expect(runRetros).not.toHaveBeenCalled();
  });

  it('passes append mode to the full reindex runner', async () => {
    const runFull = mock(async ({ repoRoot, append }: { repoRoot?: string | null; append?: boolean }) => ({ ok: true as const, repoRoot: repoRoot ?? '/repo', append: append === true }));
    const runRetros = mock(async (repoRoot: string) => ({ ok: true as const, repoRoot, documents: 0 }));
    const runRetroFile = mock(async (repoRoot: string, filePath: string) => ({ ok: true as const, repoRoot, filePath, documents: 0 }));
    const app = new Elysia().use(createReindexRoute({
      resolveRepoRoot: () => '/new-root',
      runFull,
      runRetros,
      runRetroFile,
    }));

    const res = await post(app, { append: true });
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.append).toBe(true);
    expect(runFull).toHaveBeenCalledTimes(1);
    expect(runFull).toHaveBeenCalledWith({ repoRoot: '/new-root', append: true });
    expect(runRetros).not.toHaveBeenCalled();
  });

  it('supports retrospective-only indexing without full smart-delete', async () => {
    const runFull = mock(async ({ repoRoot, append }: { repoRoot?: string | null; append?: boolean }) => ({ ok: true as const, repoRoot: repoRoot ?? '/repo', append: append === true }));
    const runRetros = mock(async (repoRoot: string) => ({ ok: true as const, repoRoot, documents: 3 }));
    const runRetroFile = mock(async (repoRoot: string, filePath: string) => ({ ok: true as const, repoRoot, filePath, documents: 0 }));
    const app = new Elysia().use(createReindexRoute({
      resolveRepoRoot: () => '/oracle',
      runFull,
      runRetros,
      runRetroFile,
    }));

    const res = await post(app, { scope: 'retros' });
    const body = await res.json() as any;

    expect(body.ok).toBe(true);
    expect(body.documents).toBe(3);
    expect(body.repoRoot).toBe('/oracle');
    expect(runRetros).toHaveBeenCalledTimes(1);
    expect(runFull).not.toHaveBeenCalled();
  });

  it('dispatches one exact retro file without invoking broader reindex paths', async () => {
    const runFull = mock(async ({ repoRoot, append }: { repoRoot?: string | null; append?: boolean }) => ({ ok: true as const, repoRoot: repoRoot ?? '/repo', append: append === true }));
    const runRetros = mock(async (repoRoot: string) => ({ ok: true as const, repoRoot, documents: 0 }));
    const runRetroFile = mock(async (repoRoot: string, filePath: string) => ({ ok: true as const, repoRoot, filePath, documents: 2 }));
    const app = new Elysia().use(createReindexRoute({
      resolveRepoRoot: () => '/oracle',
      runFull,
      runRetros,
      runRetroFile,
    }));
    const filePath = '/oracle/ψ/memory/retrospectives/2026-08/18/session.md';

    const res = await post(app, { scope: 'retro-file', filePath, wait: true });
    const body = await res.json() as any;

    expect(body).toMatchObject({ ok: true, status: 'complete', repoRoot: '/oracle', filePath, documents: 2 });
    expect(runRetroFile).toHaveBeenCalledWith('/oracle', filePath);
    expect(runRetros).not.toHaveBeenCalled();
    expect(runFull).not.toHaveBeenCalled();
  });

  it('returns a 409 while a non-waiting job is active', async () => {
    let release!: () => void;
    const blocker = new Promise<void>(resolve => { release = resolve; });
    const runFull = mock(async ({ repoRoot }: { repoRoot?: string | null; append?: boolean }) => {
      await blocker;
      return { ok: true as const, repoRoot: repoRoot ?? '/repo' };
    });
    const runRetros = mock(async (repoRoot: string) => ({ ok: true as const, repoRoot, documents: 0 }));
    const runRetroFile = mock(async (repoRoot: string, filePath: string) => ({ ok: true as const, repoRoot, filePath, documents: 0 }));
    const app = new Elysia().use(createReindexRoute({
      resolveRepoRoot: () => '/repo',
      runFull,
      runRetros,
      runRetroFile,
    }));

    const first = await post(app, { wait: false });
    expect(first.status).toBe(200);

    const second = await post(app, {});
    const body = await second.json() as any;
    expect(second.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Reindex already running');

    release();
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('logs origin headers on start, complete and 409 refusal (incident 2026-08-29)', async () => {
    let release!: () => void;
    const blocker = new Promise<void>(resolve => { release = resolve; });
    const runFull = mock(async ({ repoRoot }: { repoRoot?: string | null; append?: boolean }) => {
      await blocker;
      return { ok: true as const, repoRoot: repoRoot ?? '/repo' };
    });
    const runRetros = mock(async (repoRoot: string) => ({ ok: true as const, repoRoot, documents: 0 }));
    const runRetroFile = mock(async (repoRoot: string, filePath: string) => ({ ok: true as const, repoRoot, filePath, documents: 0 }));
    const lines: string[] = [];
    const app = new Elysia().use(createReindexRoute({
      resolveRepoRoot: () => '/repo',
      runFull,
      runRetros,
      runRetroFile,
      log: (line) => lines.push(line),
    }));
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'curl/8.7.1',
      'x-forwarded-for': '10.0.0.7',
      'x-oracle-seat': 'barbara',
      'x-correlation-id': 'abcdef1234567890',
    };

    const first = await app.handle(new Request('http://localhost/indexer/reindex', {
      method: 'POST', headers, body: JSON.stringify({ wait: false }),
    }));
    expect(first.status).toBe(200);
    const second = await app.handle(new Request('http://localhost/indexer/reindex', {
      method: 'POST', headers, body: JSON.stringify({ scope: 'retros' }),
    }));
    expect(second.status).toBe(409);
    release();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\[reindex\] ts=\d{4}-\d{2}-\d{2}T[^ ]+ event=start jobId="reindex-\d+"/);
    expect(lines[0]).toMatch(/ua="curl#[0-9a-f]{8}"/);
    expect(lines[0]).toMatch(/xff_fp="[0-9a-f]{8}"/);
    expect(lines[0]).not.toContain('10.0.0.7');
    expect(lines[0]).toContain('claimed_seat="barbara"');
    expect(lines[0]).toContain('cid="abcdef12"');
    expect(lines[0]).toMatch(/repo="[0-9a-f]{8}:repo"/);
    expect(lines[0]).toContain('scope="all" wait=false append=false');
    expect(lines[1]).toContain('event=refused');
    expect(lines[1]).toContain('scope="retros"');
    expect(lines[1]).toMatch(/activeJob="reindex-\d+"/);
    expect(lines[2]).toMatch(/event=complete jobId="reindex-\d+" cid="abcdef12" durationMs=\d+/);
  });

  it('logs missing origin headers as "-" instead of crashing', async () => {
    const runFull = mock(async ({ repoRoot }: { repoRoot?: string | null; append?: boolean }) => ({ ok: true as const, repoRoot: repoRoot ?? '/repo' }));
    const runRetros = mock(async (repoRoot: string) => ({ ok: true as const, repoRoot, documents: 0 }));
    const runRetroFile = mock(async (repoRoot: string, filePath: string) => ({ ok: true as const, repoRoot, filePath, documents: 0 }));
    const lines: string[] = [];
    const app = new Elysia().use(createReindexRoute({
      resolveRepoRoot: () => '/repo', runFull, runRetros, runRetroFile, log: (line) => lines.push(line),
    }));

    const res = await post(app, {});
    expect(res.status).toBe(200);
    expect(lines[0]).toContain('ua="-" xff_fp="-" claimed_seat="-" cid="-"');
    expect(lines[1]).toContain('event=complete');
  });
  it('scope=learnings dispatches only the learnings runner with the explicit root and dryRun flag', async () => {
    const runFull = mock(async () => ({ ok: true as const, repoRoot: '/oracle', append: false }));
    const runRetros = mock(async (repoRoot: string) => ({ ok: true as const, repoRoot, documents: 0 }));
    const runRetroFile = mock(async (repoRoot: string, filePath: string) => ({ ok: true as const, repoRoot, filePath, documents: 0 }));
    const runLearnings = mock(async ({ repoRoot, dryRun }: { repoRoot: string; dryRun?: boolean }) => ({
      ok: true as const, scope: 'learnings' as const, repoRoot, dryRun: dryRun === true, files: 2, documents: 2, chunks: 2, superseded: 0,
      vectorJobs: { queued: 0, skipped: 0, failed: 0 },
    }));
    const app = new Elysia().use(createReindexRoute({ resolveRepoRoot: (r) => r ?? '/fallback', runFull, runRetros, runRetroFile, runLearnings }));

    const res = await post(app, { scope: 'learnings', repoRoot: '/croo', dryRun: true });
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.scope).toBe('learnings');
    expect(body.dryRun).toBe(true);
    expect(runLearnings).toHaveBeenCalledTimes(1);
    expect(runLearnings).toHaveBeenCalledWith({ repoRoot: '/croo', dryRun: true });
    expect(runFull).not.toHaveBeenCalled();
    expect(runRetros).not.toHaveBeenCalled();
    expect(runRetroFile).not.toHaveBeenCalled();
  });

  it('scope=learnings without an explicit repoRoot fails closed and runs nothing', async () => {
    const runFull = mock(async () => ({ ok: true as const, repoRoot: '/oracle', append: false }));
    const runRetros = mock(async (repoRoot: string) => ({ ok: true as const, repoRoot, documents: 0 }));
    const runRetroFile = mock(async (repoRoot: string, filePath: string) => ({ ok: true as const, repoRoot, filePath, documents: 0 }));
    const runLearnings = mock(async ({ repoRoot }: { repoRoot: string }) => ({ ok: true as const, repoRoot }));
    const app = new Elysia().use(createReindexRoute({ resolveRepoRoot: () => '/fallback-root', runFull, runRetros, runRetroFile, runLearnings }));

    const res = await post(app, { scope: 'learnings' });
    const body = await res.json() as any;

    expect(body.ok).toBe(false);
    expect(body.status).toBe('error');
    expect(body.error).toContain('repoRoot is required for scope=learnings');
    expect(runLearnings).not.toHaveBeenCalled();
    expect(runFull).not.toHaveBeenCalled();
    expect(runRetros).not.toHaveBeenCalled();
  });
  it('rejects dryRun for any scope other than learnings before running anything', async () => {
    const runFull = mock(async () => ({ ok: true as const, repoRoot: '/oracle', append: false }));
    const runRetros = mock(async (repoRoot: string) => ({ ok: true as const, repoRoot, documents: 0 }));
    const runRetroFile = mock(async (repoRoot: string, filePath: string) => ({ ok: true as const, repoRoot, filePath, documents: 0 }));
    const runLearnings = mock(async ({ repoRoot }: { repoRoot: string }) => ({ ok: true as const, repoRoot }));
    const log = mock((_line: string) => {});
    const app = new Elysia().use(createReindexRoute({ resolveRepoRoot: () => '/oracle', runFull, runRetros, runRetroFile, runLearnings, log }));
    for (const body of [{ dryRun: true }, { scope: 'all', dryRun: true }, { scope: 'retros', dryRun: true }, { scope: 'retro-file', filePath: '/oracle/ψ/memory/retrospectives/x.md', dryRun: true }]) {
      const res = await post(app, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toContain('dryRun is only supported with scope=learnings');
    }
    expect(runFull).not.toHaveBeenCalled();
    expect(runRetros).not.toHaveBeenCalled();
    expect(runRetroFile).not.toHaveBeenCalled();
    expect(runLearnings).not.toHaveBeenCalled();
    expect(log.mock.calls.some(([line]) => String(line).includes('event=start'))).toBe(false);
  });
});
