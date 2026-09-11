/**
 * The offer for a slow `git status`: what it offers, where a monitor is offered at all, and when it
 * asks - once, at the third slow read, and never for a read that was quick.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SLOW_READS_BEFORE_ASKING, SlowReads, fsmonitorCanRun, statusOffer } from '../src/git/statusAdvice.ts';

test('only what nobody has set is offered', () => {
  assert.deepEqual(statusOffer({ untrackedCache: null, fsmonitor: null }, true), { untrackedCache: true, fsmonitor: true });
  assert.deepEqual(statusOffer({ untrackedCache: 'false', fsmonitor: null }, true), { untrackedCache: false, fsmonitor: true });

  // A hook of somebody's own, such as Watchman's, is theirs.
  assert.deepEqual(statusOffer({ untrackedCache: null, fsmonitor: '.git/hooks/query-watchman' }, true), {
    untrackedCache: true,
    fsmonitor: false,
  });

  assert.deepEqual(statusOffer({ untrackedCache: 'true', fsmonitor: 'true' }, true), { untrackedCache: false, fsmonitor: false });
});

test('a monitor only where git says one can run', () => {
  assert.equal(fsmonitorCanRun(0), true);
  assert.equal(fsmonitorCanRun(1), true);
  assert.equal(fsmonitorCanRun(128), false);
  assert.equal(fsmonitorCanRun(null), false);

  assert.deepEqual(statusOffer({ untrackedCache: null, fsmonitor: null }, false), { untrackedCache: true, fsmonitor: false });
});

test('the third slow read asks, and nothing after it does', () => {
  const reads = new SlowReads();
  const asked = [900, 900, 900, 900, 900].map((ms) => reads.record('/r', ms, 500));

  assert.equal(SLOW_READS_BEFORE_ASKING, 3);
  assert.deepEqual(asked, [false, false, true, false, false]);
});

test('quick reads never count, and each repository counts for itself', () => {
  const reads = new SlowReads();

  for (let i = 0; i < 10; i += 1) {
    assert.equal(reads.record('/r', 100, 500), false);
  }

  assert.equal(reads.record('/a', 900, 500), false);
  assert.equal(reads.record('/b', 900, 500), false);
  assert.equal(reads.record('/a', 900, 500), false);
  assert.equal(reads.record('/a', 900, 500), true);
});

test('zero never asks, and a new threshold starts the count again', () => {
  const reads = new SlowReads();

  for (let i = 0; i < 5; i += 1) {
    assert.equal(reads.record('/r', 900, 0), false);
  }

  reads.record('/r', 900, 500);
  reads.record('/r', 900, 500);
  assert.equal(reads.record('/r', 900, 1), false, 'two slow reads under the old threshold are not two under the new');

  reads.record('/r', 900, 1);
  assert.equal(reads.record('/r', 900, 1), true);
});
