/**
 * The sidebar's read of every ref: what it asks git for, and what it makes of the answer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRefLine, refListArgs, worktreeLabel } from '../src/git/refList.ts';

const NUL = '\x00';

test('the worktree field is asked for only where git has it', () => {
  const withIt = refListArgs(true).find((arg) => arg.startsWith('--format='));
  const without = refListArgs(false).find((arg) => arg.startsWith('--format='));

  assert.ok(withIt?.includes('%(worktreepath)'));
  assert.ok(!without?.includes('%(worktreepath)'));

  /*
   * `for-each-ref` fails outright on a field it does not know - `fatal: unknown field name`, and no
   * output at all - so asking an older git for this one empties Branches & Tags rather than leaving
   * out a detail. Everything else about the two calls has to be the same.
   */
  assert.deepEqual(
    refListArgs(true).filter((arg) => !arg.startsWith('--format=')),
    refListArgs(false).filter((arg) => !arg.startsWith('--format=')),
    'the two reads differ in one field and nothing else',
  );

  assert.deepEqual(refListArgs(false).slice(-3), ['refs/heads', 'refs/remotes', 'refs/tags']);
});

test('a line is read into a ref', () => {
  const line = parseRefLine(`refs/heads/main${NUL}*${NUL}1700000000${NUL}D:/Projects/app`);

  assert.deepEqual(line, {
    refName: 'refs/heads/main',
    head: true,
    updated: 1700000000000,
    worktree: 'D:/Projects/app',
  });
});

test('a ref nobody has checked out, and a git that was never asked, read the same', () => {
  // They have to: on a git without the field every line looks like the second one.
  const nobody = parseRefLine(`refs/heads/idle${NUL}${NUL}1700000000${NUL}`);
  const neverAsked = parseRefLine(`refs/heads/idle${NUL}${NUL}1700000000`);

  assert.equal(nobody?.worktree, null);
  assert.equal(neverAsked?.worktree, null);
  assert.deepEqual(nobody, neverAsked, 'an older git must not read as something different');
});

test('a ref with no committer date is not a ref from 1970', () => {
  assert.equal(parseRefLine(`refs/tags/v1${NUL}${NUL}${NUL}`)?.updated, 0);
});

test('nothing on the line is nothing, not a ref with no name', () => {
  assert.equal(parseRefLine(''), null);
  assert.equal(parseRefLine('   '), null);
  assert.equal(parseRefLine(`${NUL}${NUL}1700000000`), null);
});

test('a row names the folder, because a row is one line in a narrow sidebar', () => {
  assert.equal(worktreeLabel('D:/Projects/app-feature'), 'app-feature');
  assert.equal(worktreeLabel('D:\\Projects\\app-feature'), 'app-feature');
  assert.equal(worktreeLabel('D:/Projects/app-feature/'), 'app-feature');
});
