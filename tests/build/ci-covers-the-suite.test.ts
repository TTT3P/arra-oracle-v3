/**
 * The CI gate and the documented local gate must be the same command over the same suite.
 *
 * They were not. CI ran a hand-maintained `find(1)` list of 183 files — **15% of the 1,221
 * test files in this repo**. Whole directories were never executed, including
 * `tests/frontend/` (228 files) and `tests/build/`, which holds the 250-line ratchet and the
 * test-scope guard. Consequences, both real:
 *
 *  - #2848 left four tests red on `alpha` for hours while its check was green.
 *  - Two tests in `src/routes/menu/__tests__` had been red since #1857 (#2862).
 *
 * And the docs told contributors to run `bun test <path>` while CI ran
 * `bun test --isolate <path>` — different module semantics, so a local red could be a leaked
 * `mock.module` rather than a real failure, and a local green could be hiding one.
 *
 * Sibling of `test-scope.test.ts`, which exists because a *different* test-scoping bug (#2825)
 * also shipped silently. See #2853.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';


const ROOT = join(import.meta.dir, '..', '..');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf-8');
const CLAUDE_MD = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf-8');

/**
 * Directories the CI workflow passes to `bun test` — read from the one heredoc list
 * (`<<'GROUPS'` … `GROUPS`) in the "Run unit tests" step. The loop iterates that same file,
 * and the "Gate verdict" step requires a recorded result for every entry in it, so this is
 * the single source of truth for what the gate runs.
 *
 * (An earlier version parsed a `for group in … do` list and had to split on the shell keyword
 * `do` at the start of its own line — a bare `.split('do')` truncated the list at `tests/docs`
 * and reported 20 phantom uncovered groups on the first run of this very test.)
 */
function ciGroups(): string[] {
  const after = WORKFLOW.split("<<'GROUPS'")[1] ?? '';
  const block = after.split(/\n\s*GROUPS\b/)[0] ?? '';
  return block
    .split(/\s+/)
    .map((entry) => entry.trim().replace(/\/$/, ''))
    .filter((entry) => entry.startsWith('src') || entry.startsWith('tests'));
}

/**
 * Top-level groups that actually contain test files, from git — not from a glob, so
 * .gitignore is respected and an untracked scratch file cannot fail the gate.
 *
 * `Bun.spawnSync` rather than the `$` shell helper: the shell form took over 5 s on the CI
 * runner and tripped bun's default per-test timeout, failing this gate for a reason that had
 * nothing to do with coverage.
 */
function suiteGroups(): string[] {
  const proc = Bun.spawnSync(['git', '-C', ROOT, 'ls-files'], { stdout: 'pipe' });
  const tracked = new TextDecoder().decode(proc.stdout).split('\n');
  const groups = new Set<string>();
  for (const file of tracked) {
    if (!/\.test\.tsx?$/.test(file)) continue;
    if (file.startsWith('agents/')) continue;
    const parts = file.split('/');
    if (parts[0] === 'tests') groups.add(`tests/${parts[1]}`);
    else if (parts[0] === 'src') groups.add('src');
  }
  return [...groups];
}

/**
 * Groups CI deliberately skips. Each needs a reason — an unexplained exclusion is how the
 * 85% gap accumulated in the first place.
 */
const DELIBERATELY_EXCLUDED: Record<string, string> = {
  'tests/integration': 'docker-backed smokes (compose stack, README hero path) run in the scheduled scheduled-smokes workflow, not the PR gate',
  'tests/benchmarks': 'timing-sensitive; belongs in a scheduled job, not a PR gate',
  'tests/e2e': '*.e2e.ts needs a browser and is not picked up by bun test',
};

describe('CI runs the whole test suite', () => {
  test('every group containing tests is either run by CI or explicitly excluded', () => {
    const covered = new Set(ciGroups());
    const missing = suiteGroups().filter(
      (group) => !covered.has(group) && !(group in DELIBERATELY_EXCLUDED),
    );

    // If this fails: add the group to the loop in .github/workflows/test.yml, or add it to
    // DELIBERATELY_EXCLUDED with a reason. Do not delete this test.
    expect(missing).toEqual([]);
  });

  test('each exclusion is recorded in the workflow so it is visible at the gate', () => {
    for (const group of Object.keys(DELIBERATELY_EXCLUDED)) {
      expect(WORKFLOW).toContain(group);
    }
  });

  test('CI covers the two groups whose absence caused real regressions', () => {
    const covered = new Set(ciGroups());
    expect(covered.has('tests/frontend')).toBe(true); // #2848's four red tests lived here
    expect(covered.has('tests/build')).toBe(true); // the 250-line ratchet lives here
  });

  test('the list is read from the heredoc the loop actually iterates, and is not empty', () => {
    // The loop reads $GATE_EXPECTED, written from the heredoc; the verdict step walks the
    // same file. If either side stops using it, this parser is reading dead text.
    expect(WORKFLOW).toContain('cat > "$GATE_EXPECTED" <<\'GROUPS\'');
    expect(WORKFLOW).toContain('for group in $(cat "$GATE_EXPECTED")');
    expect(ciGroups().length).toBeGreaterThanOrEqual(35);
  });
});

describe('the gate cannot pass by omission', () => {
  // Riddler R-B (2026-09-06): the loop used to exit on the first red group, so 34 groups had
  // never run on CI; and GitHub counts a skipped required check as passing. The verdict step
  // must run unconditionally and reject anything but a recorded pass for every group.
  const verdict = WORKFLOW.split('- name: Gate verdict')[1] ?? '';

  test('a verdict step exists, runs with always(), and is the only step that exits on results', () => {
    expect(verdict).toContain('if: always()');
    expect(verdict).toContain('steps.groups.outcome');
    // The loop itself must not abort on a failing group — that is what hid the other groups.
    const loop = WORKFLOW.split('- name: Run unit tests')[1]?.split('- name: Gate verdict')[0] ?? '';
    expect(loop).not.toMatch(/\n\s*exit "\$status"/);
    // GitHub's `shell: bash` is `bash -eo pipefail`; without an explicit `set +e` the first
    // failing `bun test` aborts the loop (PR #25's first run stopped inside tests/http/).
    expect(loop).toContain('set +e');
    expect(loop).toContain('>> "$GATE_RESULTS"');
  });

  test('the verdict rejects a skipped/cancelled test step and a missing group row', () => {
    expect(verdict).toContain('!= "success"');
    expect(verdict).toContain('no result recorded');
    expect(verdict).toContain('!= "pass"');
  });
});

describe('the documented gate is the command CI actually runs', () => {
  test('CI uses --isolate', () => {
    expect(WORKFLOW).toContain('bun test --isolate');
    // A bare `bun test <path>` in the workflow would mean the two gates disagree again.
    expect(WORKFLOW).not.toMatch(/bun test (?!--isolate)[^\n]*\btests?\//);
  });

  test('CLAUDE.md tells contributors to use --isolate', () => {
    expect(CLAUDE_MD).toContain('bun test --isolate');
  });

  test('CLAUDE.md says why, not just what', () => {
    // A rule without its reason gets "simplified" away by the next person.
    expect(CLAUDE_MD).toContain('mock.module');
  });
});
