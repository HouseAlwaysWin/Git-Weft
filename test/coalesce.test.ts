/**
 * One run at a time, and at most one more after it - the rule the working-tree refresh is read by.
 *
 * The runs here finish only when released, so what is going at once is counted, not raced for.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { coalesce } from '../src/coalesce.ts';

interface Gate {
  readonly run: () => Promise<void>;
  readonly release: () => void;
  readonly started: () => number;
  readonly most: () => number;
}

/** A run that finishes only when released, and counts how many are going at once. */
function gated(): Gate {
  const waiting: Array<() => void> = [];
  let started = 0;
  let active = 0;
  let most = 0;

  return {
    run: () =>
      new Promise<void>((resolve) => {
        started += 1;
        active += 1;
        most = Math.max(most, active);
        waiting.push(() => {
          active -= 1;
          resolve();
        });
      }),
    release: () => {
      waiting.shift()?.();
    },
    started: () => started,
    most: () => most,
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('five requests while one runs cost one more run, and never two at once', async () => {
  const gate = gated();
  const request = coalesce(gate.run);

  const asked = [request(), request(), request(), request(), request()];
  assert.equal(gate.started(), 1);

  gate.release();
  await tick();
  assert.equal(gate.started(), 2, 'the four that arrived while it ran are one run between them');

  gate.release();
  await Promise.all(asked);

  assert.equal(gate.started(), 2);
  assert.equal(gate.most(), 1);
});

test('a request after the last run has finished starts a run of its own', async () => {
  const gate = gated();
  const request = coalesce(gate.run);

  const first = request();
  gate.release();
  await first;

  const second = request();
  assert.equal(gate.started(), 2);

  gate.release();
  await second;
});

test('a request during the follow-up run gets one more after it, still one at a time', async () => {
  const gate = gated();
  const request = coalesce(gate.run);

  const asked = [request(), request()];
  gate.release();
  await tick();
  assert.equal(gate.started(), 2);

  asked.push(request());
  gate.release();
  await tick();
  assert.equal(gate.started(), 3);

  gate.release();
  await Promise.all(asked);
  assert.equal(gate.most(), 1);
});
