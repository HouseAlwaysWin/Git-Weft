/**
 * What `git log -1` says about a file, and what the line above the file says about that.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { describeLastChange, parseLastChange } from '../src/git/lastChange.ts';

const SHA = '5d41402abc4b2a76b9719d911017c592cd41402a';

test("the last commit that touched a file is read from git's own three fields", () => {
  const change = parseLastChange(`${SHA}\x00Ada Fischer\x002026-09-14T09:30:00+08:00\n`);

  assert.deepEqual(change, { sha: SHA, author: 'Ada Fischer', at: Date.parse('2026-09-14T01:30:00Z') });

  // A name with a comma or a NUL-looking address in it is still one field: git separates with NUL.
  assert.equal(parseLastChange(`${SHA}\x00Lee, Sam\x002026-09-14T09:30:00+08:00`)?.author, 'Lee, Sam');
});

test('a file no commit has touched has nothing to say', () => {
  assert.equal(parseLastChange(''), null);
  assert.equal(parseLastChange('\n'), null);
  assert.equal(parseLastChange('not a sha\x00Ada\x002026-09-14T09:30:00+08:00'), null, 'only a whole sha counts');
  assert.equal(parseLastChange('5d41402\x00Ada\x002026-09-14T09:30:00+08:00'), null, 'and a whole one is what %H gives');
});

test('the line above the file names whoever last changed it, and how long ago', () => {
  const now = Date.parse('2026-09-16T09:30:00Z');
  const change = parseLastChange(`${SHA}\x00Ada Fischer\x002026-09-13T09:30:00Z`);

  assert.equal(describeLastChange(change ?? { sha: '', author: '', at: 0 }, now), 'Ada Fischer, 3 days ago');

  // A date git could not give: the name on its own, rather than an age counted from 1970.
  assert.equal(describeLastChange({ sha: SHA, author: 'Ada Fischer', at: 0 }, now), 'Ada Fischer');
});
