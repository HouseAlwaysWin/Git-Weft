/**
 * Which files a person has changed: the walk that asks, and the counting that orders the answer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { authorFilesArgs, parseAuthorFiles } from '../src/git/authorFiles.ts';

test('the walk asks about every spelling at once, and about history rather than stashes', () => {
  assert.deepEqual(authorFilesArgs(['Gaga Liu', 'gaga_liu']), [
    'log',
    '--branches',
    '--tags',
    '--remotes',
    '--no-merges',
    '--name-only',
    '--format=',
    '--author=Gaga Liu',
    '--author=gaga_liu',
  ]);

  /*
   * A name is a basic regular expression to git, and a Windows domain login has a backslash in it -
   * two of the people in the repository this was written for are listed that way. Escaped, not
   * dropped: `--fixed-strings` would do it, and would also reach the reader's own query.
   */
  const login = 'A02-01564' + String.fromCharCode(92) + 'Poyuan_Jung';

  assert.equal(authorFilesArgs([login]).at(-1), '--author=A02-01564\\\\Poyuan_Jung');

  // A dot is an operator and is escaped; a plus is literal until escaped and must be left alone.
  assert.equal(authorFilesArgs(['C++ fan.jr']).at(-1), '--author=C++ fan\\.jr');
});

test('the files are counted, and the one changed most often comes first', () => {
  /*
   * The busiest file sorts last by name, on purpose. With `a.ts` as both, alphabetical order and
   * most-changed order are the same list and this asserts nothing about which one is being used.
   */
  const walk = ['z.ts', 'b.ts', '', 'z.ts', '', 'c.ts', 'z.ts', ''].join('\n');

  assert.deepEqual(parseAuthorFiles(walk), [
    { path: 'z.ts', changes: 3 },
    { path: 'b.ts', changes: 1 },
    { path: 'c.ts', changes: 1 },
  ]);

  // Nothing at all is an answer: a person who has changed no files is not an error.
  assert.deepEqual(parseAuthorFiles(''), []);

  // A carriage return is a line ending, not part of the name of the file.
  assert.deepEqual(parseAuthorFiles('a.ts\r\na.ts\r\n'), [{ path: 'a.ts', changes: 2 }]);
});
