/**
 * Which remote a page is built from, and which remote an upstream names.
 *
 * The rest of `webPlace.ts` asks git, and is held to what it answers by scripts/load-check.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { pickRemote, remoteOfUpstream } from '../src/git/webPlace.ts';

test('the remote to go by is the upstream, then origin, then the only one there is', () => {
  assert.equal(pickRemote(['origin', 'fork'], 'fork'), 'fork', 'what the branch is tracked on wins');
  assert.equal(pickRemote(['origin', 'fork'], null), 'origin');
  assert.equal(pickRemote(['upstream'], null), 'upstream', 'the only one there is');
  assert.equal(pickRemote(['fork', 'upstream'], null), null, 'two, neither of them origin: a question, not a guess');
  assert.equal(pickRemote([], null), null);
  assert.equal(pickRemote(['origin'], 'gone'), 'origin', 'an upstream on a remote this clone has lost');
});

test('an upstream is read as the longest remote name that starts it', () => {
  assert.equal(remoteOfUpstream('origin/main', ['origin']), 'origin');
  assert.equal(remoteOfUpstream('origin/mirror/main', ['origin', 'origin/mirror']), 'origin/mirror');
  assert.equal(remoteOfUpstream('origin/feature/x', ['fork', 'origin']), 'origin');
  assert.equal(remoteOfUpstream('', ['origin']), null);
  assert.equal(remoteOfUpstream('other/main', ['origin']), null);
});
