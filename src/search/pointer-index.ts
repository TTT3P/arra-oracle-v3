import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from 'bun:sqlite';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from '../db/schema.ts';
import { extractEntities } from '../vector/entities.ts';
import { expansionPhrasesForText } from './acronyms.ts';
import { conceptValues, dateKeys, dateKeysFromText, parseIds, rankDocs } from './pointer-ranking.ts';
import { hydratePointerDocs } from './pointer-hydrate.ts';
import { entityKey } from './entity-ranking.ts';

type OracleDb = BunSQLiteDatabase<typeof schema>;
type OracleDbInput = OracleDb | Database;
type PointerKind = 'topic' | 'entity' | 'date';
type Pointer = { kind: PointerKind; key: string; label: string };
export type PointerKindName = PointerKind;
type PointerRow = { id: string; kind: PointerKind; key: string; docIds: string };


export type PointerInput = {
  documentId: string;
  tenantId?: string;
  content: string;
  concepts?: unknown;
  timestamp?: number;
};
export type PointerSearchResult = {
  id: string; type: string; content: string; source_file: string; concepts: string[];
  score: number; source: 'pointer'; pointerScore: number; pointerMatches: string[];
};
export type PointerSearchOptions = {
  query: string; type?: string; project?: string | null; tenantId?: string; limit?: number;
};

const STOPWORDS = new Set(['and', 'are', 'for', 'from', 'into', 'the', 'this', 'that', 'with', 'what', 'when', 'where']);

function toDb(input: OracleDbInput): OracleDb {
  return 'prepare' in input ? drizzle(input, { schema }) : input;
}

// Whether `oracle_pointer_index` exists at all. A fresh database before migration legitimately
// lacks it — that is the ONLY condition under which the pointer writers skip. Deciding this from a
// catalog lookup (not by pattern-matching an error string) means every actual failure during the
// writes — a constraint, a trigger, a corrupt row — propagates and rolls the transaction back,
// instead of being mistaken for "table missing" and swallowed into a silent partial commit.
function pointerTableExists(db: OracleDb): boolean {
  const row = db.get(
    sql`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'oracle_pointer_index' LIMIT 1`,
  );
  return row != null;
}

export function documentPointers(input: PointerInput): Pointer[] {
  return uniquePointers([
    ...conceptValues(input.concepts).map((topic) => pointer('topic', topic)),
    ...extractEntities(input.content, input.concepts).map((entity) => pointer('entity', entity)),
    ...dateKeys(input.timestamp).map((key) => ({ kind: 'date' as const, key, label: key })),
  ]);
}

export function replaceDocumentPointers(dbInput: OracleDbInput, input: PointerInput): void {
  // The incremental single-document path is exactly the one-element batch.
  replaceDocumentPointersBulk(dbInput, input.tenantId, [input]);
}

/**
 * Replace pointers for a whole store batch in one tenant scan.
 *
 * `removeDocumentPointers` reads *every* pointer row for the tenant — there is no reverse
 * doc→pointer index; `doc_ids` is a forward-only JSON array. Calling it per document (as the old
 * `replaceDocumentPointers` did, once per doc inside `storeDocuments`) is O(pointer_rows ×
 * documents): the store phase that wedged the single Bun loop in the PR#5 (2026-08-29) and
 * ORACLE-REINDEX-HANDLER-JAM (2026-09-04) incidents — ~12.5k rows re-scanned and JSON-parsed for
 * each of ~5k docs, all inside one transaction that never yields, so the WAL commit never lands.
 *
 * Here the tenant scan runs ONCE for the batch, then new memberships are accumulated in memory and
 * written one upsert per touched pointer key (indexed primary key) — O(pointer_rows + Σpointers).
 * The final state is identical to running the per-document path in sequence: every batch document
 * is removed from the rows it no longer belongs to, then added back only to its own keys. The
 * accumulator mirrors `workers/pointer-backfill.ts`, which avoids the same quadratic for the
 * whole-corpus backfill. All inputs are assumed to share `tenantId`, which every `storeDocuments`
 * call guarantees.
 */
export function replaceDocumentPointersBulk(
  dbInput: OracleDbInput,
  tenantId: string | undefined,
  inputs: PointerInput[],
): void {
  if (inputs.length === 0) return;
  const db = toDb(dbInput);
  // Fresh-DB skip decided by catalog, not by error text — see pointerTableExists.
  if (!pointerTableExists(db)) return;
  const tenant = tenantId?.trim() || 'default';
  // A document id repeated within one batch is last-write-wins — exactly what running the
  // per-document path in sequence leaves behind (the later write removes the id from every row,
  // then re-adds only its own keys). Collapse to the last input per id BEFORE removal and
  // accumulation; otherwise the id would be UNIONed across both inputs' keys while the
  // documents / FTS / entity rows storeDocuments writes keep only the last, leaving the indexes
  // inconsistent.
  const lastByDoc = new Map<string, PointerInput>();
  for (const input of inputs) lastByDoc.set(input.documentId, input);
  const effective = [...lastByDoc.values()];
  // One scan removes every re-indexed document from its stale pointer rows.
  removeDocumentPointers(db, tenant, effective.map((input) => input.documentId));
  // Accumulate the fresh memberships so each pointer key is written exactly once.
  const accumulated = new Map<string, { kind: PointerKind; key: string; docIds: Set<string> }>();
  for (const input of effective) {
    for (const item of documentPointers(input)) {
      const id = pointerId(tenant, item.kind, item.key);
      const entry = accumulated.get(id);
      if (entry) entry.docIds.add(input.documentId);
      else accumulated.set(id, { kind: item.kind, key: item.key, docIds: new Set([input.documentId]) });
    }
  }
  const now = Date.now();
  for (const [id, entry] of accumulated) {
    const existingRow = db.select({ docIds: schema.oraclePointerIndex.docIds })
      .from(schema.oraclePointerIndex)
      .where(eq(schema.oraclePointerIndex.id, id))
      .get();
    const docIds = [...new Set([...parseIds(existingRow?.docIds), ...entry.docIds])].sort();
    db.insert(schema.oraclePointerIndex)
      .values({ id, tenantId: tenant, kind: entry.kind, key: entry.key, docIds: JSON.stringify(docIds), updatedAt: now })
      .onConflictDoUpdate({
        target: schema.oraclePointerIndex.id,
        set: { docIds: JSON.stringify(docIds), updatedAt: now },
      })
      .run();
  }
}

export function removeDocumentPointers(dbInput: OracleDbInput, tenantId: string | undefined, documentIds: string[]): void {
  if (documentIds.length === 0) return;
  const db = toDb(dbInput);
  if (!pointerTableExists(db)) return;
  const tenant = tenantId?.trim() || 'default';
  const rows = db.select({
    id: schema.oraclePointerIndex.id,
    kind: schema.oraclePointerIndex.kind,
    key: schema.oraclePointerIndex.key,
    docIds: schema.oraclePointerIndex.docIds,
  }).from(schema.oraclePointerIndex)
    .where(eq(schema.oraclePointerIndex.tenantId, tenant))
    .all() as PointerRow[];
  const remove = new Set(documentIds);
  const now = Date.now();
  for (const row of rows) {
    const existing = parseIds(row.docIds);
    const next = existing.filter((id) => !remove.has(id));
    if (next.length === 0) {
      db.delete(schema.oraclePointerIndex).where(eq(schema.oraclePointerIndex.id, row.id)).run();
    } else if (next.length !== existing.length) {
      db.update(schema.oraclePointerIndex)
        .set({ docIds: JSON.stringify(next), updatedAt: now })
        .where(eq(schema.oraclePointerIndex.id, row.id))
        .run();
    }
  }
}

export function queryPointerIndex(dbInput: OracleDbInput, options: PointerSearchOptions): PointerSearchResult[] {
  const db = toDb(dbInput);
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 10)));
  const tenantId = options.tenantId?.trim() || 'default';
  const keys = queryPointers(options.query);
  if (keys.length === 0) return [];
  if (!pointerTableExists(db)) return [];
  const rows = lookupPointerRows(db, tenantId, keys);
  const ranked = rankDocs(rows, keys);
  return hydratePointerDocs(db, ranked, { ...options, tenantId, limit });
}

export function queryPointers(query: string): Pointer[] {
  const words = query.normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}._-]{2,}/gu)
    ?.map((word) => word.toLowerCase()).filter((word) => !STOPWORDS.has(word)) ?? [];
  return uniquePointers([
    ...words.map((word) => pointer('topic', word)),
    ...adjacent(words).map((phrase) => pointer('topic', phrase)),
    ...extractEntities(query).map((entity) => pointer('entity', entity)),
    // Acronym expansions as known phrases, not recovered from the text.
    //
    // `augmentQueryWithAcronyms` appends expansions bare, so two of them end up adjacent and
    // `extractEntities` merges them: "what does the API and db do" yields the entity pointer
    // `application-programming-interface-database`, and the real
    // `application-programming-interface` is absent. Single-word expansions like `database`
    // survive only by accident — every word is also added as an entity pointer below — so the
    // loss is silent and hits multi-word expansions only. Same defect as #2876, second signal.
    ...expansionPhrasesForText(query).map((expansion) => pointer('entity', expansion)),
    ...words.map((word) => pointer('entity', word)),
    ...dateKeysFromText(query).map((key) => ({ kind: 'date' as const, key, label: key })),
  ]).slice(0, 24);
}

function lookupPointerRows(db: OracleDb, tenantId: string, keys: Pointer[]): PointerRow[] {
  const clauses = keys.map((item) => and(
    eq(schema.oraclePointerIndex.kind, item.kind),
    eq(schema.oraclePointerIndex.key, item.key),
  )).filter((clause): clause is SQL => clause !== undefined);
  const pointerMatch = or(...clauses);
  if (!pointerMatch) return [];
  return db.select({
    id: schema.oraclePointerIndex.id,
    kind: schema.oraclePointerIndex.kind,
    key: schema.oraclePointerIndex.key,
    docIds: schema.oraclePointerIndex.docIds,
  }).from(schema.oraclePointerIndex)
    .where(and(eq(schema.oraclePointerIndex.tenantId, tenantId), pointerMatch))
    .all() as PointerRow[];
}

function pointer(kind: PointerKind, value: string): Pointer { return { kind, key: entityKey(value), label: value.trim() }; }
function pointerId(tenantId: string, kind: PointerKind, key: string): string { return `${tenantId}:${kind}:${key}`; }
function uniquePointers(items: Pointer[]): Pointer[] {
  const out = new Map<string, Pointer>();
  for (const item of items) if (item.key) out.set(`${item.kind}:${item.key}`, item);
  return [...out.values()];
}
function adjacent(words: string[]): string[] { return words.slice(0, -1).map((word, i) => `${word} ${words[i + 1]}`); }

// Only a genuine "table does not exist" is a legitimate skip (fresh DB before migration). Matching
// any message that merely contains the table name would swallow a constraint or trigger failure
// mid-batch — after removal has already cleared memberships and some keys were re-upserted — and let
// storeDocuments commit that partial pointer state. Require the SQLite no-such-table phrasing so
// every other error propagates and rolls the transaction back.
