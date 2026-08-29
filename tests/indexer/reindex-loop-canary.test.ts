/**
 * Full-path reindex canary (Riddler P1-2, PR #5 verdict 2026-08-29).
 *
 * Runs the REAL `POST /indexer/reindex` route → `runOracleReindex` (backup,
 * snapshot, discovery, read+parse, chunk, SQLite/FTS/entity/pointer store)
 * against a generated corpus while a `/health` probe and a deterministic FTS
 * `/search` on the same database are issued continuously. Records the maximum
 * request gap (event-loop delay as seen by a client) and the indexer phase
 * durations, once with yields disabled (`ORACLE_INDEX_YIELD_EVERY=0`, the
 * pre-PR behaviour) and once with the default, and asserts the measured bound.
 *
 * Corpus: CANARY_FILES markdown files (default 1500, ~1.2 KB each) across
 * ψ/memory/{learnings,retrospectives} and a project-first vault dir. Set
 * CANARY_FILES=6000 for a closer match to the live ~12k-doc vault.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Elysia } from 'elysia';
import { Database } from 'bun:sqlite';

const FILES = Number(process.env.CANARY_FILES ?? 1500);
const MAX_GAP_MS = Number(process.env.CANARY_MAX_GAP_MS ?? 750);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-reindex-canary-'));
const dataDir = path.join(tmp, 'data');
const repoRoot = path.join(tmp, 'vault');
const saved = { ...process.env };
process.env.ORACLE_DATA_DIR = dataDir;
process.env.ORACLE_DB_PATH = path.join(dataDir, 'oracle.db');
process.env.ORACLE_REPO_ROOT = repoRoot;
fs.mkdirSync(dataDir, { recursive: true });

function writeCorpus() {
  const para = 'Reindex canary paragraph with ordinary prose about oracles, vaults and retrospectives. ';
  const dirs = [
    path.join(repoRoot, 'ψ', 'memory', 'learnings'),
    path.join(repoRoot, 'ψ', 'memory', 'retrospectives', '2026-08'),
    path.join(repoRoot, 'github.com', 'org', 'repo-a', 'ψ', 'memory', 'learnings'),
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  for (let i = 0; i < FILES; i++) {
    const dir = dirs[i % dirs.length];
    const body = `# Canary doc ${i}\n\n## Lesson\n\n${para.repeat(12)}\n\nunique-token-${i} canaryneedle\n`;
    fs.writeFileSync(path.join(dir, `2026-08-01_canary-${i}.md`), body);
  }
}
writeCorpus();

const { closeDb, resetDefaultDatabaseForTests } = await import('../../src/db/index.ts');
resetDefaultDatabaseForTests(process.env.ORACLE_DB_PATH);
const { createReindexRoute } = await import('../../src/routes/indexer/reindex.ts');

type Run = {
  ids: string[];            // every oracle_documents id after the run (coverage proof)
  sourceFiles: number;      // COUNT(DISTINCT source_file)
  ftsOrphans: number;       // documents with no oracle_fts row
  maxLoopDelayMs: number;   // max timer drift of a 10 ms ticker = event-loop blocked time
  maxProbeMs: number;       // max /health|/search round trip once the loop was free
  probes: number;
  totalMs: number;
  phases: Record<string, number>;
};

function freshDatabase() {
  for (const f of fs.readdirSync(dataDir)) fs.rmSync(path.join(dataDir, f), { recursive: true, force: true });
  resetDefaultDatabaseForTests(process.env.ORACLE_DB_PATH);
}

async function runCanary(): Promise<Run> {
  freshDatabase();
  const phases: Record<string, number> = {};
  const started = performance.now();
  let last = started;
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = String(args[0] ?? '');
    const now = performance.now();
    const label = /^Indexed \d+ (\S+)/.exec(line)?.[1]?.replace('chunks', 'post-store')
      ?? (line.startsWith('Chunked') ? 'chunk' : line.startsWith('Smart delete') ? 'smart-delete'
      : line.startsWith('Skipping vector indexing') ? 'store' : line.startsWith('Indexing complete') ? 'finish' : null);
    if (label) { phases[label] = Math.round(now - last); last = now; }
  };
  const reader = new Database(process.env.ORACLE_DB_PATH!, { readonly: true });
  const search = reader.prepare(`SELECT id FROM oracle_fts WHERE oracle_fts MATCH ? LIMIT 5`);
  const app = new Elysia()
    .use(createReindexRoute({ log: () => {} }))
    .get('/health', () => ({ ok: true }))
    .get('/search', () => { try { return search.all('canaryneedle'); } catch { return []; } });
  try {
    const job = app.handle(new Request('http://localhost/indexer/reindex', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'all' }),
    }));
    let done = false;
    void job.then(() => { done = true; });
    let maxLoopDelayMs = 0;
    let maxProbeMs = 0;
    let probes = 0;
    const TICK = 10;
    while (!done) {
      const scheduledAt = performance.now();
      await Bun.sleep(TICK);
      // A blocked loop cannot fire the timer: the overshoot is the blocked time.
      maxLoopDelayMs = Math.max(maxLoopDelayMs, performance.now() - scheduledAt - TICK);
      const t0 = performance.now();
      const res = await app.handle(new Request(probes % 2 ? 'http://localhost/search' : 'http://localhost/health'));
      expect(res.status).toBe(200);
      maxProbeMs = Math.max(maxProbeMs, performance.now() - t0);
      probes++;
    }
    const body = await (await job).json() as { ok?: boolean; status?: string; error?: string };
    expect(body.status).toBe('complete');
    expect(body.ok).toBe(true);
    const ids = (reader.prepare(`SELECT id FROM oracle_documents WHERE created_by = 'indexer' ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
    const sourceFiles = (reader.prepare(`SELECT COUNT(DISTINCT source_file) AS n FROM oracle_documents WHERE created_by = 'indexer'`).get() as { n: number }).n;
    const ftsOrphans = (reader.prepare(`SELECT COUNT(*) AS n FROM oracle_documents d LEFT JOIN oracle_fts f ON f.id = d.id WHERE d.created_by = 'indexer' AND f.id IS NULL`).get() as { n: number }).n;
    return {
      ids, sourceFiles, ftsOrphans,
      maxLoopDelayMs: Math.round(maxLoopDelayMs), maxProbeMs: Math.round(maxProbeMs), probes,
      totalMs: Math.round(performance.now() - started), phases,
    };
  } finally {
    console.log = origLog;
    reader.close();
  }
}

describe(`reindex loop canary (${FILES} files)`, () => {
  afterAll(() => {
    try { closeDb(); } catch {}
    for (const k of ['ORACLE_DATA_DIR', 'ORACLE_DB_PATH', 'ORACLE_REPO_ROOT', 'ORACLE_INDEX_YIELD_EVERY']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    resetDefaultDatabaseForTests(':memory:');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test(`with yields, max event-loop delay and health/search latency during a full reindex stay under ${MAX_GAP_MS} ms`, async () => {
    let baseline: Run | null = null;
    if (!process.env.CANARY_SKIP_BASELINE) {
      process.env.ORACLE_INDEX_YIELD_EVERY = '0';
      baseline = await runCanary();
    }
    delete process.env.ORACLE_INDEX_YIELD_EVERY;
    const yielding = await runCanary();
    const summary = ({ ids, ...rest }: Run) => ({ docs: ids.length, ...rest });
    console.info(`[canary] files=${FILES} baseline(no-yield)=${baseline ? JSON.stringify(summary(baseline)) : 'skipped'} yielding=${JSON.stringify(summary(yielding))}`);

    // Coverage: every source file indexed, every document has its FTS row, no id missing or duplicated.
    expect(yielding.sourceFiles).toBe(FILES);
    expect(yielding.ftsOrphans).toBe(0);
    expect(new Set(yielding.ids).size).toBe(yielding.ids.length);
    expect(yielding.ids.length).toBeGreaterThanOrEqual(FILES);
    if (baseline) expect(yielding.ids).toEqual(baseline.ids);  // exact same id set as the single-transaction store

    if (baseline) {
      // Baseline must actually exercise the incident: the loop is held for most of the run.
      expect(baseline.maxLoopDelayMs).toBeGreaterThan(MAX_GAP_MS);
      expect(yielding.probes).toBeGreaterThan(baseline.probes);
    }
    expect(yielding.maxLoopDelayMs).toBeLessThan(MAX_GAP_MS);
    expect(yielding.maxProbeMs).toBeLessThan(MAX_GAP_MS);
  }, 300_000);
});
