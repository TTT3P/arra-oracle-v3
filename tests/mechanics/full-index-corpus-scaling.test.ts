/**
 * ORA-MEC chapter 2 — Class A guard (scope=all / full-index event-loop hang).
 *
 * Measured (03-measured-evidence): pointing the full indexer at a SMALL foreign
 * repoRoot against a large shared DB hangs the bun event loop because the
 * smart-delete path (src/indexer/index.ts:135-176) evaluates EVERY existing
 * corpus doc — each `fs.existsSync` under the (wrong) target root marks it stale
 * — and hands the whole set to `buildDeletePlan`. Cost is O(total corpus), not
 * O(target). This guards that buildDeletePlan neither samples nor truncates its
 * input, so the O(corpus) characteristic stays visible/asserted rather than
 * silently "optimised" into a wrong-but-fast partial plan.
 */
import { describe, expect, test } from 'bun:test';
import { buildDeletePlan, sourcePrefix, type DeletePlanRow } from '../../src/indexer/prune-authority.ts';

describe('full-index smart-delete plan scales with the whole corpus (Class A)', () => {
  test('buildDeletePlan processes every input row — no sampling/truncation', () => {
    const rows: DeletePlanRow[] = Array.from({ length: 5000 }, (_, i) => ({
      id: `doc_${i}`,
      sourceFile: `ψ/memory/retrospectives/2026-08/x_${i}.md`,
      project: 'github.com/ttt3p/orchestrator-vnext',
    }));
    const plan = buildDeletePlan(rows);
    expect(plan.rows.length).toBe(5000);
    expect(plan.bySourcePrefix.get('ψ/memory/retrospectives')).toBe(5000);
    expect(plan.byProject.get('github.com/ttt3p/orchestrator-vnext')).toBe(5000);
  });

  test('mixed-project corpus is grouped, not collapsed (the printed scope operators confirm)', () => {
    const rows: DeletePlanRow[] = [
      { id: 'a', sourceFile: 'ψ/memory/learnings/a.md', project: 'github.com/ttt3p/nntn' },
      { id: 'b', sourceFile: 'ψ/memory/learnings/b.md', project: 'github.com/ttt3p/nntn' },
      { id: 'c', sourceFile: 'ψ/memory/retrospectives/c.md', project: null },
    ];
    const plan = buildDeletePlan(rows);
    expect(plan.rows.length).toBe(3);
    expect(plan.byProject.get('github.com/ttt3p/nntn')).toBe(2);
    expect(plan.hasNullProject).toBe(true);
  });

  test('sourcePrefix = first 3 path components', () => {
    expect(sourcePrefix('ψ/memory/learnings/2026-08-22_x.md')).toBe('ψ/memory/learnings');
    expect(sourcePrefix('')).toBe('(unknown)');
  });
});
