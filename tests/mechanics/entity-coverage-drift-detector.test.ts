/**
 * ORA-MEC chapter 2 — Class C drift detector (FTS ahead of the entity sidecar).
 *
 * Measured live (03-measured-evidence): docsIndexed 11473, docsWithEntities
 * 7422, docsMissingEntities 4051 — FTS is written inline while entity/vector
 * sidecars lag (the drain daemon is not launchd-started; entity-backfill off).
 * `readEntityCoverageStats` is the detector; this pins docsMissingEntities =
 * indexed − withEntities and that a doc with FTS but no entity link counts as
 * drift.
 *
 * Test isolation: entity-coverage.ts imports db/index.ts, which opens a
 * module-level sqlite connection at import time — so HOME/ORACLE_DATA_DIR/
 * ORACLE_DB_PATH are sandboxed BEFORE the dynamic import (fusion.test.ts
 * precedent). The detector itself is exercised against an in-memory fixture DB.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-mec-coverage-'));
const original = { HOME: process.env.HOME, ORACLE_DATA_DIR: process.env.ORACLE_DATA_DIR, ORACLE_DB_PATH: process.env.ORACLE_DB_PATH };
let readEntityCoverageStats!: typeof import('../../src/search/entity-coverage.ts').readEntityCoverageStats;

beforeAll(async () => {
  process.env.HOME = tempRoot;
  process.env.ORACLE_DATA_DIR = tempRoot;
  process.env.ORACLE_DB_PATH = path.join(tempRoot, 'sandbox.db');
  ({ readEntityCoverageStats } = await import('../../src/search/entity-coverage.ts'));
});
afterAll(() => {
  for (const [k, v] of Object.entries(original)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

function fixtureDb(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE oracle_documents (id TEXT PRIMARY KEY, tenant_id TEXT DEFAULT 'default')`);
  db.run(`CREATE VIRTUAL TABLE oracle_fts USING fts5(id UNINDEXED, content, concepts, tokenize='porter unicode61')`);
  db.run(`CREATE TABLE oracle_entity_links (id TEXT PRIMARY KEY, document_id TEXT, tenant_id TEXT DEFAULT 'default', entity_key TEXT)`);
  return db;
}
function addDoc(db: Database, id: string) {
  db.run(`INSERT INTO oracle_documents(id, tenant_id) VALUES(?, 'default')`, [id]);
  db.run(`INSERT INTO oracle_fts(id, content, concepts) VALUES(?, 'x', '')`, [id]);
}

describe('entity-coverage drift detector (Class C)', () => {
  test('docsMissingEntities = indexed - withEntities', () => {
    const db = fixtureDb();
    for (const id of ['d1', 'd2', 'd3', 'd4']) addDoc(db, id);
    db.run(`INSERT INTO oracle_entity_links(id, document_id, tenant_id, entity_key) VALUES('l1','d1','default','k')`);
    const s = readEntityCoverageStats(db, 'default');
    expect(s.docsIndexed).toBe(4);
    expect(s.docsWithEntities).toBe(1);
    expect(s.docsMissingEntities).toBe(3);
    db.close();
  });

  test('a doc with FTS but no entity link is counted as drift', () => {
    const db = fixtureDb();
    addDoc(db, 'only');
    const s = readEntityCoverageStats(db, 'default');
    expect(s.docsIndexed).toBe(1);
    expect(s.docsWithEntities).toBe(0);
    expect(s.docsMissingEntities).toBe(1);
    db.close();
  });

  test('full coverage -> zero drift', () => {
    const db = fixtureDb();
    addDoc(db, 'd1');
    db.run(`INSERT INTO oracle_entity_links(id, document_id, tenant_id, entity_key) VALUES('l1','d1','default','k')`);
    const s = readEntityCoverageStats(db, 'default');
    expect(s.docsMissingEntities).toBe(0);
    expect(s.ratio).toBe(1);
    db.close();
  });
});
