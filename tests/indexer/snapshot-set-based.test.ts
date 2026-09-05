/**
 * `snapshotActiveIndexerDocs` (full reindex path, `OracleIndexer.index()`) must equal the intended
 * correlated query byte for byte and must not scan `oracle_fts` once per document.
 *
 * The pre-0042 code built the correlated subquery as a `sql` field of a single-table
 * `db.select` with `${oracleFts.id} = ${oracleDocuments.id}`. Drizzle strips the table qualifier
 * from Column refs inside a selection fragment on a single-table select, so it rendered
 * `WHERE "id" = "id"`: every document's "before" content was the whole FTS table concatenated and
 * `changedDocumentIds` saw every document as changed. That form is reproduced here verbatim as a
 * pinned negative, and the *intended* query (raw SQL with aliases, the probe baseline) is the
 * equality oracle. Even the intended query is O(docs × fts_rows) because `oracle_fts.id` is
 * UNINDEXED (88 s on a 10,719-doc live copy); the set-based form scans once.
 */
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseConnection } from '../../src/db/create.ts';
import { asOracleDb, type OracleDbInput } from '../../src/db/drizzle-input.ts';
import { oracleDocuments, oracleFts } from '../../src/db/schema.ts';
import {
  activeIndexerWhere,
  changedDocumentIds,
  snapshotActiveIndexerDocs,
  type DocSnapshot,
} from '../../src/indexer/reindex-state.ts';
import type { OracleDocument } from '../../src/types.ts';

/** The intended query: one correlated FTS scan per document, aliases so `id` cannot self-resolve. */
function snapshotIntendedCorrelated(input: OracleDbInput, tenantId?: string): DocSnapshot {
  const db = asOracleDb(input);
  const rows = db.select({
    id: oracleDocuments.id,
    sourceFile: oracleDocuments.sourceFile,
    content: sql<string | null>`(
      SELECT GROUP_CONCAT(f.content, char(10)) FROM oracle_fts f WHERE f.id = oracle_documents.id
    )`,
  }).from(oracleDocuments).where(activeIndexerWhere(tenantId)).all();
  return new Map(rows.map((row) => [row.id, { sourceFile: row.sourceFile, content: row.content }]));
}

/** The pre-0042 query, verbatim: renders `WHERE "id" = "id"` (see file header). */
function snapshotPre0042(input: OracleDbInput, tenantId?: string): DocSnapshot {
  const db = asOracleDb(input);
  const rows = db.select({
    id: oracleDocuments.id,
    sourceFile: oracleDocuments.sourceFile,
    content: sql<string | null>`(
      SELECT GROUP_CONCAT(${oracleFts.content}, '\n')
      FROM ${oracleFts}
      WHERE ${oracleFts.id} = ${oracleDocuments.id}
    )`,
  }).from(oracleDocuments).where(activeIndexerWhere(tenantId)).all();
  return new Map(rows.map((row) => [row.id, { sourceFile: row.sourceFile, content: row.content }]));
}

interface DocSpec {
  id: string;
  tenantId?: string;
  createdBy?: string | null;
  supersededBy?: string | null;
  fts?: Array<{ rowid?: number; content: string | null }>;
}

function seed(conn: DatabaseConnection, docs: DocSpec[]): void {
  const now = Date.now();
  const insertDoc = conn.sqlite.query(`insert into oracle_documents
    (id, tenant_id, type, source_file, concepts, created_at, updated_at, indexed_at, created_by, superseded_by, superseded_at)
    values (?, ?, 'learning', ?, '[]', ?, ?, ?, ?, ?, ?)`);
  const insertFts = conn.sqlite.query('insert into oracle_fts (id, content, concepts) values (?, ?, ?)');
  const insertFtsAt = conn.sqlite.query('insert into oracle_fts (rowid, id, content, concepts) values (?, ?, ?, ?)');
  for (const doc of docs) {
    insertDoc.run(doc.id, doc.tenantId ?? 'default', `ψ/memory/learnings/${doc.id}.md`, now, now, now,
      doc.createdBy === undefined ? 'indexer' : doc.createdBy, doc.supersededBy ?? null, doc.supersededBy ? now : null);
    for (const chunk of doc.fts ?? []) {
      if (chunk.rowid === undefined) insertFts.run(doc.id, chunk.content, '');
      else insertFtsAt.run(chunk.rowid, doc.id, chunk.content, '');
    }
  }
}

function fixture(): DatabaseConnection {
  const conn = createDatabase(':memory:');
  seed(conn, [
    { id: 'multi', fts: [{ rowid: 50, content: 'chunk B' }, { rowid: 10, content: 'chunk A' }] },
    { id: 'dup', fts: [{ content: 'first copy' }, { content: 'second copy\nwith newline' }] },
    { id: 'no-fts' },
    { id: 'null-chunk', fts: [{ content: null }, { content: 'real' }] },
    { id: 'all-null', fts: [{ content: null }] },
    { id: 'legacy-null-creator', createdBy: null, fts: [{ content: 'legacy row' }] },
    { id: 'superseded', supersededBy: 'multi', fts: [{ content: 'old generation' }] },
    { id: 'user-doc', createdBy: 'user', fts: [{ content: 'not indexer-owned' }] },
    { id: 'other-tenant', tenantId: 'acme', fts: [{ content: 'tenant acme' }] },
    { id: 'unicode', fts: [{ content: 'ψ/memory — ไทย 🧠' }] },
  ]);
  return conn;
}

const entries = (snap: DocSnapshot) => [...snap.entries()];

test('set-based snapshot equals the intended correlated form byte for byte on a mixed fixture', () => {
  const conn = fixture();
  try {
    const actual = snapshotActiveIndexerDocs(conn.db);
    expect(entries(actual)).toEqual(entries(snapshotIntendedCorrelated(conn.db)));
    expect(actual.get('multi')?.content).toBe('chunk A\nchunk B'); // FTS rowid order, not insert order
    expect(actual.get('dup')?.content).toBe('first copy\nsecond copy\nwith newline');
    expect(actual.get('no-fts')?.content).toBeNull();
    expect(actual.get('null-chunk')?.content).toBe('real');
    expect(actual.get('all-null')?.content).toBeNull();
    expect(actual.get('unicode')?.content).toBe('ψ/memory — ไทย 🧠');
    expect(actual.has('legacy-null-creator')).toBe(true);
    expect(actual.has('other-tenant')).toBe(true);
    expect(actual.has('superseded')).toBe(false);
    expect(actual.has('user-doc')).toBe(false);
    for (const tenant of ['default', 'acme', 'missing']) {
      expect(entries(snapshotActiveIndexerDocs(conn.db, tenant))).toEqual(entries(snapshotIntendedCorrelated(conn.db, tenant)));
    }
    expect(snapshotActiveIndexerDocs(conn.db, 'acme').size).toBe(1);
  } finally {
    conn.storage.close();
  }
});

test('pinned negative: the pre-0042 drizzle form gave every document the whole FTS table (WHERE "id" = "id")', () => {
  const conn = fixture();
  try {
    const wrong = snapshotPre0042(conn.db);
    const everything = wrong.get('multi')?.content;
    expect(everything).toContain('tenant acme'); // another document's chunk
    expect(wrong.get('no-fts')?.content).toBe(everything!); // even a document with no FTS row
    expect(entries(wrong)).not.toEqual(entries(snapshotIntendedCorrelated(conn.db)));

    // Consequence on the full reindex path: an unchanged document was reported as changed.
    const unchanged = { id: 'multi', content: 'chunk A\nchunk B' } as OracleDocument;
    expect(changedDocumentIds(wrong, [unchanged]).has('multi')).toBe(true);
    expect(changedDocumentIds(snapshotActiveIndexerDocs(conn.db), [unchanged]).has('multi')).toBe(false);
  } finally {
    conn.storage.close();
  }
});

test('accepts a raw bun Database through the OracleDbInput seam and leaves no temp objects behind', () => {
  const conn = fixture();
  try {
    expect(entries(snapshotActiveIndexerDocs(conn.sqlite))).toEqual(entries(snapshotActiveIndexerDocs(conn.db)));
    expect(conn.sqlite.query<{ c: number }, []>('select count(*) as c from sqlite_temp_master').get()?.c).toBe(0);
  } finally {
    conn.storage.close();
  }
});

function timeSnapshot(run: (input: OracleDbInput) => DocSnapshot, docs: number): number {
  const conn = createDatabase(':memory:');
  try {
    conn.sqlite.exec('begin');
    seed(conn, Array.from({ length: docs }, (_, i) => ({ id: `d${i}`, fts: [{ content: `body ${i}` }] })));
    conn.sqlite.exec('commit');
    expect(run(conn.db).size).toBe(docs); // warm + sanity
    const t0 = performance.now();
    run(conn.db);
    return performance.now() - t0;
  } finally {
    conn.storage.close();
  }
}

test('scaling: at 3000 docs the set-based form is ≥ 5x faster than the intended correlated form, whose per-doc cost grows with the table', () => {
  const setBased = timeSnapshot(snapshotActiveIndexerDocs, 3000);
  const correlatedSmall = timeSnapshot(snapshotIntendedCorrelated, 300);
  const correlatedLarge = timeSnapshot(snapshotIntendedCorrelated, 3000);
  expect(correlatedLarge / setBased).toBeGreaterThan(5);
  expect((correlatedLarge / 3000) / (correlatedSmall / 300)).toBeGreaterThan(4); // O(fts_rows) per doc
});

test('source lint: no Column refs interpolated into the snapshot SQL, no correlated FTS subquery, no .run() metadata', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/indexer/reindex-state.ts'), 'utf8');
  const body = source.slice(source.indexOf('export function snapshotActiveIndexerDocs'), source.indexOf('export function changedDocumentIds'));
  expect(body).not.toMatch(/\$\{oracle(Fts|Documents)\.\w+\}/);
  expect(body).not.toMatch(/FROM oracle_fts\s+(\w+\s+)?WHERE/); // no per-document FTS predicate
  expect(body).toMatch(/CREATE TEMP TABLE fts_snapshot_rows/);
  expect(body).toMatch(/ORDER BY r\)/);
  expect(source).not.toMatch(/\.run\(\)\.(changes|lastInsertRowid)/);
});
