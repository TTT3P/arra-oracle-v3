/**
 * createContainedFile / commitRowsOrRemoveFile — Riddler PR#20 review (S1, F1):
 *  - the directory the file lands in must be inside the REAL root after symlink
 *    resolution (ψ or a deeper ancestor symlinked outside is refused before any
 *    directory is created outside the boundary);
 *  - creation is exclusive (`wx`): a competing file or symlink already at the
 *    path is never overwritten, and the rollback only removes the file this
 *    write created.
 */
import Database from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LEARNING_FILE_OUTSIDE_ROOT, commitRowsOrRemoveFile, createContainedFile } from '../../src/learn/commit-file-write.ts';

const dirs: string[] = [];
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('createContainedFile', () => {
  test('creates the file (and missing dirs) under the real root and returns the real path', () => {
    const root = tmp('arra-contained-root-');
    const target = path.join(root, 'ψ', 'memory', 'learnings', 'a.md');
    const real = createContainedFile(root, target, 'body');
    expect(fs.readFileSync(real, 'utf8')).toBe('body');
    expect(real.startsWith(fs.realpathSync(root) + path.sep)).toBe(true);
  });

  test('creates a root that does not exist yet (legacy mkdir -p behaviour; not a containment risk)', () => {
    const parent = tmp('arra-contained-parent-');
    const root = path.join(parent, 'new-repo');
    const real = createContainedFile(root, path.join(root, 'ψ', 'memory', 'learnings', 'first.md'), 'first');
    expect(fs.readFileSync(real, 'utf8')).toBe('first');
    expect(real.startsWith(fs.realpathSync(root) + path.sep)).toBe(true);
  });

  test('refuses when ψ is a symlink out of the root, before creating anything outside', () => {
    const root = tmp('arra-contained-root-');
    const outside = tmp('arra-contained-outside-');
    fs.symlinkSync(outside, path.join(root, 'ψ'));
    expect(() => createContainedFile(root, path.join(root, 'ψ', 'memory', 'learnings', 'escape.md'), 'x')).toThrow(LEARNING_FILE_OUTSIDE_ROOT);
    expect(fs.readdirSync(outside)).toEqual([]); // no memory/ created behind the link
  });

  test('refuses when a deeper ancestor (ψ/memory) is a symlink out of the root', () => {
    const root = tmp('arra-contained-root-');
    const outside = tmp('arra-contained-outside-');
    fs.mkdirSync(path.join(root, 'ψ'));
    fs.symlinkSync(outside, path.join(root, 'ψ', 'memory'));
    expect(() => createContainedFile(root, path.join(root, 'ψ', 'memory', 'learnings', 'escape.md'), 'x')).toThrow(LEARNING_FILE_OUTSIDE_ROOT);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test('refuses a lexical escape (..) and an absolute path outside the root', () => {
    const root = tmp('arra-contained-root-');
    const outside = tmp('arra-contained-outside-');
    expect(() => createContainedFile(root, path.join(root, '..', 'escape.md'), 'x')).toThrow(LEARNING_FILE_OUTSIDE_ROOT);
    expect(() => createContainedFile(root, path.join(outside, 'escape.md'), 'x')).toThrow(LEARNING_FILE_OUTSIDE_ROOT);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test('never overwrites a competing file or a symlink at the target (exclusive create)', () => {
    const root = tmp('arra-contained-root-');
    const dir = path.join(root, 'ψ', 'memory', 'learnings');
    fs.mkdirSync(dir, { recursive: true });
    const competitor = path.join(dir, 'race.md');
    fs.writeFileSync(competitor, 'competitor content');
    expect(() => createContainedFile(root, competitor, 'mine')).toThrow(/EEXIST/);
    expect(fs.readFileSync(competitor, 'utf8')).toBe('competitor content');
    const outside = tmp('arra-contained-outside-');
    const victim = path.join(outside, 'victim.md');
    fs.writeFileSync(victim, 'victim');
    fs.symlinkSync(victim, path.join(dir, 'link.md'));
    expect(() => createContainedFile(root, path.join(dir, 'link.md'), 'mine')).toThrow(/EEXIST/);
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim');
  });
});

describe('commitRowsOrRemoveFile', () => {
  test('rolls back the rows and removes only the file it was given', () => {
    const root = tmp('arra-contained-root-');
    const mine = createContainedFile(root, path.join(root, 'ψ', 'memory', 'learnings', 'mine.md'), 'mine');
    const other = path.join(root, 'ψ', 'memory', 'learnings', 'other.md');
    fs.writeFileSync(other, 'other');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    expect(() => commitRowsOrRemoveFile(db, mine, () => {
      db.query('INSERT INTO t (id) VALUES (?)').run('a');
      throw new Error('late failure');
    })).toThrow('late failure');
    expect((db.query('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c).toBe(0);
    expect(fs.existsSync(mine)).toBe(false);
    expect(fs.readFileSync(other, 'utf8')).toBe('other');
    db.close();
  });
});
