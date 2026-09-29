/**
 * Where a new worktree goes by default, and what branch it is given.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { suggestWorktreePath, worktreeAddArgs } from '../src/git/worktreeAdd.ts';

test('a worktree is suggested beside the repository, named after it and the branch', () => {
  assert.equal(suggestWorktreePath('D:/Projects/app', 'feature'), 'D:/Projects/app-feature');

  // Not inside the repository: git allows it, and then the new tree is untracked files in the old one.
  assert.ok(!suggestWorktreePath('D:/Projects/app', 'feature').startsWith('D:/Projects/app/'));
});

test('a branch with slashes in it becomes one folder, not a tree of them', () => {
  assert.equal(
    suggestWorktreePath('D:/Projects/app', 'feature/login'),
    'D:/Projects/app-feature-login',
    'folders named after the prefix would fill up with other people\u2019s worktrees',
  );

  assert.equal(suggestWorktreePath('D:/Projects/app', 'refs/heads/feature/login'), 'D:/Projects/app-feature-login');
  assert.equal(suggestWorktreePath('D:/Projects/app', 'refs/remotes/origin/hot'), 'D:/Projects/app-origin-hot');
});

test('the path VS Code hands back is the path git is given', () => {
  assert.equal(suggestWorktreePath('D:\\Projects\\app', 'feature'), 'D:/Projects/app-feature');
  assert.equal(suggestWorktreePath('D:/Projects/app/', 'feature'), 'D:/Projects/app-feature');
});

test('a branch name a filesystem would argue about is made into one it will not', () => {
  // Windows refuses these outright, and silently strips a trailing dot or space from what is left.
  assert.equal(suggestWorktreePath('D:/Projects/app', 'fix: the thing?'), 'D:/Projects/app-fix--the-thing');
  assert.equal(suggestWorktreePath('D:/Projects/app', 'wip.'), 'D:/Projects/app-wip');
  assert.equal(
    suggestWorktreePath('D:/Projects/app', '...'),
    'D:/Projects/app-worktree',
    'a name that is nothing but punctuation still has to be a name',
  );
});

test('a local branch is named by its short name, because the full ref would detach the new tree', () => {
  /*
   * Measured, not assumed: `git worktree add <path> refs/heads/topic` leaves the worktree detached
   * and `git worktree add <path> topic` puts it on the branch. This test asserted the first form
   * once, which is exactly why it passed while the feature was broken.
   */
  assert.deepEqual(worktreeAddArgs('D:/Projects/app-feature', 'refs/heads/feature', 'local', new Set()), [
    'worktree',
    'add',
    'D:/Projects/app-feature',
    'feature',
  ]);

  // A branch whose own name contains the prefix keeps it: only the leading one is git's.
  assert.deepEqual(
    worktreeAddArgs('D:/Projects/app-x', 'refs/heads/refs/heads/odd', 'local', new Set()),
    ['worktree', 'add', 'D:/Projects/app-x', 'refs/heads/odd'],
  );
});

test('a tag keeps its full ref, because detached is the only thing a tag can be', () => {
  assert.deepEqual(worktreeAddArgs('D:/Projects/app-v1', 'refs/tags/v1.0', 'tag', new Set()), [
    'worktree',
    'add',
    'D:/Projects/app-v1',
    'refs/tags/v1.0',
  ]);
});

test('a remote branch is given a local one, because checking it out directly detaches HEAD', () => {
  assert.deepEqual(
    worktreeAddArgs('D:/Projects/app-hot', 'refs/remotes/origin/hot', 'remote', new Set(['main'])),
    ['worktree', 'add', '-b', 'hot', 'D:/Projects/app-hot', 'refs/remotes/origin/hot'],
    'a detached worktree is not what right-clicking a branch meant',
  );

  // A remote branch whose name is itself nested keeps all of it: origin/feature/login -> feature/login.
  assert.deepEqual(
    worktreeAddArgs('D:/Projects/app-x', 'refs/remotes/origin/feature/login', 'remote', new Set()),
    ['worktree', 'add', '-b', 'feature/login', 'D:/Projects/app-x', 'refs/remotes/origin/feature/login'],
  );
});

test('a remote branch whose local name is taken uses that branch rather than inventing a second', () => {
  assert.deepEqual(
    worktreeAddArgs('D:/Projects/app-hot', 'refs/remotes/origin/hot', 'remote', new Set(['hot'])),
    ['worktree', 'add', 'D:/Projects/app-hot', 'hot'],
    'two branches at the same commit, only one of them tracking anything, is not an improvement',
  );
});
