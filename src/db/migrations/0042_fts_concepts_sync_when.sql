-- 0042: oracle_documents_fts_concepts_sync fires only when `concepts` actually changes.
--
-- Why: the indexer upsert (src/indexer/storage.ts) rewrites `concepts` on every re-index of a
-- document, and oracle_fts.id is UNINDEXED (FTS5), so the 0032 AFTER UPDATE OF concepts trigger
-- ran a second full scan of oracle_fts per chunk even when the value was unchanged. The delete +
-- insert that follows replaces the FTS row anyway, so that scan was pure cost.
-- Semantics when `concepts` does change are identical to 0032; `IS NOT` treats NULL<->value as a
-- change and NULL<->NULL as no change.
-- Additive: DROP + CREATE of one trigger, transactional, milliseconds; no data is touched.
-- Rollback: recreate the 0032 form of the trigger (no data changes).
DROP TRIGGER IF EXISTS oracle_documents_fts_concepts_sync;
--> statement-breakpoint
CREATE TRIGGER oracle_documents_fts_concepts_sync
AFTER UPDATE OF concepts ON oracle_documents
WHEN OLD.concepts IS NOT NEW.concepts
BEGIN
  UPDATE oracle_fts SET concepts = NEW.concepts WHERE id = NEW.id;
END;
