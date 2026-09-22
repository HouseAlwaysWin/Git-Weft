/**
 * Which files a person has changed: the walk that asks, and the counting that orders the answer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { authorFilesArgs, looksLikeMerge, parseAuthorFiles } from '../src/git/authorFiles.ts';

test('the walk asks about every spelling at once, and about history rather than stashes', () => {
  assert.deepEqual(authorFilesArgs(['Gaga Liu', 'gaga_liu'], null), [
    'log',
    '--no-merges',
    '--name-only',
    '--format=%x00%s',
    '--author=Gaga Liu',
    '--author=gaga_liu',
    '--branches',
    '--tags',
    '--remotes',
    '--',
  ]);

  /*
   * And from what the graph is drawing, when the sidebar has narrowed it. Ticking a branch means walk
   * from here, so the question becomes what they did that reached what is on screen - and the trailing
   * `--` is there so a branch named like a folder is still read as a branch.
   */
  assert.deepEqual(authorFilesArgs(['Gaga Liu'], ['refs/heads/main', 'refs/remotes/origin/uat']).slice(-3), [
    'refs/heads/main',
    'refs/remotes/origin/uat',
    '--',
  ]);

  // Nothing ticked apart is nothing to narrow by, which is what the sidebar means by null.
  assert.ok(!authorFilesArgs(['Gaga Liu'], ['refs/heads/main']).includes('--branches'));

  /*
   * A name is a basic regular expression to git, and a Windows domain login has a backslash in it -
   * two of the people in the repository this was written for are listed that way. Escaped, not
   * dropped: `--fixed-strings` would do it, and would also reach the reader's own query.
   */
  const login = 'A02-01564' + String.fromCharCode(92) + 'Poyuan_Jung';

  assert.equal(authorFilesArgs([login], null).find((arg) => arg.startsWith('--author=')), '--author=A02-01564\\\\Poyuan_Jung');

  // A dot is an operator and is escaped; a plus is literal until escaped and must be left alone.
  assert.equal(authorFilesArgs(['C++ fan.jr'], null).find((arg) => arg.startsWith('--author=')), '--author=C++ fan\\.jr');
});

test('the files are counted, and the one changed most often comes first', () => {
  /*
   * The busiest file sorts last by name, on purpose. With `a.ts` as both, alphabetical order and
   * most-changed order are the same list and this asserts nothing about which one is being used.
   */
  const commit = (subject: string, ...paths: string[]): string => `\0${subject}\n\n${paths.join('\n')}\n`;
  const walk = [commit('one', 'z.ts', 'b.ts'), commit('two', 'z.ts'), commit('three', 'c.ts', 'z.ts')].join('');

  assert.deepEqual(parseAuthorFiles(walk).files, [
    { path: 'z.ts', changes: 3 },
    { path: 'b.ts', changes: 1 },
    { path: 'c.ts', changes: 1 },
  ]);

  // Nothing at all is an answer: a person who has changed no files is not an error.
  assert.deepEqual(parseAuthorFiles(''), { files: [], merges: 0, excluded: 0 });

  // A carriage return is a line ending, not part of the name of the file.
  assert.deepEqual(parseAuthorFiles(commit('one', 'a.ts\r') + commit('two', 'a.ts\r')).files, [
    { path: 'a.ts', changes: 2 },
  ]);
});

test('a merge somebody squashed is not work that person did', () => {
  /*
   * git recorded these with one parent, so `--no-merges` keeps them and their diff is the whole of
   * somebody else's branch. Three of them put 635 files into one person's list of 2,623 on the
   * repository this was found on.
   */
  assert.equal(looksLikeMerge("Merge branch 'release/v1.3' of http://host/r into DEV_WEI"), true);
  assert.equal(looksLikeMerge("Merge remote-tracking branch 'origin/uat' into Dev_Thing"), true);
  assert.equal(looksLikeMerge("Merge cs 'x' into y"), true);

  // The word alone is not enough: this one is a refactor, and every file in it is the author's.
  assert.equal(looksLikeMerge('Merge the two config files into one'), false);
  assert.equal(looksLikeMerge('[Fix][MPI045] merge the totals'), false);

  const commit = (subject: string, ...paths: string[]): string => `\0${subject}\n\n${paths.join('\n')}\n`;
  const walk = [
    commit('a change of their own', 'mine.ts'),
    commit("Merge branch 'someone-else' into mine", 'theirs.ts', 'mine.ts'),
  ].join('');

  // The merge is dropped whole - not its files minus the ones they touched - and it is counted.
  assert.deepEqual(parseAuthorFiles(walk), { files: [{ path: 'mine.ts', changes: 1 }], merges: 1, excluded: 0 });
});

test('and nor is a release the reader has already said is not work', () => {
  const commit = (subject: string, ...paths: string[]): string =>
    `\0${subject}\n\n${paths.join('\n')}\n`;
  const walk = [
    commit('a change of their own', 'mine.ts'),
    // A release stamp carries whatever was in the tree when it was cut, under whoever cut it.
    commit('dg_[260101.0900]', 'somebody-elses-scratch.sql', 'mine.ts'),
  ].join('');

  const rule = [/^([a-z]+_)*\[[A-Z]?\d+\.\d+\]$/];

  assert.deepEqual(parseAuthorFiles(walk, rule), {
    files: [{ path: 'mine.ts', changes: 1 }],
    merges: 0,
    excluded: 1,
  });

  // And with no rules written, nothing is left out: this is the reader's list, not a guess.
  assert.equal(parseAuthorFiles(walk).files.length, 2);
  assert.equal(parseAuthorFiles(walk).excluded, 0);
});
