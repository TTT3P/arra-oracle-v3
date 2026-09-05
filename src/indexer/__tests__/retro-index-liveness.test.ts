/**
 * Slice(d) round 2 — liveness against the REAL budget, and a bounded JS live set.
 *
 * Riddler P1-2: the fleet health probe (`src/ensure-server.ts`) aborts at 2 s; a fixed 250-doc
 * batch blocked 4–13 s, so the old "the loop ticked between batches" assertion could pass while
 * every probe still timed out. Here the adaptive sizer must keep each batch near its target and
 * the run is measured two ways: setTimeout drift (event-loop lag) and real HTTP round-trips to the
 * real `/health/live` route with the fleet's own 2 s abort. The N=∞ control proves the instruments
 * see a blocked loop. Riddler memory: the loop must accumulate ids only, and release processed
 * files, so heap after the last batch is not the heap after the first plus the whole corpus.
 */
import { afterEach, expect, test } from 'bun:test';
import { createDatabase } from '../../db/index.ts';
import { indexRetrospectives, type RetrosBatchInfo } from '../retro-index.ts';
import { storeDocuments } from '../storage.ts';
import type { OracleDocument } from '../../types.ts';
import { lagSampler, livenessProbe, percentile, retroEnv, runCleanups } from './retro-index-fixtures.ts';

afterEach(runCleanups);

const TARGET_MS = 40;

// Tests f. (loop lag / real /health/live round-trips under the 2 s budget) and g. (JS live set
// plateau) are timing- and memory-sensitive: they failed on the 2-core CI runner and on the control
// node under load, so they run in tests/integration/retro-index-liveness-timing.test.ts through the
// scheduled `scheduled-smokes` workflow, not in the PR gate (audit 2026-09-05, same class as P1-1).

test('i. a second same-process writer (Huginn-style createDatabase + storeDocuments) completes and persists while the reindex runs', async () => {
  // Riddler round-3 reproduction: two real connections from the production factory on one event
  // loop, no mocked storage, no changed busy_timeout. Round 3's outer BEGIN IMMEDIATE around
  // `await storeDocuments` left the write lock held while the loop ran the writer → SQLITE_BUSY.
  const { dbPath, repoRoot } = retroEnv(3, 3, 900);
  const writer = createDatabase(dbPath);
  const doc: OracleDocument = {
    id: 'concurrent_learning', type: 'learning', source_file: 'concurrent-learning.md',
    content: 'Concurrent Huginn-style storage while retrospective indexing runs.', concepts: ['review'],
    created_at: Date.now(), updated_at: Date.now(),
  };
  const indexing = indexRetrospectives(repoRoot, dbPath, { batchSize: 1 });
  let failure: unknown = null;
  try { await storeDocuments(writer.sqlite, writer.db, null, null, [doc]); } catch (err) { failure = err; }
  const result = await indexing;
  const persisted = writer.sqlite.query('SELECT id FROM oracle_documents WHERE id = ?').get(doc.id);
  expect(writer.sqlite.inTransaction).toBe(false);
  writer.sqlite.close();
  expect(failure).toBeNull();
  expect(persisted).not.toBeNull();
  expect(result.batches).toBe(3); // the reindex finished too
  expect(result.ids.length).toBe(18);
}, 15000);
