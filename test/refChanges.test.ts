/**
 * Whether a change to the refs is on screen - the question that decides whether the graph re-walks.
 *
 * The fingerprints are written out by hand, in the shape `repoFingerprint` reads them in: HEAD's
 * commit, then a `*` or a space, the object and the name for each ref.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { changesDrawing } from '../src/git/refChanges.ts';
import type { Drawing } from '../src/git/refChanges.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

/** A fingerprint: HEAD at `head`, on the ref named `on`. */
function print(head: string, refs: Record<string, string>, on = 'refs/heads/main'): string {
  const lines = Object.entries(refs).map(([name, object]) => `${name === on ? '*' : ' '}${object}${name}`);
  return `${head}\n${lines.join('\n')}\n`;
}

/** Only main drawn, and its one commit, A, on screen. */
const mainOnly: Drawing = {
  drawn: new Set(['refs/heads/main']),
  walked: new Set([A]),
  complete: true,
  exclusive: false,
};

test('a branch that is not drawn, moving between commits that are not, is off screen', () => {
  const before = print(A, { 'refs/heads/main': A, 'refs/remotes/origin/far': C });
  const after = print(A, { 'refs/heads/main': A, 'refs/remotes/origin/far': D });

  assert.equal(changesDrawing(before, after, mainOnly), false);
});

test('a new branch that is not drawn, at a commit that is not, is off screen', () => {
  const before = print(A, { 'refs/heads/main': A });
  const after = print(A, { 'refs/heads/far': C, 'refs/heads/main': A });

  assert.equal(changesDrawing(before, after, mainOnly), false);
});

test('a hidden branch arriving on a drawn commit is a badge there', () => {
  const before = print(A, { 'refs/heads/main': A });
  const after = print(A, { 'refs/heads/main': A, 'refs/heads/near': A });

  assert.equal(changesDrawing(before, after, mainOnly), true);
});

test('a hidden branch leaving a drawn commit takes its badge with it', () => {
  const before = print(A, { 'refs/heads/main': A, 'refs/heads/near': A });

  assert.equal(changesDrawing(before, print(A, { 'refs/heads/main': A, 'refs/heads/near': C }), mainOnly), true);
  assert.equal(changesDrawing(before, print(A, { 'refs/heads/main': A }), mainOnly), true);
});

test('a drawn branch moving is on screen', () => {
  const drawing: Drawing = { ...mainOnly, drawn: new Set(['refs/heads/main', 'refs/heads/topic']) };
  const before = print(A, { 'refs/heads/main': A, 'refs/heads/topic': C });
  const after = print(A, { 'refs/heads/main': A, 'refs/heads/topic': D });

  assert.equal(changesDrawing(before, after, drawing), true);
});

test('HEAD moving to another branch at the same commit is on screen', () => {
  const refs = { 'refs/heads/main': A, 'refs/heads/twin': A };

  assert.equal(changesDrawing(print(A, refs, 'refs/heads/main'), print(A, refs, 'refs/heads/twin'), mainOnly), true);
});

test('the stash and the tags are on screen wherever they point', () => {
  const before = print(A, { 'refs/heads/main': A });

  // The stash is drawn by what it hangs off, not by a tick; an annotated tag's object is not the
  // commit it badges, so it cannot be looked up among the rows.
  assert.equal(changesDrawing(before, print(A, { 'refs/heads/main': A, 'refs/stash': C }), mainOnly), true);
  assert.equal(changesDrawing(before, print(A, { 'refs/heads/main': A, 'refs/tags/v1': D }), mainOnly), true);
});

test('with everything drawn, a walk still going, or only-here on, every change is on screen', () => {
  const before = print(A, { 'refs/heads/main': A, 'refs/remotes/origin/far': C });
  const after = print(A, { 'refs/heads/main': A, 'refs/remotes/origin/far': D });

  assert.equal(changesDrawing(before, after, { ...mainOnly, drawn: null }), true);
  assert.equal(changesDrawing(before, after, { ...mainOnly, complete: false }), true);
  assert.equal(changesDrawing(before, after, { ...mainOnly, exclusive: true }), true);
});

test('nothing changed is nothing on screen', () => {
  const same = print(A, { 'refs/heads/main': A, 'refs/heads/far': B });

  assert.equal(changesDrawing(same, same, mainOnly), false);
});
