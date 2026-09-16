/**
 * What counts as a commit id in a line of terminal output, and where the line says it is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { shasIn } from '../src/terminalLinks.ts';

/** The ids in a line, each read back out of the line by where it was said to be. */
const read = (line: string): string[] =>
  shasIn(line).map((match) => line.slice(match.startIndex, match.startIndex + match.length));

test('git prints commit ids in shapes a terminal can be clicked on', () => {
  assert.deepEqual(read('[main 3f2a1b9] fix the total'), ['3f2a1b9'], 'what git says after a commit');
  assert.deepEqual(read('HEAD is now at 9c8b7a6d5e the subject'), ['9c8b7a6d5e'], 'after a checkout');
  assert.deepEqual(read('Updating a1b2c3d..e4f5a6b'), ['a1b2c3d', 'e4f5a6b'], 'both ends of a range');
  assert.deepEqual(read('(cherry picked from commit 5d41402abc4b2a76b9719d911017c592)'), ['5d41402abc4b2a76b9719d911017c592']);
  assert.deepEqual(shasIn('[main 3f2a1b9] fix the total')[0], { startIndex: 6, length: 7, sha: '3f2a1b9' });
});

test('what is not a commit id is left alone', () => {
  assert.deepEqual(read('https://git.example.com/erp/dlp/-/commit/3f2a1b9'), [], 'an address is already a link');
  assert.deepEqual(read('git@git.example.com:erp/dlp.git'), []);
  assert.deepEqual(read('src/deadbeef/a1b2c3d.ts'), [], 'a path, whatever its names look like');
  assert.deepEqual(read('warning: refs/heads/deadbeef..cafebabe1 is gone'), [], 'a ref that reads like a range');
  assert.deepEqual(read('deadbeef.txt'), []);
  assert.deepEqual(read('Build 1234567 finished in 1234567890 ms'), [], 'numbers are numbers');
  assert.deepEqual(read('abc123 is six'), [], 'too short to be one');
  assert.deepEqual(read('DEADBEEF1 shouted'), [], 'git writes them in lower case');
  assert.deepEqual(read('the quick brown fox'), []);
});
