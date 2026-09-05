/**
 * The ≤250-line rule, enforced.
 *
 * CLAUDE.md states it as a hard project constraint and every PR asserts
 * compliance, but nothing measured it — 22 tracked files were already over when
 * this test was written, `src/server/handlers.ts` at 844 (3.4×). See #2833.
 *
 * This is a RATCHET, not a cleanup. The current offenders are listed below with
 * their counts so the suite lands green; a new violation, or an existing file
 * growing further, goes red. Landing it red would have got it disabled, which is
 * worse than not having it at all.
 *
 * To fix a file: split it, then lower or delete its entry here. The list only
 * ever shrinks — that is enforced too.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LIMIT = 250;
const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * Known offenders at alpha 9d4ca2f2 (2026-07-25), with the count at that commit, plus the
 * one-time baseline reset of 2026-09-06 (see the second block). A file may not exceed its
 * recorded count — shrinking is always allowed.
 */
const GRANDFATHERED: Record<string, number> = {
  'src/server/handlers.ts': 844,
  'src/drizzle-migration.test.ts': 673,
  'src/vector/__tests__/adapters.test.ts': 615,
  'src/chroma-mcp.ts': 494,
  'cli/src/commands/plugins-install.ts': 395,
  'src/tools/trace.ts': 360,
  'src/tools/schedule.ts': 345,
  'src/tools/forum.ts': 332,
  'src/vector/adapters/cloudflare-vectorize.ts': 324,
  'src/tools/learn.ts': 324,
  // 293, not the 291 on alpha: PR #2832 adds one .use() line for the SPA
  // middleware. Recording the post-merge count keeps that merge from turning
  // alpha red the moment it lands (P9 — green in a worktree is not green on base).
  'src/server.ts': 293,
  'cli/src/cli.ts': 286,
  'src/vector/__tests__/benchmark.ts': 278,

  // Baseline reset #2 — alpha e61768a9, 2026-09-06 (CROO decision, Riddler R-B review).
  // The PR gate had never executed tests/build/ on CI before 2026-09-05 (the loop was
  // ~15% of the suite, see the header), so these ten files were merged over the limit
  // while the check stayed green. Once the gate ran for real it went permanently red on
  // debt that was already on alpha, and every merge needed a branch-protection waiver.
  // A ratchet that is always red ratchets nothing; merged debt belongs in the baseline.
  // Splitting them is backlog OM-BL-2026-09-05-01 (oracle-maint-oracle ψ/backlog), P2.
  // Same rule as above: an entry may only shrink or disappear, never grow.
  'src/maintenance/oracle101-phase-c-repair.ts': 473,
  'src/tools/read.ts': 432,
  'tests/maintenance/oracle101-phase-c-repair.test.ts': 346,
  'src/mcp/server.ts': 329,
  'src/tools/__tests__/backend-tools-unit.test.ts': 291,
  'src/tools/__tests__/learn-enqueue.test.ts': 282,
  'src/indexer/parser.ts': 263,
  'src/indexer/__tests__/prune-guard.test.ts': 262,
  'src/tools/__tests__/read-ghq-origin-mapping-e2e.test.ts': 261,
  'src/config/validate.ts': 257,
};

/**
 * The list only ever shrinks. 13 entries at the first baseline (2026-07-25), 23 after the
 * one-time reset above; a third reset is a CROO decision with a dated comment, not a quiet
 * edit of this number.
 */
const BASELINE_SIZE = 23;

/**
 * Tracked files PLUS untracked-but-not-ignored ones.
 *
 * A plain `git ls-files` misses a file you have written but not staged yet, so
 * the check would stay green locally and only fail in CI. Verified: a 260-line
 * probe file passed until `--others --exclude-standard` was added.
 */
function candidateSources(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '*.ts', '*.tsx'],
    { cwd: REPO_ROOT, encoding: 'utf-8' },
  );
  return [...new Set(out.split('\n').filter(Boolean))];
}

function lineCount(relative: string): number {
  return readFileSync(join(REPO_ROOT, relative), 'utf-8').split('\n').length - 1;
}

const files = candidateSources();

describe('file size rule', () => {
  test('the rule is still documented, so this test still has a mandate', () => {
    const claude = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('250 lines per file');
  });

  test('no NEW file exceeds 250 lines', () => {
    const violations = files
      .filter((f) => !(f in GRANDFATHERED))
      .filter((f) => existsSync(join(REPO_ROOT, f)))
      .map((f) => ({ file: f, lines: lineCount(f) }))
      .filter((entry) => entry.lines > LIMIT)
      .map((entry) => `${entry.file} (${entry.lines})`);

    // If this fails: split the file. Do not add it to GRANDFATHERED —
    // that list is for debt that predates the rule being enforced.
    expect(violations).toEqual([]);
  });

  test('no grandfathered file has grown', () => {
    const grown = Object.entries(GRANDFATHERED)
      .filter(([file]) => existsSync(join(REPO_ROOT, file)))
      .map(([file, allowed]) => ({ file, allowed, actual: lineCount(file) }))
      .filter((entry) => entry.actual > entry.allowed)
      .map((entry) => `${entry.file}: ${entry.actual} > ${entry.allowed}`);

    expect(grown).toEqual([]);
  });

  test('the allow-list never grows past its recorded baseline', () => {
    expect(Object.keys(GRANDFATHERED).length).toBeLessThanOrEqual(BASELINE_SIZE);
  });

  test('the allow-list contains no file that is already compliant or gone', () => {
    // Keeps the ratchet honest: once a file is split or deleted, its entry must
    // go, so the list is always an accurate picture of remaining debt.
    const stale = Object.keys(GRANDFATHERED)
      .map((file) => {
        if (!existsSync(join(REPO_ROOT, file))) return `${file} (deleted)`;
        const actual = lineCount(file);
        return actual <= LIMIT ? `${file} (now ${actual}, compliant)` : '';
      })
      .filter(Boolean);

    expect(stale).toEqual([]);
  });
});
