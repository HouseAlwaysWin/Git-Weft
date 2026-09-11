/**
 * The ticks as a choice: what each kind of set draws, how a tick changes it, and what survives
 * being stored and read back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { except, hiddenBy, only, pruned, readRefSet, readStoredTicks, withVisible } from '../src/refSets.ts';

const MAIN = 'refs/heads/main';
const TOPIC = 'refs/heads/topic';
const FETCHED = 'refs/remotes/origin/fetched-later';

test('a ref that arrives later is left out of an only set, and drawn by an except set', () => {
  const before = [MAIN, TOPIC];
  const after = [MAIN, TOPIC, FETCHED];

  assert.deepEqual([...hiddenBy(only([MAIN]), before)], [TOPIC]);
  assert.deepEqual([...hiddenBy(only([MAIN]), after)], [TOPIC, FETCHED], 'nobody picked it');

  assert.deepEqual([...hiddenBy(except([TOPIC]), after)], [TOPIC], 'everything-but includes arrivals');
});

test('a tick names or unnames the ref the right way round for each kind', () => {
  // In `only`, ticking names the ref; in `except`, unticking does.
  assert.deepEqual(withVisible(only([MAIN]), [TOPIC], true), only([MAIN, TOPIC]));
  assert.deepEqual(withVisible(only([MAIN, TOPIC]), [TOPIC], false), only([MAIN]));
  assert.deepEqual(withVisible(except([]), [TOPIC], false), except([TOPIC]));
  assert.deepEqual(withVisible(except([TOPIC]), [TOPIC], true), except([]));
});

test('refs are kept once, in order, and only while they exist', () => {
  assert.deepEqual(only([TOPIC, MAIN, TOPIC]).refs, [MAIN, TOPIC]);
  assert.deepEqual(pruned(only([MAIN, TOPIC]), [MAIN]), only([MAIN]));
  assert.deepEqual(pruned(except([TOPIC]), [MAIN]), except([]));
});

test('what was stored reads back as it was', () => {
  const stored = { v: 1, head: MAIN, following: false, set: only([MAIN, TOPIC]) };

  assert.deepEqual(readStoredTicks(JSON.parse(JSON.stringify(stored))), stored);
  assert.deepEqual(readStoredTicks({ ...stored, head: null }), { ...stored, head: null });
});

test('anything that is not a stored set reads as nothing', () => {
  const good = { v: 1, head: MAIN, following: true, set: except([]) };

  for (const bad of [
    null,
    'only',
    { ...good, v: 2 },
    { ...good, head: 42 },
    { ...good, following: 'yes' },
    { ...good, set: { mode: 'some', refs: [] } },
    { ...good, set: { mode: 'only', refs: [MAIN, 7] } },
    { ...good, set: null },
  ]) {
    assert.equal(readStoredTicks(bad), null, JSON.stringify(bad));
  }

  assert.equal(readRefSet({ mode: 'only' }), null);
  assert.deepEqual(readRefSet({ mode: 'except', refs: [TOPIC, MAIN] }), except([MAIN, TOPIC]));
});
