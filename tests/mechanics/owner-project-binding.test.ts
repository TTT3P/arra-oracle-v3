/**
 * ORA-MEC chapter 2 — owner-project binding.
 *
 * A document's owner project is derived from its ghq-style source path and
 * lowercased (src/indexer/discovery.ts:inferProjectFromPath; storage.ts stores
 * project lowercased). This is what let ORA-MMR bind the maw-maint learning to
 * `github.com/ttt3p/maw-maint-oracle` and what keeps foreign-owner memory
 * attributed to its owner rather than the canonical root. Guards the mapping.
 */
import { describe, expect, test } from 'bun:test';
import { inferProjectFromPath } from '../../src/indexer/discovery.ts';

describe('owner-project binding from source path', () => {
  test('project-first github path -> github.com/org/repo, lowercased', () => {
    expect(inferProjectFromPath('github.com/TTT3P/maw-maint-oracle/ψ/memory/learnings/x.md'))
      .toBe('github.com/ttt3p/maw-maint-oracle');
  });

  test('legacy ψ/memory/learnings/github.com/... layout', () => {
    expect(inferProjectFromPath('ψ/memory/learnings/github.com/ttt3p/nntn/2026-08-22_x.md'))
      .toBe('github.com/ttt3p/nntn');
  });

  test('crew ψ-brain path -> crew/<member>', () => {
    expect(inferProjectFromPath('ψ/crew/riddler/memory/x.md')).toBe('crew/riddler');
  });

  test('non-project path -> null (unattributed/root bucket)', () => {
    expect(inferProjectFromPath('ψ/memory/learnings/2026-08-22_maw-fleet-record-mechanics.md')).toBeNull();
  });
});
