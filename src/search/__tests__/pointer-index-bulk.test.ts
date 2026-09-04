/**
 * Large-root reindex must maintain the pointer index in ONE tenant scan — the store-phase wedge.
 *
 * `removeDocumentPointers` reads every pointer row for the tenant (there is no reverse doc→pointer
 * index). The old `storeDocuments` called `replaceDocumentPointers` per document, so a reindex of D
 * documents scanned the ~12.5k-row table D times inside one never-yielding transaction — the store
 * phase that wedged the single Bun loop in PR#5 (2026-08-29) and ORACLE-REINDEX-HANDLER-JAM
 * (2026-09-04): busy CPU, stale `oracle.db-wal` mtime, `event=start` without `complete`.
 *
 * These assertions falsify that signature directly:
 *   A. the wired store path runs the tenant scan exactly ONCE regardless of document count;
 *   B. the bulk result is byte-identical to running the per-document path in sequence;
 *   C. against a pre-populated table the bulk path is an order of magnitude faster than per-document
 *      — the linear-vs-quadratic gap. Reverting `storeDocuments` to the per-document call fails A.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { createDatabase } from '../../db/index.ts';
import type { DatabaseConnection } from '../../db/create.ts';
import { storeDocuments } from '../../indexer/storage.ts';
import { replaceDocumentPointers, replaceDocumentPointersBulk, type PointerInput } from '../pointer-index.ts';

const connections: DatabaseConnection[] = [];
const roots: string[] = [];
const DATE = Date.parse('2026-06-05T00:00:00.000Z');

function freshConn(): DatabaseConnection {
  const dir = mkdtempSync(join(tmpdir(), 'arra-pointer-bulk-'));
  roots.push(dir);
  const conn = createDatabase(join(dir, 'oracle.db'));
  connections.push(conn);
  return conn;
}

afterEach(() => {
  for (const conn of connections.splice(0)) conn.storage.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Pre-existing pointer rows for unrelated documents — what a per-document remove must scan past. */
function seedForeignPointers(sqlite: Database, count: number): void {
  const now = Date.now();
  const insert = sqlite.prepare(
    'INSERT INTO oracle_pointer_index (id, tenant_id, kind, key, doc_ids, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  sqlite.transaction(() => {
    for (let i = 0; i < count; i++) {
      insert.run(`default:topic:seed-${i}`, 'default', 'topic', `seed-${i}`, JSON.stringify([`ext-${i}`]), now);
    }
  })();
}

/** Documents whose pointers overlap (shared topic buckets, one shared entity + date) so the merge
 * path is exercised, not just isolated keys. */
function makeInputs(count: number): PointerInput[] {
  return Array.from({ length: count }, (_, i) => ({
    documentId: `doc-${i}`,
    tenantId: 'default',
    content: `Cloudflare Workers edge runtime reindex note ${i} alpha beta gamma`,
    concepts: [`Bucket ${i % 20}`],
    timestamp: DATE,
  }));
}

function dumpPointers(sqlite: Database): string {
  return (sqlite.prepare('SELECT id, doc_ids FROM oracle_pointer_index ORDER BY id').all() as Array<{ id: string; doc_ids: string }>)
    .map((row) => `${row.id}=${row.doc_ids}`)
    .join('\n');
}

const isTenantScan = (sql: string): boolean =>
  /oracle_pointer_index/i.test(sql) && /"tenant_id" = \?/.test(sql) && !/"id" = \?/.test(sql);

test('A. storeDocuments scans the tenant pointer table once for a whole batch, not once per document', async () => {
  const conn = freshConn();
  seedForeignPointers(conn.sqlite, 500);

  let tenantScans = 0;
  const original = conn.sqlite.prepare.bind(conn.sqlite);
  (conn.sqlite as unknown as { prepare: (sql: string, ...rest: unknown[]) => unknown }).prepare = (sql, ...rest) => {
    if (isTenantScan(sql)) tenantScans++;
    return (original as (sql: string, ...rest: unknown[]) => unknown)(sql, ...rest);
  };

  const documents = makeInputs(150).map((input) => ({
    id: input.documentId,
    type: 'learning',
    source_file: `notes/${input.documentId}.md`,
    concepts: input.concepts as string[],
    content: input.content,
    created_at: DATE,
    updated_at: DATE,
  }));
  await storeDocuments(conn.sqlite, conn.db, null, null, documents, { tenantId: 'default' });

  // The old per-document path would make this 150. One scan per store batch is the fix.
  expect(tenantScans).toBe(1);
});

test('B. bulk replace produces the exact pointer state of the per-document path', () => {
  const naive = freshConn();
  const bulk = freshConn();
  seedForeignPointers(naive.sqlite, 300);
  seedForeignPointers(bulk.sqlite, 300);
  const inputs = makeInputs(120);

  for (const input of inputs) replaceDocumentPointers(naive.sqlite, input);
  replaceDocumentPointersBulk(bulk.sqlite, 'default', inputs);

  expect(dumpPointers(bulk.sqlite)).toEqual(dumpPointers(naive.sqlite));
});

test('C. bulk replace is an order of magnitude faster than per-document on a populated table', () => {
  const naive = freshConn();
  const bulk = freshConn();
  seedForeignPointers(naive.sqlite, 3000);
  seedForeignPointers(bulk.sqlite, 3000);
  const inputs = makeInputs(200);

  const t0 = performance.now();
  for (const input of inputs) replaceDocumentPointers(naive.sqlite, input);
  const naiveMs = performance.now() - t0;

  const t1 = performance.now();
  replaceDocumentPointersBulk(bulk.sqlite, 'default', inputs);
  const bulkMs = performance.now() - t1;

  // Same final state, so the speed-up is not from doing less work.
  expect(dumpPointers(bulk.sqlite)).toEqual(dumpPointers(naive.sqlite));
  // Guard against comparing noise, then assert the linear path clears the quadratic by 10x.
  expect(naiveMs).toBeGreaterThan(20);
  expect(bulkMs * 10).toBeLessThan(naiveMs);
});
