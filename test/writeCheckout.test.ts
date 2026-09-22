/**
 * Checking out, the repository lock, and what `git status` says.
 *
 * One of the files `test/write.test.ts` was split into - see `writeSupport.ts` for why, and for
 * everything they have in common.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMenu, findAction } from '../src/actions/registry.ts';
import { Remedy, mapGitError } from '../src/git/errors.ts';
import { GitError } from '../src/git/exec.ts';
import { canPutBack } from '../src/git/repoState.ts';
import { RepoLock } from '../src/git/lock.ts';
import { Operation, parseStatus, readOperation, readRepoState, workAtRisk } from '../src/git/repoState.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { branch, commit, fakeUi, git, makeRepo, open, sh } from './writeSupport.ts';

test('checkout moves HEAD to the branch', async () => {
  const dir = makeRepo();
  const repo = await open(dir);
  const action = findAction('weft.checkoutBranch');

  assert.notEqual(action, undefined);

  const state = await readRepoState(git, repo);
  assert.equal(state.branch, 'main');

  await action?.run({ git, repo, state, target: branch('feature'), ui: fakeUi() });

  assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature');
});

test('checkout is offered for another branch and refused for the current one', async () => {
  const repo = await open(makeRepo());
  const state = await readRepoState(git, repo);

  const other = buildMenu(branch('feature'), state);
  const current = buildMenu(branch('main'), state);

  assert.equal(other[0]?.disabledReason, null);
  assert.equal(current[0]?.disabledReason, 'Already checked out');
});

test('nothing is offered while another operation is in progress', async () => {
  const dir = makeRepo();
  const repo = await open(dir);

  // Stop a real merge on a conflict rather than faking the state file, so this tests the same
  // thing the user would hit.
  sh(dir, 'checkout', '-q', '-b', 'conflicting', 'main');
  writeFileSync(join(dir, 'b.txt'), 'different\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'conflicting');

  try {
    sh(dir, 'merge', 'feature');
  } catch {
    // Expected: the merge conflicts and leaves MERGE_HEAD behind.
  }

  assert.equal(await readOperation(repo.gitDir), Operation.Merge);

  const state = await readRepoState(git, repo);
  assert.equal(state.operation, Operation.Merge);
  assert.equal(buildMenu(branch('main'), state)[0]?.disabledReason, 'Finish a merge first');
});

test('checkout refuses rather than discarding uncommitted work', async () => {
  const dir = makeRepo();
  const repo = await open(dir);

  // b.txt exists on feature but not on main, so an uncommitted b.txt is in the way of switching.
  writeFileSync(join(dir, 'b.txt'), 'work in progress\n');

  const state = await readRepoState(git, repo);
  const action = findAction('weft.checkoutBranch');

  await assert.rejects(
    () => action?.run({ git, repo, state, target: branch('feature'), ui: fakeUi() }) as Promise<unknown>,
    GitError,
  );

  assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main', 'HEAD must not move');
  assert.equal(
    readFileSync(join(dir, 'b.txt'), 'utf8'),
    'work in progress\n',
    'the refusal is only worth anything if the work is still there afterwards',
  );
});

test('the refusal maps to an offer to stash', async () => {
  const dir = makeRepo();
  const repo = await open(dir);

  writeFileSync(join(dir, 'b.txt'), 'work in progress\n');
  const state = await readRepoState(git, repo);

  try {
    await findAction('weft.checkoutBranch')?.run({
      git,
      repo,
      state,
      target: branch('feature'),
      ui: fakeUi(),
    });
    assert.fail('expected the checkout to be refused');
  } catch (err) {
    const mapped = mapGitError(err);

    assert.match(mapped.message, /would be overwritten/);
    assert.ok(mapped.remedies.includes(Remedy.StashAndRetry));
    assert.deepEqual(mapped.paths, ['b.txt'], 'the dialog needs the file names, not just a warning');
  }
});

test('uncommitted work is reported, untracked files are not counted as at risk', async () => {
  const dir = makeRepo();
  const repo = await open(dir);

  writeFileSync(join(dir, 'a.txt'), 'edited\n');
  writeFileSync(join(dir, 'brand-new.txt'), 'untracked\n');

  const state = await readRepoState(git, repo);
  const risky = workAtRisk(state).map((file) => file.path);

  assert.deepEqual(risky, ['a.txt']);
  assert.equal(state.files.some((file) => file.path === 'brand-new.txt' && file.untracked), true);
});

test('status parsing does not shift records after a rename', () => {
  // `R  new\0old\0M  other\0` - the rename's source path is a field of its own.
  const files = parseStatus('R  new/name.ts\x00old/name.ts\x00M  other.ts\x00?? junk.txt\x00');

  assert.deepEqual(
    files.map((f) => f.path),
    ['new/name.ts', 'other.ts', 'junk.txt'],
  );
  assert.equal(files[1]?.code, 'M ');
  assert.equal(files[2]?.untracked, true);
});

test('conflicted files are recognised in every unmerged form', () => {
  const files = parseStatus('UU both.ts\x00AA added.ts\x00DD gone.ts\x00M  normal.ts\x00');
  const conflicted = files.filter((f) => f.conflicted).map((f) => f.path);

  assert.deepEqual(conflicted, ['both.ts', 'added.ts', 'gone.ts']);
});

test('the lock serialises writers and survives one of them failing', async () => {
  const lock = new RepoLock();
  const order: string[] = [];

  const slow = lock.run('r', async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.push('first');
  });

  const failing = lock.run('r', async () => {
    order.push('second');
    throw new Error('boom');
  });

  const after = lock.run('r', async () => {
    order.push('third');
  });

  await slow;
  await assert.rejects(() => failing, /boom/);
  await after;

  assert.deepEqual(order, ['first', 'second', 'third'], 'a failure must not skip or poison the queue');
  assert.equal(lock.isBusy('r'), false, 'the queue should drain');
});

test('a ref that could not be locked says what state it left behind, and offers to retry', () => {
  const mapped = mapGitError(
    new GitError(
      ['checkout', 'other'],
      128,
      'error: unable to write symref for HEAD: Permission denied\nfatal: unable to update HEAD\n',
    ),
  );

  // The words git chooses read like nothing happened. The files have already moved.
  assert.match(mapped.message, /working tree now holds the other branch/);
  assert.deepEqual(mapped.remedies, [Remedy.Retry, Remedy.ShowLog]);

  /*
   * And it goes again by itself before anybody is asked. The state it leaves is the dangerous one -
   * the index and the working tree on one branch, HEAD on another - the cause is a passing lock that
   * the reader cannot do anything about, and the remedy is the same command. A button whose answer
   * is never anything else is a button not worth offering first.
   */
  assert.equal(mapped.retryBySelf, true);
});

test('a switch is only undone when there is nothing of yours to lose by it', () => {
  /*
   * Undoing it is `git reset --hard HEAD`, and a checkout carries uncommitted changes across when
   * they do not conflict - so after a failed one they are in there with the other branch's files.
   * From a clean tree there is nothing to lose. From anything else the cure is worse than the state,
   * and this is the line between them.
   */
  const state = (files: unknown[], branch: string | null = 'main') =>
    ({
      operation: 'none',
      head: 'abc',
      branch,
      detached: branch === null,
      files,
      branches: [],
      tags: [],
      remotes: [],
      upstream: null,
      fetchedAt: null,
    }) as unknown as Parameters<typeof canPutBack>[0];

  assert.equal(canPutBack(state([])), true);

  // One modified file is one file somebody would lose, and it is not this code's to spend.
  assert.equal(canPutBack(state([{ path: 'a.ts', code: ' M' }])), false);

  // Nothing to say afterwards, so nothing worth writing: there is no branch you are still on.
  assert.equal(canPutBack(state([], null)), false);
  assert.equal(canPutBack(null), false);
});

test('a failure about this repository is not run again behind the reader', () => {
  /*
   * The opposite case, and the reason the flag is on one rule rather than on retrying in general:
   * these are about what the repository holds. Doing them again does the same thing again, and the
   * second failure is as useless as the first.
   */
  for (const [args, stderr] of [
    [
      ['checkout', 'other'],
      'error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.ts\n',
    ],
    [['merge', 'other'], 'CONFLICT (content): Merge conflict in src/a.ts\n'],
    [
      ['push'],
      'error: failed to push some refs\nhint: Updates were rejected because the remote contains work\n',
    ],
  ] as const) {
    assert.notEqual(
      mapGitError(new GitError([...args], 1, stderr)).retryBySelf,
      true,
      stderr.split('\n')[0],
    );
  }
});

test('an unrecognised failure keeps git own words rather than inventing vaguer ones', () => {
  const mapped = mapGitError(new GitError(['push'], 1, 'fatal: something entirely new happened\n'));

  assert.equal(mapped.message, 'something entirely new happened');
  assert.ok(mapped.remedies.includes(Remedy.ShowLog));
});
