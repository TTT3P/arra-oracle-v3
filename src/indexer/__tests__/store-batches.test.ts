import { describe, expect, test } from 'bun:test';
import { makeEnv } from './orphan-rescue-harness.ts';

const { nextBatchSize, storeDocuments, STORE_SLICE_MS } = await import('../storage.ts');

/**
 * Riddler NO-GO on d56e3b46: the batch cursor advanced by the ADAPTED next size, so a grow
 * skipped documents and a shrink rewrote them (40 unique docs → 24 stored). The cursor must
 * move by the batch actually processed, whatever the adaptation says.
 */
function docs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `doc-${String(i).padStart(3, '0')}`, type: 'learning', source_file: `ψ/memory/learnings/doc-${i}.md`,
    content: `document ${i} body`, concepts: ['batch'], created_at: 1, updated_at: 2,
    chunk_index: 0, line_start: 1, line_end: 1,
  }));
}

function storedIds(env: ReturnType<typeof makeEnv>) {
  return (env.sqlite.prepare(`SELECT id FROM oracle_documents ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
}

describe('storeDocuments time-boxed batches', () => {
  test('every document is stored exactly once while the batch size grows and shrinks', async () => {
    const env = makeEnv([]);
    const input = docs(40);
    const sizes: number[] = [];
    // Forced schedule: 8 → 16 (grow) → 4 (shrink) → 32 (grow) → 1 (shrink) → 2 …
    const schedule = [16, 4, 32, 1, 2, 64];
    let call = 0;
    const writes = new Map<string, number>();
    const origRun = env.sqlite.prepare.bind(env.sqlite);
    void origRun;
    process.env.ORACLE_INDEX_YIELD_EVERY = '24';  // initial batch = 24/3 = 8
    try {
      await storeDocuments(env.sqlite, env.db, null, null, input as never, {
        tenantId: 'default',
        nextBatch: (current) => { sizes.push(current); return schedule[call++ % schedule.length]; },
      });
    } finally {
      delete process.env.ORACLE_INDEX_YIELD_EVERY;
    }
    for (const row of env.sqlite.prepare(`SELECT id, indexed_at FROM oracle_documents`).all() as { id: string }[]) {
      writes.set(row.id, (writes.get(row.id) ?? 0) + 1);
    }

    expect(sizes.length).toBeGreaterThan(3);              // adaptation really ran
    expect(sizes).toEqual([8, 16, 4, 32].concat(sizes.slice(4)));  // grow and shrink both happened
    expect(storedIds(env)).toEqual(input.map((d) => d.id)); // no gap, no duplicate
    expect(env.sqlite.prepare(`SELECT COUNT(*) AS n FROM oracle_fts`).get()).toEqual({ n: 40 });
    expect(env.sqlite.prepare(`SELECT COUNT(DISTINCT document_id) AS n FROM oracle_entity_links`).get()).toEqual({ n: 40 });
  });

  test('single-transaction modes store everything too (insertOnly, ORACLE_INDEX_YIELD_EVERY=0)', async () => {
    const env = makeEnv([]);
    process.env.ORACLE_INDEX_YIELD_EVERY = '0';
    try {
      await storeDocuments(env.sqlite, env.db, null, null, docs(30) as never, { tenantId: 'default' });
    } finally {
      delete process.env.ORACLE_INDEX_YIELD_EVERY;
    }
    expect(storedIds(env)).toHaveLength(30);
    const env2 = makeEnv([]);
    await storeDocuments(env2.sqlite, env2.db, null, null, docs(30) as never, { tenantId: 'default', insertOnly: true, createdBy: 'oracle_recovery' });
    expect(storedIds(env2)).toHaveLength(30);
  });

  test('nextBatchSize halves after a slow batch, doubles after a fast one, holds otherwise', () => {
    expect(nextBatchSize(8, STORE_SLICE_MS + 1)).toBe(4);
    expect(nextBatchSize(1, STORE_SLICE_MS * 5)).toBe(1);
    expect(nextBatchSize(8, STORE_SLICE_MS / 4)).toBe(16);
    expect(nextBatchSize(400, 1)).toBe(500);
    expect(nextBatchSize(8, STORE_SLICE_MS / 2)).toBe(8);
  });
});
