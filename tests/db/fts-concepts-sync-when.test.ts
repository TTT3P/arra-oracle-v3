/**
 * Migration 0042: `oracle_documents_fts_concepts_sync` fires only when `concepts` changes.
 *
 * `oracle_fts.id` is UNINDEXED, so every firing is a full FTS scan. The indexer upsert rewrites
 * `concepts` on every re-index (src/indexer/storage.ts), so before 0042 the trigger paid that scan
 * per chunk even when the value was identical — and the delete + insert that follows replaced the
 * FTS row anyway. Observable used here: the FTS row's `concepts` is seeded with a sentinel that
 * differs from the document's; a firing overwrites it, a skipped firing leaves it.
 *
 * `oracle_documents.concepts` is NOT NULL (pragma table_info), so NULL transitions cannot occur on
 * this table; `IS NOT` is used so the trigger stays correct if that ever changes.
 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, type DatabaseConnection } from '../../src/db/create.ts';
import { createStorageBackend } from '../../src/storage/registry.ts';
import type { StorageBackend } from '../../src/storage/types.ts';

const TRIGGER = 'oracle_documents_fts_concepts_sync';
const MIGRATION_0042 = 1788582491000;
/** The 0032 form of the trigger (no WHEN) — used as the negative control and to build a 0041 DB. */
const TRIGGER_0032_SQL = `CREATE TRIGGER IF NOT EXISTS ${TRIGGER}
AFTER UPDATE OF concepts ON oracle_documents
BEGIN
  UPDATE oracle_fts SET concepts = NEW.concepts WHERE id = NEW.id;
END;`;

let conn: DatabaseConnection | undefined;
let backend: StorageBackend | undefined;
let tempDir = '';

afterEach(() => {
  conn?.storage.close();
  conn = undefined;
  backend?.close();
  backend = undefined;
  if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
  tempDir = '';
});

function triggerSql(sqlite: Database): string | undefined {
  return sqlite.query<{ sql: string }, [string]>(
    "select sql from sqlite_master where type = 'trigger' and name = ?",
  ).get(TRIGGER)?.sql;
}

function seedDoc(sqlite: Database, id: string, concepts: string): void {
  const now = Date.now();
  sqlite.query(`insert into oracle_documents (id, type, source_file, concepts, created_at, updated_at, indexed_at, created_by)
    values (?, 'learning', ?, ?, ?, ?, ?, 'indexer')`).run(id, `ψ/memory/learnings/${id}.md`, concepts, now, now, now);
  sqlite.query('insert into oracle_fts (id, content, concepts) values (?, ?, ?)').run(id, `content of ${id}`, 'SENTINEL');
}

function ftsConcepts(sqlite: Database, id: string): string[] {
  return sqlite.query<{ concepts: string }, [string]>('select concepts from oracle_fts where id = ?')
    .all(id).map((row) => row.concepts);
}

function updateConcepts(sqlite: Database, id: string, concepts: string): void {
  sqlite.query('update oracle_documents set concepts = ? where id = ?').run(concepts, id);
}

test('fresh DB from the migrations folder installs the WHEN form of the trigger exactly once', () => {
  conn = createDatabase(':memory:');
  const count = conn.sqlite.query<{ c: number }, [string]>(
    "select count(*) as c from sqlite_master where type = 'trigger' and name = ?",
  ).get(TRIGGER)?.c;
  expect(count).toBe(1);
  expect(triggerSql(conn.sqlite)).toMatch(/WHEN OLD\.concepts IS NOT NEW\.concepts/);
});

test('trigger matrix: same value does not touch FTS, a different value syncs it', () => {
  conn = createDatabase(':memory:');
  const { sqlite } = conn;
  seedDoc(sqlite, 'doc-same', '["a","b"]');
  seedDoc(sqlite, 'doc-diff', '["a","b"]');

  updateConcepts(sqlite, 'doc-same', '["a","b"]'); // value → same: must NOT fire
  expect(ftsConcepts(sqlite, 'doc-same')).toEqual(['SENTINEL']);

  updateConcepts(sqlite, 'doc-diff', '["a","c"]'); // value → different: must fire
  expect(ftsConcepts(sqlite, 'doc-diff')).toEqual(['["a","c"]']);

  // A non-concepts update never fires (UPDATE OF concepts), before and after 0042.
  sqlite.query('update oracle_documents set updated_at = updated_at + 1 where id = ?').run('doc-same');
  expect(ftsConcepts(sqlite, 'doc-same')).toEqual(['SENTINEL']);
});

test('trigger with duplicate FTS rows for one id syncs all of them on a real change only', () => {
  conn = createDatabase(':memory:');
  const { sqlite } = conn;
  seedDoc(sqlite, 'doc-dup', 'x');
  sqlite.query('insert into oracle_fts (id, content, concepts) values (?, ?, ?)').run('doc-dup', 'second chunk', 'SENTINEL');

  updateConcepts(sqlite, 'doc-dup', 'x');
  expect(ftsConcepts(sqlite, 'doc-dup')).toEqual(['SENTINEL', 'SENTINEL']);
  updateConcepts(sqlite, 'doc-dup', 'y');
  expect(ftsConcepts(sqlite, 'doc-dup')).toEqual(['y', 'y']);
});

test('negative control: the 0032 form overwrites FTS on a same-value update (probe is sensitive)', () => {
  conn = createDatabase(':memory:');
  const { sqlite } = conn;
  sqlite.exec(`drop trigger if exists ${TRIGGER}`);
  sqlite.exec(TRIGGER_0032_SQL);
  expect(triggerSql(sqlite)).not.toMatch(/WHEN/);

  seedDoc(sqlite, 'doc-nc', '["a"]');
  updateConcepts(sqlite, 'doc-nc', '["a"]');
  expect(ftsConcepts(sqlite, 'doc-nc')).toEqual(['["a"]']);
});

test('indexer upsert sequence (update concepts, delete FTS by id, insert) leaves exactly one row', () => {
  conn = createDatabase(':memory:');
  const { sqlite } = conn;
  seedDoc(sqlite, 'doc-seq', '["k"]');
  for (const concepts of ['["k"]', '["k"]', '["k","z"]']) {
    sqlite.exec('begin');
    updateConcepts(sqlite, 'doc-seq', concepts);
    sqlite.query('delete from oracle_fts where id = ?').run('doc-seq');
    sqlite.query('insert into oracle_fts (id, content, concepts) values (?, ?, ?)').run('doc-seq', 'body', concepts);
    sqlite.exec('commit');
    expect(ftsConcepts(sqlite, 'doc-seq')).toEqual([concepts]);
  }
});

test('upgrade path: a DB at 0041 gets the WHEN trigger on startup and 0042 is recorded (drift repair does not skip it)', () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-fts-concepts-when-'));
  const dbPath = path.join(tempDir, 'oracle.db');
  backend = createStorageBackend({ dbPath });
  backend.close();
  backend = undefined;

  // Rewind to a 0041 DB: the 0032 trigger form is present, 0042 is not recorded.
  const raw = new Database(dbPath);
  raw.exec(`drop trigger if exists ${TRIGGER}`);
  raw.exec(TRIGGER_0032_SQL);
  raw.query('delete from __drizzle_migrations where created_at = ?').run(MIGRATION_0042);
  expect(triggerSql(raw)).not.toMatch(/WHEN/);
  raw.close();

  // repairAdditiveMigrationDrift sees a trigger of that name and would call the CREATE "already
  // applied"; it must fall through (DROP TRIGGER is not a repairable statement) so migrate() runs
  // the real DROP + CREATE. The proof is the trigger body, not the migrations row.
  backend = createStorageBackend({ dbPath });
  expect(triggerSql(backend.sqlite)).toMatch(/WHEN OLD\.concepts IS NOT NEW\.concepts/);
  const recorded = backend.sqlite.query<{ c: number }, [number]>(
    'select count(*) as c from __drizzle_migrations where created_at = ?',
  ).get(MIGRATION_0042)?.c;
  expect(recorded).toBe(1);

  // And a second startup is a no-op (idempotent).
  backend.close();
  backend = createStorageBackend({ dbPath });
  expect(triggerSql(backend.sqlite)).toMatch(/WHEN/);
  expect(backend.sqlite.query<{ c: number }, [string]>(
    "select count(*) as c from sqlite_master where type = 'trigger' and name = ?",
  ).get(TRIGGER)?.c).toBe(1);
});
