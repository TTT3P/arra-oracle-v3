/**
 * Oracle v2 Logging Functions
 *
 * Refactored to use Drizzle ORM for type-safe queries.
 */

import { eq, sql } from 'drizzle-orm';
import { db, searchLog, documentAccess, learnLog, oracleDocuments, defaultStorageReadonly } from '../db/index.ts';
import type { SearchResult } from './types.ts';
import { tenantIdForWrite } from '../middleware/tenant.ts';

/**
 * Count of logDocumentAccess calls skipped because the DB handle is readonly
 * (ORACLE_VECTOR_READONLY / ORACLE_READ_ONLY — the proxied / read-mostly sidecar). Observability
 * for a KNOWN CENSUS LIMITATION: usage_count and last_accessed_at are NOT recorded for searches
 * served by a readonly sidecar, so the "never read" census undercounts read activity on those
 * paths. CROO owns the census caveat. Read via documentAccessReadonlySkipCount().
 */
let documentAccessReadonlySkips = 0;
export function documentAccessReadonlySkipCount(): number {
  return documentAccessReadonlySkips;
}

/**
 * Log search query with full details
 */
export function logSearch(
  query: string,
  type: string,
  mode: string,
  resultsCount: number,
  searchTimeMs: number,
  results: SearchResult[] = [],
  project?: string
) {
  try {
    // Store top 5 results as JSON (id, type, score, snippet)
    const resultsJson = results.length > 0
      ? JSON.stringify(results.slice(0, 5).map(r => ({
          id: r.id,
          type: r.type,
          score: r.score,
          snippet: r.content?.substring(0, 100)
        })))
      : null;

    db.insert(searchLog).values({
      query,
      type,
      mode,
      resultsCount,
      searchTimeMs,
      createdAt: Date.now(),
      tenantId: tenantIdForWrite(),
      project: project || null,
      results: resultsJson,
    }).run();

    // Comprehensive console logging
    console.error(`\n${'='.repeat(60)}`);
    console.error(`[SEARCH] ${new Date().toISOString()}`);
    if (project) console.error(`  Project: ${project}`);
    console.error(`  Query: "${query}"`);
    console.error(`  Type: ${type} | Mode: ${mode}`);
    console.error(`  Results: ${resultsCount} in ${searchTimeMs}ms`);

    if (results.length > 0) {
      console.error(`  Top Results:`);
      results.slice(0, 5).forEach((r, i) => {
        console.error(`    ${i + 1}. [${r.type}] score=${r.score || 'N/A'} id=${r.id}`);
        console.error(`       ${r.content?.substring(0, 80)}...`);
      });
    }

    // Log any unexpected fields
    if (results.length > 0) {
      const expectedFields = [
        'id', 'type', 'content', 'source_file', 'concepts', 'source', 'score',
        'distance', 'model', 'ftsScore', 'vectorScore', 'pointerScore', 'pointerMatches', 'entity_score',
        'entity_matches', 'entityLinkScore', 'entityLinkMatches', 'confidence', 'provenance',
        'superseded_by', 'superseded_at', 'superseded_reason',
      ];
      const firstResult = results[0] as unknown as Record<string, unknown>;
      const unknownFields = Object.keys(firstResult).filter(k => !expectedFields.includes(k));
      if (unknownFields.length > 0) {
        console.error(`  [UNKNOWN FIELDS]: ${unknownFields.join(', ')}`);
      }
    }
    console.error(`${'='.repeat(60)}\n`);
  } catch (e) {
    console.error('Failed to log search:', e);
  }
}

/**
 * Log document access
 */
export function bumpDocumentUsage(documentId: string, now = Date.now()) {
  db.update(oracleDocuments).set({
    usageCount: sql`${oracleDocuments.usageCount} + 1`,
    lastAccessedAt: now,
  }).where(eq(oracleDocuments.id, documentId)).run();
}

export function logDocumentAccess(documentId: string, accessType: string, project?: string) {
  // On a readonly sidecar every write below throws SQLITE_READONLY on every proxied search result
  // (observed live: 34,690×). Skip cleanly under the single readonly check and count the skip so the
  // census gap is observable. KNOWN LIMITATION: usage_count / last_accessed_at are therefore not
  // recorded for readonly-sidecar (proxied) searches — see documentAccessReadonlySkipCount above.
  if (defaultStorageReadonly()) {
    if (documentAccessReadonlySkips === 0) {
      console.error('[DB] readonly handle — skipping document access/usage writes; usage_count & last_accessed_at will not update for these searches (known census limitation, OM-BL-2026-09-20-03)');
    }
    documentAccessReadonlySkips += 1;
    return;
  }
  try {
    db.insert(documentAccess).values({
      documentId,
      accessType,
      createdAt: Date.now(),
      tenantId: tenantIdForWrite(),
      project: project || null,
    }).run();
  } catch (e) {
    console.error('Failed to log access:', e);
  }
  try {
    bumpDocumentUsage(documentId);
  } catch (e) {
    console.error('Failed to bump document usage:', e);
  }
}

/**
 * Log learning addition
 */
export function logLearning(documentId: string, patternPreview: string, source: string, concepts: string[], project?: string) {
  try {
    db.insert(learnLog).values({
      documentId,
      patternPreview: patternPreview.substring(0, 100),
      source: source || 'Oracle Learn',
      concepts: JSON.stringify(concepts),
      createdAt: Date.now(),
      tenantId: tenantIdForWrite(),
      project: project || null,
    }).run();
  } catch (e) {
    console.error('Failed to log learning:', e);
  }
}
