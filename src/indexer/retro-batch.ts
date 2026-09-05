/**
 * Batch planning for the retros reindex (PR-B slice d, round 2).
 *
 * Two pure pieces, kept apart from the DB loop so they can be falsified on their own:
 *
 *  - file-aligned batches: a batch closes only at a source-file boundary, so one file's chunks
 *    never straddle two transactions. That is what lets the caller supersede legacy rows PER
 *    BATCH without mis-firing (a straddled file would see its own earlier chunks as "stale").
 *  - adaptive sizing: the fleet liveness probe aborts at 2 s (`src/ensure-server.ts`
 *    `AbortSignal.timeout(2000)`), and bun:sqlite blocks the single event loop for the whole
 *    transaction. A fixed N (v1: 250 docs ≈ 4–13 s) read as "dead" on every batch. The sizer
 *    measures the wall time of each batch and steers the next one toward TARGET_MS (a quarter of
 *    the budget), reacting immediately to an overshoot and ramping at most 2× on an undershoot.
 */

import type { OracleDocument } from '../types.ts';

export interface AdaptiveSizing {
  /** Wall-time goal per batch, ms. */
  targetMs: number;
  /** Bounds for the docs-per-batch target (a batch always holds at least one whole file). */
  min: number;
  max: number;
}

/**
 * A quarter of the 2 s liveness abort. Offline canary on a live-size DB (2026-09-05, 4,969 docs):
 * wall ≈ 460 ms fixed per batch (the per-batch tenant pointer scan) + ~16 ms per chunk, with ~3×
 * spikes on some batches. A 1 s target put p50 at 1.1 s and 5/147 batches past 2 s; 500 ms keeps
 * the spikes inside the budget at the cost of more (≈ one-file) batches.
 */
export const DEFAULT_TARGET_MS = 500;
export const DEFAULT_INITIAL_BATCH = 16;
export const DEFAULT_MAX_BATCH = 250;

/**
 * Group documents by source file, preserving first-seen order. `collectDocuments` emits each file's
 * documents contiguously, but grouping here makes "never straddle" hold for ANY input order.
 */
export function groupBySourceFile(documents: OracleDocument[]): OracleDocument[][] {
  const groups = new Map<string, OracleDocument[]>();
  for (const doc of documents) {
    const group = groups.get(doc.source_file);
    if (group) group.push(doc);
    else groups.set(doc.source_file, [doc]);
  }
  return [...groups.values()];
}

export interface PlannedBatch {
  docs: OracleDocument[];
  files: number;
  sourceFiles: string[];
}

/**
 * Take the next batch: whole files, at least one, until the document count reaches `targetDocs`.
 * Consumed groups are cleared from `queue` so their documents become garbage as soon as the caller
 * drops the batch — the JS live set shrinks over the run instead of holding the whole corpus.
 */
export function takeFileAlignedBatch(
  queue: Array<OracleDocument[] | undefined>,
  cursor: { next: number },
  targetDocs: number,
): PlannedBatch | null {
  const docs: OracleDocument[] = [];
  const sourceFiles: string[] = [];
  let files = 0;
  while (cursor.next < queue.length) {
    const group = queue[cursor.next];
    if (!group) { cursor.next++; continue; }
    if (files > 0 && docs.length >= targetDocs) break; // close only at a file boundary
    docs.push(...group);
    sourceFiles.push(group[0].source_file);
    files++;
    queue[cursor.next] = undefined;
    cursor.next++;
  }
  return files === 0 ? null : { docs, files, sourceFiles };
}

/**
 * Next docs-per-batch target from the batch just measured.
 *  - over target: jump straight to the measured ideal (never wait a round while the loop is wedged);
 *  - under target: ramp toward the ideal, at most doubling per step, so a lucky fast batch cannot
 *    launch a 10× larger one that then blocks past the budget.
 */
export function nextBatchTarget(current: number, docs: number, wallMs: number, sizing: AdaptiveSizing): number {
  if (docs <= 0 || !(wallMs > 0)) return clamp(current, sizing);
  const ideal = docs * (sizing.targetMs / wallMs);
  const next = wallMs > sizing.targetMs ? ideal : Math.min(ideal, current * 2);
  return clamp(Math.round(next), sizing);
}

function clamp(n: number, sizing: AdaptiveSizing): number {
  return Math.max(sizing.min, Math.min(sizing.max, n));
}
