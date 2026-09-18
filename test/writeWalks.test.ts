/**
 * What a walk contains: only-here, blame, stashes, and the refs it is given.
 *
 * One of the files `test/write.test.ts` was split into - see `writeSupport.ts` for why, and for
 * everything they have in common.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { blameFile } from '../src/git/blame.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { branch, commit, git, made, makeRepo, makeStashed, open, sh, stashMap, walk } from './writeSupport.ts';

test('only-here walks what the named refs have and no other ref does', async () => {
  const dir = makeRepo();

  // `feature` is one commit ahead of `main`, and reaches main's commit as well.
  const reachable = await walk(dir, { refs: ['refs/heads/feature'] });
  const unique = await walk(dir, { refs: ['refs/heads/feature'], onlyHere: true });

  assert.deepEqual(reachable, ['second', 'first'], 'the whole branch is reachable from its tip');
  assert.deepEqual(unique, ['second'], 'only the commit no other ref can reach');
});

test('only-here on a branch everything else has already gets nothing', async () => {
  const dir = makeRepo();

  // Every commit on `main` is also on `feature`, so there is nothing here that is only here.
  assert.deepEqual(await walk(dir, { refs: ['refs/heads/main'], onlyHere: true }), []);
});

test('only-here does not exclude a branch from itself through HEAD', async () => {
  const dir = makeRepo();

  sh(dir, 'checkout', '-q', 'feature');

  assert.deepEqual(
    await walk(dir, { refs: ['refs/heads/feature'], onlyHere: true }),
    ['second'],
    'being checked out must not make a branch invisible to its own filter',
  );
});

test('only-here with every ref in the walk has nothing to exclude, and narrows nothing', async () => {
  const dir = makeRepo();

  const everything = await walk(dir, {});
  const asked = await walk(dir, { onlyHere: true });

  assert.deepEqual(asked, everything);
});

test('blame names the commit behind a line', async () => {
  const dir = makeRepo();
  const blame = await blameFile(git, await open(dir), join(dir, 'a.txt'));

  assert.equal(blame[0]?.author, 'Weft Test');
  assert.equal(blame[0]?.summary, 'first');
  assert.equal(blame[0]?.uncommitted, false);
  assert.ok(blame[0]!.authorTime > 0, 'and when, in milliseconds');
});

test('blame follows the buffer when it is handed one', async () => {
  const dir = makeRepo();
  const repo = await open(dir);

  const blame = await blameFile(git, repo, join(dir, 'a.txt'), 'typed above\none\n');

  assert.equal(blame[0]?.uncommitted, true, 'the line that was just typed belongs to nobody yet');
  assert.equal(blame[1]?.summary, 'first', 'and the one it pushed down is still the commit it was');
});

test('a file git will not blame comes back empty rather than throwing', async () => {
  const dir = makeRepo();
  const repo = await open(dir);

  writeFileSync(join(dir, 'untracked.txt'), 'never added\n');

  assert.deepEqual(await blameFile(git, repo, join(dir, 'untracked.txt')), []);
  assert.deepEqual(await blameFile(git, repo, join(dir, 'not-even-there.txt')), []);
});

test('a stash does not drag its branch into a walk that excluded it', async () => {
  const dir = makeStashed();
  const stashes = await stashMap(dir);

  assert.equal(stashes.size, 1, 'the fixture should have one stash');

  const subjects = await walk(dir, { refs: ['refs/heads/feature'], stashes });

  assert.deepEqual(subjects, ['only on feature', 'base'], 'feature, and nothing the stash reaches');
});

test('a stash made where the walk goes is still drawn', async () => {
  const dir = makeStashed();
  const stashes = await stashMap(dir);

  const subjects = await walk(dir, { refs: ['refs/heads/main'], stashes });

  assert.ok(
    subjects.some((subject) => subject.startsWith('WIP on main')),
    `the stash belongs in its own branch's walk: ${subjects.join(', ')}`,
  );
});

test('nothing is narrowing the walk, so every stash is in it', async () => {
  const dir = makeStashed();
  const stashes = await stashMap(dir);

  const subjects = await walk(dir, { stashes });

  assert.ok(
    subjects.some((subject) => subject.startsWith('WIP on main')),
    `an unfiltered graph draws every stash: ${subjects.join(', ')}`,
  );
});
