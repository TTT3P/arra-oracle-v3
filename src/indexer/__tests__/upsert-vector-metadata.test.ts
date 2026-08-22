/**
 * Phase-4a fix 2 — metadata clobber on daemon re-embed. The LanceDB adapter
 * merges with `whenMatchedUpdateAll` on a single opaque `metadata` JSON string,
 * so a daemon upsert that wrote only `{id, indexed_at}` erased
 * type/tenant_id/source_file/concepts/project from an existing full row. The fix
 * gives the daemon a `getDocMeta` dep so the re-embed carries full provenance.
 */
import { describe, expect, test } from 'bun:test';
import { makeUpsertVector, type UpsertCapableStore } from '../upsert-vector.ts';

type Row = { id: string; document: string; metadata: Record<string, string | number>; vector?: number[] };
const MODELS = { 'bge-m3': { collection: 'oracle_bge_m3' } };
const VEC = [0.1, -0.2, 0.3];

function fakeStore() {
  const rows: Row[] = [];
  const store: UpsertCapableStore = {
    name: 'fake-lancedb',
    async addDocuments(docs) {
      for (const doc of docs as Row[]) {
        const at = rows.findIndex((r) => r.id === doc.id);
        if (at >= 0) rows[at] = doc; else rows.push(doc); // mergeInsert-like replace
      }
    },
  };
  return { store, rows };
}

const FULL_META = { type: 'learning', tenant_id: 'default', source_file: 'ψ/memory/learnings/x.md', concepts: 'a,b,c', project: 'github.com/ttt3p/x' };

describe('daemon upsertVector preserves full provenance metadata (Phase-4a fix 2)', () => {
  test('with getDocMeta, the stored row keeps source_file/type/tenant_id/concepts/project + refreshes indexed_at', async () => {
    const { store, rows } = fakeStore();
    const upsert = makeUpsertVector({ models: MODELS, getStore: async () => store, getDocMeta: () => FULL_META, now: () => 123 });
    await upsert('oracle_bge_m3', 'doc-1', VEC, 'real text');
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ ...FULL_META, id: 'doc-1', indexed_at: 123 });
    expect(rows[0].document).toBe('real text');
  });

  test('a re-embed does NOT strip metadata down to {id, indexed_at}', async () => {
    const { store, rows } = fakeStore();
    const upsert = makeUpsertVector({ models: MODELS, getStore: async () => store, getDocMeta: () => FULL_META, now: () => 456 });
    await upsert('oracle_bge_m3', 'doc-1', VEC, 't1'); // first embed
    await upsert('oracle_bge_m3', 'doc-1', VEC, 't2'); // re-embed (would clobber pre-fix)
    expect(rows).toHaveLength(1);                       // mergeInsert: still one row
    expect(rows[0].metadata.source_file).toBe(FULL_META.source_file);
    expect(rows[0].metadata.type).toBe('learning');
    expect(rows[0].metadata.tenant_id).toBe('default');
  });

  test('without getDocMeta, falls back to minimal metadata (unknown-id safe)', async () => {
    const { store, rows } = fakeStore();
    const upsert = makeUpsertVector({ models: MODELS, getStore: async () => store, now: () => 789 });
    await upsert('oracle_bge_m3', 'doc-2', VEC, 'text');
    expect(rows[0].metadata).toEqual({ id: 'doc-2', indexed_at: 789 });
  });
});
