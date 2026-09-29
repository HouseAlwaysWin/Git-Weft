/**
 * The other working trees of one repository: what `git worktree list --porcelain` says about each,
 * and which of them already has a branch checked out.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { branchIsOut, parseWorktrees, worktreeListArgs } from '../src/git/worktrees.ts';

const NUL = '\x00';

/** The records git prints, given as attribute lists so one fixture serves both separators. */
const RECORDS = [
  ['worktree D:/Projects/app', 'HEAD ' + 'a'.repeat(40), 'branch refs/heads/main'],
  [
    'worktree D:/Projects/app-gone',
    'HEAD ' + 'b'.repeat(40),
    'branch refs/heads/old',
    'prunable gitdir file points to non-existent location',
  ],
  ['worktree D:/Projects/app-loose', 'HEAD ' + 'c'.repeat(40), 'detached', 'locked on a usb stick'],
  ['worktree D:/Projects/app-feature', 'HEAD ' + 'd'.repeat(40), 'branch refs/heads/feature'],
];

/*
 * git terminates rather than separates: every attribute is followed by its separator, and then the
 * record is followed by one more. So the output ends with a doubled separator and nothing is joined
 * between records.
 */
const printed = (records: string[][], nulSeparated: boolean): string => {
  const within = nulSeparated ? NUL : '\n';

  return records.map((record) => record.join(within) + within + within).join('');
};

test('git is asked for NUL separators only where it has them', () => {
  assert.deepEqual(worktreeListArgs(true), ['worktree', 'list', '--porcelain', '-z']);
  assert.deepEqual(worktreeListArgs(false), ['worktree', 'list', '--porcelain']);
});

for (const nulSeparated of [true, false]) {
  const how = nulSeparated ? 'with NUL separators' : 'with lines';

  test(`every worktree is read ${how}`, () => {
    const found = parseWorktrees(printed(RECORDS, nulSeparated), nulSeparated);

    assert.equal(found.length, 4, 'the trailing separator is not a fifth worktree');

    assert.deepEqual(found[0], {
      path: 'D:/Projects/app',
      head: 'a'.repeat(40),
      branch: 'refs/heads/main',
      bare: false,
      locked: null,
      prunable: null,
      main: true,
    });

    // git lists the main worktree first and only first, so position is what says which it is.
    assert.deepEqual(
      found.map((worktree) => worktree.main),
      [true, false, false, false],
    );

    assert.equal(
      found[1]?.prunable,
      'gitdir file points to non-existent location',
      "git's reason has spaces in it, and all of it is the value",
    );

    assert.deepEqual(found[2]?.locked, { reason: 'on a usb stick' });
    assert.equal(found[2]?.branch, null, 'detached is the absence of a branch');
  });
}

test('a lock with no reason given is still a lock', () => {
  const found = parseWorktrees(
    printed([['worktree D:/Projects/app', 'HEAD ' + 'a'.repeat(40), 'detached', 'locked']], true),
    true,
  );

  assert.deepEqual(
    found[0]?.locked,
    { reason: '' },
    'an empty reason must not read as unlocked - `--reason` is optional and the lock still holds',
  );
});

test('a bare main worktree has no files, no HEAD and no branch', () => {
  const found = parseWorktrees(
    printed(
      [
        ['worktree D:/Projects/app.git', 'bare'],
        ['worktree D:/Projects/app-main', 'HEAD ' + 'a'.repeat(40), 'branch refs/heads/main'],
      ],
      true,
    ),
    true,
  );

  assert.equal(found[0]?.bare, true);
  assert.equal(found[0]?.head, null);
  assert.equal(found[0]?.branch, null);
  assert.equal(found[1]?.bare, false, 'only the bare one is bare');
});

test('a path with a space in it is one path, not two attributes', () => {
  const found = parseWorktrees(
    printed([['worktree D:/Projects/has a space', 'HEAD ' + 'a'.repeat(40), 'detached']], true),
    true,
  );

  assert.equal(found[0]?.path, 'D:/Projects/has a space');
});

test('a reason typed across two lines survives NUL separators, which is why they are asked for', () => {
  const record = ['worktree D:/Projects/app', 'HEAD ' + 'a'.repeat(40), 'detached', 'locked one\ntwo'];

  assert.equal(
    parseWorktrees(printed([record], true), true).length,
    1,
    'one worktree, whatever the reason contains',
  );

  // The same bytes read line by line: the reason's second line is a line of its own, and reads as
  // an attribute nobody knows. Nothing can be done about that on an old git; it is why -z is asked
  // for wherever it exists. A reason holding a *blank* line would end the record there outright.
  const byLine = parseWorktrees(printed([record], false), false);

  assert.equal(byLine[0]?.locked?.reason, 'one', 'a line-read reason stops at the newline');
});

test('output from a git too old to understand the command is no worktrees, not a crash', () => {
  assert.deepEqual(parseWorktrees('', true), []);
  assert.deepEqual(parseWorktrees('', false), []);
  assert.deepEqual(parseWorktrees('usage: git worktree <subcommand>', false), []);
});

test('a branch that is checked out somewhere else is named, and this tree is not somewhere else', () => {
  const worktrees = parseWorktrees(printed(RECORDS, true), true);

  assert.equal(
    branchIsOut(worktrees, 'refs/heads/feature', 'D:/Projects/app')?.path,
    'D:/Projects/app-feature',
  );

  assert.equal(
    branchIsOut(worktrees, 'refs/heads/main', 'D:/Projects/app'),
    null,
    'the branch this tree has out is not a reason to refuse it',
  );

  assert.equal(
    branchIsOut(worktrees, 'refs/heads/main', 'd:\\Projects\\app\\'),
    null,
    'the same path as VS Code spells it - backslashes, a drive letter in either case, a trailing slash',
  );

  assert.equal(branchIsOut(worktrees, 'refs/heads/nobody', 'D:/Projects/app'), null);
});
