/**
 * Cleaning up merged branches: what is offered, what is kept and why, and how the deleting is split.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { chunk, planCleanup, protectedBy } from '../src/git/cleanup.ts';
import type { LocalBranch } from '../src/git/localBranches.ts';
import { parseLocalBranches } from '../src/git/localBranches.ts';

const SHA = 'a'.repeat(40);

const branch = (name: string, extra: Partial<LocalBranch> = {}): LocalBranch => ({
  name,
  sha: SHA,
  upstream: null,
  gone: false,
  updated: 0,
  worktree: null,
  head: false,
  ...extra,
});

test('protected names are matched whole, and * reaches across slashes', () => {
  const guarded = protectedBy(['main', 'release/*', 'uat', ' ', 'v1.0']);

  assert.equal(guarded('main'), true);
  assert.equal(guarded('release/v1.3'), true);
  assert.equal(guarded('release/v1/hotfix'), true);
  assert.equal(guarded('uat'), true);

  assert.equal(guarded('mainline'), false);
  assert.equal(guarded('Main'), false, 'git names are case-sensitive, and so is this');
  assert.equal(guarded('uat2'), false);
  assert.equal(guarded('Dev_ACR080VN_ERP-10147'), false);
  assert.equal(guarded('v1x0'), false, 'a dot is a dot');
});

test('merged branches are offered oldest first, and what is kept says why', () => {
  const branches = [
    branch('main', { head: true }),
    branch('Dev_new', { updated: 3000 }),
    branch('Dev_old', { updated: 1000 }),
    branch('elsewhere', { worktree: 'D:/work/elsewhere' }),
    branch('release/v1.3'),
    branch('develop'),
  ];
  const merged = new Set(['main', 'Dev_new', 'Dev_old', 'elsewhere', 'release/v1.3', 'develop']);

  const plan = planCleanup(branches, merged, 'develop', protectedBy(['release/*']));

  assert.deepEqual(plan.merged.map((b) => b.name), ['Dev_old', 'Dev_new']);
  assert.deepEqual(plan.kept, [
    { name: 'main', why: 'checked out here' },
    { name: 'elsewhere', why: 'checked out in D:/work/elsewhere' },
    { name: 'release/v1.3', why: 'protected' },
    { name: 'develop', why: 'the base' },
  ]);
  assert.deepEqual(plan.stranded, []);
});

test('an unmerged branch whose upstream is gone is offered apart, and a live one not at all', () => {
  const branches = [
    branch('Fix_live', { upstream: 'origin/Fix_live' }),
    branch('Fix_gone_later', { upstream: 'origin/Fix_gone_later', gone: true, updated: 9000 }),
    branch('Fix_gone', { upstream: 'origin/Fix_gone', gone: true, updated: 5000 }),
  ];

  const plan = planCleanup(branches, new Set(), 'main', () => false);

  assert.deepEqual(plan.stranded.map((b) => b.name), ['Fix_gone', 'Fix_gone_later']);
  assert.deepEqual(plan.merged, []);
  assert.deepEqual(plan.kept, []);
});

test('names are split by count and by length, and a name too long alone still goes', () => {
  assert.deepEqual(chunk(['a', 'b', 'c'], 2), [['a', 'b'], ['c']]);
  assert.deepEqual(chunk(['aaaa', 'bbbb', 'cccc'], 50, 10), [['aaaa', 'bbbb'], ['cccc']]);
  assert.deepEqual(chunk(['x'.repeat(20)], 50, 10), [['x'.repeat(20)]]);
  assert.deepEqual(chunk([]), []);
});

test('the branch reader reads every field for-each-ref gives it', () => {
  const out = [
    ['main', SHA, 'origin/main', '', '1700000000', 'D:/repo', '*'].join('\x00'),
    ['gone', SHA, 'origin/gone', '[gone]', '1600000000', '', ' '].join('\x00'),
    ['loose', SHA, '', '', '0', '', ' '].join('\x00'),
    '',
  ].join('\n');

  assert.deepEqual(parseLocalBranches(out), [
    { name: 'main', sha: SHA, upstream: 'origin/main', gone: false, updated: 1_700_000_000_000, worktree: 'D:/repo', head: true },
    { name: 'gone', sha: SHA, upstream: 'origin/gone', gone: true, updated: 1_600_000_000_000, worktree: null, head: false },
    { name: 'loose', sha: SHA, upstream: null, gone: false, updated: 0, worktree: null, head: false },
  ]);
});
