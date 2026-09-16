/**
 * git's todo file: what it says, what comes back out of it, and what it comes to.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { describeTodo, moveCommit, parseTodo, renderTodo } from '../src/git/rebaseTodo.ts';

/** A file as `git rebase -i` writes one, comment block and all. */
const TODO = `pick 1a2b3c4 feat: the first thing
pick 5d6e7f8 fix: the second
fixup 9a8b7c6 fix: a typo in the second

# Rebase 0123456..9a8b7c6 onto 0123456 (3 commands)
#
# Commands:
# p, pick <commit> = use commit
# d, drop <commit> = remove commit
#
# These lines can be re-ordered; they are executed from top to bottom.
`;

test('a todo file git wrote comes back byte for byte', () => {
  assert.equal(renderTodo(parseTodo(TODO)), TODO);
  assert.equal(renderTodo(parseTodo('')), '');
  assert.equal(renderTodo(parseTodo('noop\n')), 'noop\n');
});

test('the commits in it are read, and everything else is kept as it is', () => {
  const lines = parseTodo(TODO);
  const commits = lines.filter((line) => line.kind === 'commit');

  assert.deepEqual(
    commits.map((line) => [line.action, line.sha, line.rest]),
    [
      ['pick', '1a2b3c4', 'feat: the first thing'],
      ['pick', '5d6e7f8', 'fix: the second'],
      ['fixup', '9a8b7c6', 'fix: a typo in the second'],
    ],
  );

  // The comment block, the blank line, and the commands this does not touch.
  assert.equal(lines.filter((line) => line.kind === 'other').length, lines.length - 3);
  assert.deepEqual(
    parseTodo('exec make test\nbreak\nlabel onto\nupdate-ref refs/heads/x\nnoop').filter((line) => line.kind === 'commit'),
    [],
    'the commands a rebase can hold that are not about one commit',
  );
});

test('every spelling git accepts is read, and written back in full', () => {
  const short = 'p 1a2b3c4 one\nr 5d6e7f8 two\ne 9a8b7c6 three\ns 1111111 four\nf 2222222 five\nd 3333333 six';

  assert.deepEqual(
    parseTodo(short).map((line) => (line.kind === 'commit' ? line.action : line.text)),
    ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'],
  );
  assert.equal(
    renderTodo(parseTodo(short)),
    'pick 1a2b3c4 one\nreword 5d6e7f8 two\nedit 9a8b7c6 three\nsquash 1111111 four\nfixup 2222222 five\ndrop 3333333 six',
  );

  // `fixup -C` keeps the fixup's own message, which is a different instruction and has to survive.
  const kept = 'fixup -C 1a2b3c4 the message to keep';

  const flagged = parseTodo(kept)[0];

  assert.equal(flagged?.kind === 'commit' ? flagged.flags : '', '-C');
  assert.equal(renderTodo(parseTodo(kept)), kept);
});

test('a commit moves among the commits, and the file around them stays put', () => {
  const lines = parseTodo(TODO);
  const order = (todo: readonly { kind: string; sha?: string }[]): string[] =>
    todo.filter((line) => line.kind === 'commit').map((line) => line.sha ?? '');

  assert.deepEqual(order(moveCommit(lines, 2, -1)), ['1a2b3c4', '9a8b7c6', '5d6e7f8'], 'up one');
  assert.deepEqual(order(moveCommit(lines, 0, 2)), ['5d6e7f8', '9a8b7c6', '1a2b3c4'], 'down two');
  assert.deepEqual(order(moveCommit(lines, 0, -1)), order(lines), 'the first cannot go up');
  assert.deepEqual(order(moveCommit(lines, 2, 5)), order(lines), 'nor the last past the end');
  assert.deepEqual(order(moveCommit(lines, 9, -1)), order(lines), 'nor a commit that is not there');

  // The comment block is still the last thing in the file after a move.
  assert.equal(renderTodo(moveCommit(lines, 0, 1)).trimEnd().split('\n').at(-1)?.startsWith('#'), true);
});

test('what the file comes to is said in commits, not in lines', () => {
  assert.equal(describeTodo(parseTodo(TODO)), '2 commits, 1 squashed into the one before');
  assert.equal(describeTodo(parseTodo('pick 1a2b3c4 one')), '1 commit');
  assert.equal(
    describeTodo(parseTodo('pick 1a2b3c4 one\ndrop 5d6e7f8 two\nfixup 9a8b7c6 three\nsquash 1111111 four')),
    '1 commit, 2 squashed into the one before, 1 dropped',
  );
  assert.equal(describeTodo(parseTodo('# nothing at all\nnoop')), 'Nothing to do');
});
