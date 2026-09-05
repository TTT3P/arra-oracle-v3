/**
 * Shared fixtures + instruments for the slice(d) retros-batching regressions.
 *
 * Instruments wrap the CONNECTION, not a counter in the code under test: transaction boundaries
 * are read off `Database.prototype.transaction` (bun:sqlite issues BEGIN/COMMIT/ROLLBACK natively,
 * below the `prepare` seam), liveness off a real setTimeout-drift sampler and a real in-process
 * HTTP `/health/live` server, so a test cannot stay green when the boundary or the yield moves.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { Elysia } from 'elysia';
import { createDatabase } from '../../db/index.ts';
import { createLivenessEndpoint } from '../../routes/health/live.ts';

export const cleanups: Array<() => void> = [];
export function runCleanups(): void { while (cleanups.length) cleanups.pop()!(); }

export interface RetroEnv { dbPath: string; repoRoot: string; relPaths: string[] }

/** `files` retro files, each with `sections` documents; `bodyChars` > 800 makes a section chunk. */
export function retroEnv(files: number, sections = 1, bodyChars = 120): RetroEnv {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-retro-r2-'));
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repoRoot = path.join(tmp, 'repo');
  const relDir = path.join('ψ', 'memory', 'retrospectives', '2026-07', '01');
  fs.mkdirSync(path.join(repoRoot, relDir), { recursive: true });
  const relPaths: string[] = [];
  for (let i = 0; i < files; i++) {
    const n = String(i).padStart(3, '0');
    let body = `# retro ${n}\n\n`;
    for (let s = 0; s < sections; s++) {
      const seed = `session ${n} section ${s} learned that batching keeps the loop alive. `;
      body += `## Section ${s}\n\n${seed.repeat(Math.ceil(bodyChars / seed.length)).slice(0, bodyChars)}\n\n`;
    }
    const rel = path.join(relDir, `10.${n}_session-${n}.md`);
    fs.writeFileSync(path.join(repoRoot, rel), body);
    relPaths.push(rel);
  }
  return { dbPath: path.join(tmp, 'oracle.db'), repoRoot, relPaths };
}

/** Legacy active indexer rows (older id scheme) for every file, with FTS rows — what a live DB holds. */
export function seedLegacy(dbPath: string, relPaths: string[], perFile = 2): Map<string, string[]> {
  const { sqlite } = createDatabase(dbPath);
  const legacy = new Map<string, string[]>();
  const now = Date.now();
  const ins = sqlite.prepare(
    'INSERT INTO oracle_documents (id, tenant_id, type, source_file, concepts, created_at, updated_at, indexed_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const fts = sqlite.prepare('INSERT INTO oracle_fts (id, content, concepts) VALUES (?, ?, ?)');
  for (const rel of relPaths) {
    const ids: string[] = [];
    for (let j = 0; j < perFile; j++) {
      const id = `legacy_${path.basename(rel, '.md')}_${j}`;
      ins.run(id, 'default', 'retro', rel, '[]', now, now, now, 'indexer');
      fts.run(id, `legacy content ${j} for ${rel}`, 'legacy');
      ids.push(id);
    }
    legacy.set(rel, ids);
  }
  sqlite.close();
  return legacy;
}

/** Trigger that aborts the (n+1)-th document insert of the run, i.e. mid-run, inside a batch. */
export function poisonAfterInserts(dbPath: string, n: number): void {
  const { sqlite } = createDatabase(dbPath);
  sqlite.run('CREATE TABLE IF NOT EXISTS _ins(n INTEGER)');
  sqlite.run('INSERT INTO _ins VALUES (0)');
  sqlite.run(
    'CREATE TRIGGER poison_ins AFTER INSERT ON oracle_documents BEGIN UPDATE _ins SET n = n + 1; ' +
    `SELECT CASE WHEN (SELECT n FROM _ins) > ${n} THEN RAISE(ABORT, 'poison mid-run') END; END`,
  );
  sqlite.close();
}

export function dropPoison(dbPath: string): void {
  const { sqlite } = createDatabase(dbPath);
  sqlite.run('DROP TRIGGER IF EXISTS poison_ins');
  sqlite.close();
}

export interface DbView {
  activeBySource: Map<string, Set<string>>;
  supersededBy: Map<string, string>;
  ftsIds: Set<string>;
  pointerDocIds: Set<string>;
  status: { is_indexing: number; progress_current: number; progress_total: number; completed_at: number | null; error: string | null };
}

export function viewDb(dbPath: string): DbView {
  const sqlite = new Database(dbPath);
  const activeBySource = new Map<string, Set<string>>();
  for (const row of sqlite.prepare('SELECT id, source_file FROM oracle_documents WHERE superseded_by IS NULL').all() as Array<{ id: string; source_file: string }>) {
    const set = activeBySource.get(row.source_file) ?? new Set<string>();
    set.add(row.id);
    activeBySource.set(row.source_file, set);
  }
  const supersededBy = new Map<string, string>();
  for (const row of sqlite.prepare('SELECT id, superseded_by FROM oracle_documents WHERE superseded_by IS NOT NULL').all() as Array<{ id: string; superseded_by: string }>) {
    supersededBy.set(row.id, row.superseded_by);
  }
  const ftsIds = new Set((sqlite.prepare('SELECT id FROM oracle_fts').all() as Array<{ id: string }>).map((r) => r.id));
  const pointerDocIds = new Set<string>();
  for (const row of sqlite.prepare('SELECT doc_ids FROM oracle_pointer_index').all() as Array<{ doc_ids: string }>) {
    for (const id of JSON.parse(row.doc_ids) as string[]) pointerDocIds.add(id);
  }
  const status = sqlite.prepare('SELECT is_indexing, progress_current, progress_total, completed_at, error FROM indexing_status WHERE id = 1').get() as DbView['status'];
  sqlite.close();
  return { activeBySource, supersededBy, ftsIds, pointerDocIds, status };
}

export const countRows = (dbPath: string, sql: string): number => {
  const sqlite = new Database(dbPath);
  try { return (sqlite.prepare(sql).get() as { n: number }).n; } finally { sqlite.close(); }
};

export interface TxnCounts { begin: number; commit: number; rollback: number }
/** `outer`: raw BEGIN/COMMIT/ROLLBACK statements issued through `Database.run` (the per-batch
 * publish transaction); `nested`: `Database.transaction` callbacks (drizzle `db.transaction`, which
 * bun:sqlite runs as SAVEPOINTs while an outer transaction is open) — begin = entered,
 * commit = returned, rollback = threw. */
export interface TxnTrace { outer: TxnCounts; nested: TxnCounts }

/** Count transaction boundaries on the connection itself, not a counter the code under test owns. */
export async function withTxnCounter<T>(run: () => Promise<T>): Promise<{ result: T; txn: TxnTrace }> {
  const txn: TxnTrace = { outer: { begin: 0, commit: 0, rollback: 0 }, nested: { begin: 0, commit: 0, rollback: 0 } };
  type Fn = (...args: unknown[]) => unknown;
  const proto = Database.prototype as unknown as { transaction: Fn; run: Fn };
  const originalTx = proto.transaction;
  const originalRun = proto.run;
  const instrument = (f: Fn): Fn => function (this: unknown, ...args: unknown[]) {
    txn.nested.begin++;
    try { const r = f.apply(this, args); txn.nested.commit++; return r; } catch (err) { txn.nested.rollback++; throw err; }
  };
  proto.transaction = function (this: unknown, ...args: unknown[]) {
    const native = originalTx.apply(this, args) as Fn & Record<string, Fn>;
    const wrapped = instrument(native) as Fn & Record<string, Fn>;
    for (const mode of ['deferred', 'immediate', 'exclusive']) wrapped[mode] = instrument(native[mode]);
    return wrapped;
  };
  proto.run = function (this: unknown, ...args: unknown[]) {
    const sql = typeof args[0] === 'string' ? args[0] : '';
    if (/^\s*begin\b/i.test(sql)) txn.outer.begin++;
    else if (/^\s*commit\b/i.test(sql)) txn.outer.commit++;
    else if (/^\s*rollback\b/i.test(sql)) txn.outer.rollback++;
    return originalRun.apply(this, args);
  };
  try { return { result: await run(), txn }; } finally { proto.transaction = originalTx; proto.run = originalRun; }
}

/** Event-loop lag: a setTimeout chain records how late each tick fires. `stop` first lets one
 * macrotask turn run so a tick that was starved for the WHOLE run still lands as one huge sample. */
export function lagSampler(intervalMs = 5): { stop: () => Promise<number[]> } {
  const lags: number[] = [];
  let on = true;
  let expected = performance.now() + intervalMs;
  const tick = () => {
    if (!on) return;
    const now = performance.now();
    lags.push(Math.max(0, now - expected));
    expected = now + intervalMs;
    setTimeout(tick, intervalMs);
  };
  setTimeout(tick, intervalMs);
  return {
    stop: async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); on = false; return lags; },
  };
}

/** Real HTTP liveness probes against the real `/health/live` route, with the fleet's 2 s abort. */
export function livenessProbe(everyMs = 20, abortMs = 2000): { stop: () => Promise<{ latencies: number[]; aborts: number }> } {
  const app = new Elysia().use(createLivenessEndpoint()).listen({ port: 0, hostname: '127.0.0.1' });
  const url = `http://127.0.0.1:${app.server!.port}/health/live`;
  const latencies: number[] = [];
  let aborts = 0;
  let on = true;
  const loop = (async () => {
    while (on) {
      const t0 = performance.now();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(abortMs) });
        if (res.ok) latencies.push(performance.now() - t0); else aborts++;
      } catch { aborts++; }
      await new Promise<void>((resolve) => setTimeout(resolve, everyMs));
    }
  })();
  return {
    stop: async () => { on = false; await loop; await app.stop(true); return { latencies, aborts }; },
  };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
