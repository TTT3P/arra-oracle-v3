/**
 * TEMPORARY DIAGNOSTIC (branch fix/gate-green-r2 only — delete before merge).
 *
 * The two oracle_read tests time out at 5000 ms on the PR-gate runner (runs 33971035968,
 * 33972148969, 33972667149) and cannot be reproduced locally, with or without a warm-up. This
 * file replays the same code paths with a 60 s budget and prints a wall-clock timestamp per phase
 * so the run log shows WHERE the runner spends the time. It asserts nothing.
 */
import { afterAll, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const t0 = performance.now();
const stamp = (label: string) => console.log(`[DIAG ${new Date().toISOString()} +${(performance.now() - t0).toFixed(0)}ms] ${label}`);
const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

test('diag: time every phase of an oracle_read', async () => {
  stamp('start');
  const { createDatabase } = await import('../../db/index.ts');
  stamp('imported db/index.ts');
  const { oracleDocuments } = await import('../../db/schema.ts');
  const { handleRead } = await import('../read.ts');
  stamp('imported tools/read.ts');

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-diag-repo-'));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-diag-db-'));
  roots.push(repoRoot, dbDir);
  const { sqlite, db } = createDatabase(path.join(dbDir, 'oracle.db'));
  stamp('createDatabase (migrations) done');
  const now = Date.now();
  db.insert(oracleDocuments).values([
    { id: 'doc-principle', type: 'principle', sourceFile: 'ψ/principles/nothing.md', concepts: '[]', createdAt: now, updatedAt: now, indexedAt: now, project: 'github.com/soul/arra' },
    { id: 'doc-learning', type: 'learning', sourceFile: 'ψ/memory/learnings/vector.md', concepts: '[]', createdAt: now, updatedAt: now, indexedAt: now, project: 'github.com/soul/arra' },
  ]).run();
  sqlite.prepare('INSERT INTO oracle_fts (id, content, concepts) VALUES (?, ?, ?)').run('doc-learning', 'Vector adapters cached body', '');
  const directFile = path.join(repoRoot, 'ψ/principles/nothing.md');
  fs.mkdirSync(path.dirname(directFile), { recursive: true });
  fs.writeFileSync(directFile, '# Nothing is Deleted\nappend-only');
  stamp('fixture ready');

  const ctx = { db, sqlite, repoRoot, vectorStore: { name: 'mock-vector' } as any, vectorStatus: 'connected', vectorReason: undefined } as any;

  stamp('read #1 direct file: begin');
  await handleRead(ctx, { file: 'ψ/principles/nothing.md' });
  stamp('read #1 direct file: end');

  stamp('read #2 by id (file-backed): begin');
  await handleRead(ctx, { id: 'doc-principle' });
  stamp('read #2 by id: end');

  stamp('read #3 by id (FTS fallback): begin');
  await handleRead(ctx, { id: 'doc-learning' });
  stamp('read #3 FTS fallback: end');

  stamp('read #4 by search path (FTS fallback): begin');
  await handleRead(ctx, { file: 'ψ/memory/learnings/vector.md' });
  stamp('read #4: end');

  stamp('read #5 missing id: begin');
  await handleRead(ctx, { id: 'missing' });
  stamp('read #5 missing: end');

  stamp('read #6 usage error: begin');
  await handleRead(ctx, {});
  stamp('read #6: end');
  sqlite.close();
  stamp('done');
}, 60_000);
