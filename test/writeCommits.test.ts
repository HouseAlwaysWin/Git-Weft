/**
 * Acting on a commit: cherry-pick, revert, reset, merge, rebase, and the conflicts.
 *
 * One of the files `test/write.test.ts` was split into - see `writeSupport.ts` for why, and for
 * everything they have in common.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMenu } from '../src/actions/registry.ts';
import { Operation, readOperation, readRepoState } from '../src/git/repoState.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { branch, commit, fakeUi, git, makeConflictingRepo, makeRepo, open, repoTarget, run, sh } from './writeSupport.ts';

test('cherry-pick brings a commit onto the current branch', async () => {
  const dir = makeRepo();
  const picked = sh(dir, 'rev-parse', 'feature').trim();

  const result = await run(dir, 'weft.cherryPick', commit(picked));

  assert.equal(result.ran, true);
  assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'two\n', 'the change arrived');
  assert.equal(sh(dir, 'rev-list', '--count', 'HEAD').trim(), '2', 'main moved forward by one');

  // Deliberately not asserting the new commit has a different SHA. Picking a commit straight onto
  // its own parent reproduces the same tree, parent, message and author - and when both land in
  // the same second, the same timestamps too, which makes it bit-for-bit the same commit. That is
  // git being correct, and an earlier version of this test failed roughly half the time on it.
  assert.equal(sh(dir, 'rev-parse', 'feature').trim(), picked, 'the source branch is untouched');
});

test('revert undoes a commit with a new commit rather than rewriting history', async () => {
  const dir = makeRepo();
  sh(dir, 'merge', '--no-edit', '-q', 'feature');
  const before = sh(dir, 'rev-parse', 'HEAD').trim();
  const target = sh(dir, 'rev-parse', 'feature').trim();

  await run(dir, 'weft.revert', commit(target));

  assert.equal(existsSync(join(dir, 'b.txt')), false, 'the file the commit added is gone again');
  assert.equal(sh(dir, 'rev-parse', 'HEAD~1').trim(), before, 'the old history is still there');
});

test('reverting a merge picks the mainline and says so', async () => {
  const dir = makeRepo();
  sh(dir, 'merge', '--no-edit', '-q', '--no-ff', 'feature');
  const mergeSha = sh(dir, 'rev-parse', 'HEAD').trim();

  assert.equal(sh(dir, 'rev-list', '--parents', '-n', '1', mergeSha).trim().split(' ').length, 3);

  // Without -m git refuses a merge outright, so this failing means the mainline was not passed.
  const result = await run(dir, 'weft.revert', commit(mergeSha));

  assert.equal(result.ran, true);
  assert.match(result.message, /merged into/);
  assert.equal(existsSync(join(dir, 'b.txt')), false);
});

test('a soft reset moves the branch and stages everything the commits contained', async () => {
  const dir = makeRepo();
  sh(dir, 'merge', '--no-edit', '-q', 'feature');
  const back = sh(dir, 'rev-parse', 'HEAD~1').trim();
  const ui = fakeUi();

  await run(dir, 'weft.resetSoft', commit(back), ui);

  assert.equal(sh(dir, 'rev-parse', 'HEAD').trim(), back);
  assert.match(ui.confirmations[0] ?? '', /moves back 1 commit/);
  assert.match(ui.confirmations[0] ?? '', /reflog/);
  assert.match(sh(dir, 'status', '--porcelain'), /^A  b\.txt/m, 'the change is staged, not lost');
});

test('a hard reset names every uncommitted file it is about to destroy', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'a.txt'), 'work I care about\n');
  const head = sh(dir, 'rev-parse', 'HEAD').trim();
  const ui = fakeUi();

  await run(dir, 'weft.resetHard', commit(head), ui);

  const detail = ui.confirmations[0] ?? '';
  assert.match(detail, /lost permanently/);
  assert.match(detail, /a\.txt/, 'the file at risk has to be named, not merely counted');
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\n', 'and then actually discarded');
});

test('declining a hard reset leaves the working tree exactly as it was', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'a.txt'), 'work I care about\n');
  const head = sh(dir, 'rev-parse', 'HEAD').trim();

  const result = await run(dir, 'weft.resetHard', commit(head), fakeUi({ confirm: false }));

  assert.equal(result.ran, false);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'work I care about\n');
});

test('a hard reset on a clean tree says there is nothing to lose', async () => {
  const dir = makeRepo();
  const back = sh(dir, 'rev-parse', 'HEAD').trim();
  const ui = fakeUi();

  await run(dir, 'weft.resetHard', commit(back), ui);

  assert.match(ui.confirmations[0] ?? '', /nothing uncommitted to lose/);
});

test('soft and mixed resets to the current commit are not offered', async () => {
  const dir = makeRepo();
  const repo = await open(dir);
  const state = await readRepoState(git, repo);
  const here = commit(state.head!);

  const menu = buildMenu(here, state);
  const reason = (id: string) => menu.find((i) => i.id === id)?.disabledReason;

  assert.equal(reason('weft.resetSoft'), 'Already here');
  assert.equal(reason('weft.resetMixed'), 'Already here');
  // Hard is different: resetting to where you already are still throws the working tree away.
  assert.equal(reason('weft.resetHard'), null);
  assert.equal(reason('weft.cherryPick'), 'Already the current commit');
});

test('merging a branch brings its commits in', async () => {
  const dir = makeRepo();

  // `main` is behind `feature` here, so the action asks whether to fast-forward. Answering is part
  // of merging now; the assertions below are about what arrives either way.
  const result = await run(dir, 'weft.merge', branch('feature'), fakeUi({ choices: ['Fast-forward'] }));

  assert.equal(result.ran, true);
  assert.match(result.message, /Merged 1 commit/);
  assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'two\n');
});

test('merging something already merged does nothing and says so', async () => {
  const dir = makeRepo();
  sh(dir, 'merge', '--no-edit', '-q', 'feature');
  const head = sh(dir, 'rev-parse', 'HEAD').trim();

  const result = await run(dir, 'weft.merge', branch('feature'));

  assert.equal(result.ran, false);
  assert.match(result.message, /already in main/);
  assert.equal(sh(dir, 'rev-parse', 'HEAD').trim(), head, 'and makes no empty commit');
});

test('rebase says how many commits it will rewrite before doing it', async () => {
  const dir = makeConflictingRepo();
  sh(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'c.txt'), 'main moves on\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'on main');

  sh(dir, 'checkout', '-q', 'feature');
  const ui = fakeUi();

  await run(dir, 'weft.rebase', branch('main'), ui);

  assert.match(ui.confirmations[0] ?? '', /1 commit on feature will be rewritten/);
  assert.match(ui.confirmations[0] ?? '', /originals stay in the reflog/);
  assert.equal(sh(dir, 'rev-list', '--count', 'HEAD').trim(), '3', 'feature now sits on top of main');
});

test('a conflicted merge is reported as in progress, with the files that need resolving', async () => {
  const dir = makeConflictingRepo();
  sh(dir, 'checkout', '-q', 'main');
  sh(dir, 'merge', '--no-edit', '-q', 'feature');

  // main has b.txt as 'two', conflicting has it as 'theirs'.
  try {
    sh(dir, 'merge', 'conflicting');
  } catch {
    // Expected.
  }

  const repo = await open(dir);
  const state = await readRepoState(git, repo);

  assert.equal(state.operation, Operation.Merge);
  assert.deepEqual(
    state.files.filter((f) => f.conflicted).map((f) => f.path),
    ['b.txt'],
  );

  const controls = buildMenu(repoTarget(), state);
  const reason = (id: string) => controls.find((i) => i.id === id)?.disabledReason;

  assert.equal(reason('weft.continueOperation'), 'Resolve the conflicts first');
  assert.equal(reason('weft.skipOperation'), 'A merge cannot skip a commit');
  assert.equal(reason('weft.abortOperation'), null, 'abort is always the way out');
});

test('aborting puts the repository back where it started', async () => {
  const dir = makeConflictingRepo();
  sh(dir, 'checkout', '-q', 'main');
  sh(dir, 'merge', '--no-edit', '-q', 'feature');
  const before = sh(dir, 'rev-parse', 'HEAD').trim();

  try {
    sh(dir, 'merge', 'conflicting');
  } catch {
    // Expected.
  }

  const result = await run(dir, 'weft.abortOperation', repoTarget());

  assert.equal(result.ran, true);
  assert.equal(sh(dir, 'rev-parse', 'HEAD').trim(), before);
  assert.equal(await readOperation((await open(dir)).gitDir), Operation.None);
  assert.equal(sh(dir, 'status', '--porcelain').trim(), '', 'and leaves a clean tree');
});

test('continue finishes a merge once the conflict is resolved', async () => {
  const dir = makeConflictingRepo();
  sh(dir, 'checkout', '-q', 'main');
  sh(dir, 'merge', '--no-edit', '-q', 'feature');

  try {
    sh(dir, 'merge', 'conflicting');
  } catch {
    // Expected.
  }

  writeFileSync(join(dir, 'b.txt'), 'resolved by hand\n');
  sh(dir, 'add', 'b.txt');

  // `git merge --continue` opens an editor for the message by default; this passing is the proof
  // that the write environment's GIT_EDITOR override works.
  const result = await run(dir, 'weft.continueOperation', repoTarget());

  assert.equal(result.ran, true);
  assert.equal(await readOperation((await open(dir)).gitDir), Operation.None);
  assert.equal(sh(dir, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').length, 3);
});

test('the controls are all unavailable when nothing is in progress', async () => {
  const repo = await open(makeRepo());
  const state = await readRepoState(git, repo);
  const controls = buildMenu(repoTarget(), state);

  for (const id of ['weft.continueOperation', 'weft.abortOperation', 'weft.skipOperation']) {
    assert.equal(
      controls.find((i) => i.id === id)?.disabledReason,
      'Nothing in progress',
      `${id} should be unavailable`,
    );
  }
});
