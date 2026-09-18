/**
 * Talking to a remote: push, fetch, pull, cancellation, and managing remotes.
 *
 * One of the files `test/write.test.ts` was split into - see `writeSupport.ts` for why, and for
 * everything they have in common.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMenu } from '../src/actions/registry.ts';
import { Remedy, mapGitError } from '../src/git/errors.ts';
import { GitTimeoutError } from '../src/git/exec.ts';
import { nameProblem, readRemotes } from '../src/git/remotes.ts';
import { Operation, parseBranchHeader, parseStatus, readOperation, readRepoState } from '../src/git/repoState.ts';
import { join } from 'node:path';

import { REPO, branch, cloneOf, commit, commitIn, ending, fakeUi, git, launched, launcher, makeDivergence, makeRepo, makeRepoWithRemote, open, remoteNames, repoTarget, run, sh, silentRemote, tracking, walk, within } from './writeSupport.ts';

test('the branch header carries the upstream and both counts', () => {
  assert.deepEqual(parseBranchHeader('## main...origin/main [ahead 1, behind 2]\x00'), {
    ref: 'origin/main',
    ahead: 1,
    behind: 2,
    gone: false,
  });

  assert.deepEqual(parseBranchHeader('## main...origin/main\x00'), {
    ref: 'origin/main',
    ahead: 0,
    behind: 0,
    gone: false,
  });

  assert.equal(parseBranchHeader('## main...origin/main [gone]\x00')?.gone, true);

  // No upstream, detached, and an unborn branch all mean "nothing to compare against".
  assert.equal(parseBranchHeader('## solo\x00'), null);
  assert.equal(parseBranchHeader('## HEAD (no branch)\x00'), null);
  assert.equal(parseBranchHeader('## No commits yet on main\x00'), null);
});

test('a branch header is not mistaken for a changed file', () => {
  const files = parseStatus('## main...origin/main [ahead 1]\x00 M a.txt\x00');

  assert.deepEqual(files.map((f) => f.path), ['a.txt']);
});

test('state reads the remotes and where the branch stands against its upstream', async () => {
  const { dir } = makeRepoWithRemote();
  const state = await readRepoState(git, await open(dir));

  assert.deepEqual(state.remotes, ['origin']);
  assert.deepEqual(state.upstream, { ref: 'origin/main', ahead: 0, behind: 0, gone: false });

  commitIn(dir, 'c.txt', 'three\n', 'third');
  const ahead = await readRepoState(git, await open(dir));

  assert.equal(ahead.upstream?.ahead, 1);
});

test('pushing a branch that tracks nothing publishes it and sets the upstream', async () => {
  const { dir, remote } = makeRepoWithRemote();
  sh(dir, 'checkout', '-q', 'feature');

  const result = await run(dir, 'weft.push', repoTarget());

  assert.equal(result.ran, true);
  assert.match(result.message, /track/);
  assert.equal(
    sh(remote, 'rev-parse', 'refs/heads/feature').trim(),
    sh(dir, 'rev-parse', 'HEAD').trim(),
    'the remote should have the branch',
  );
  assert.equal(sh(dir, 'config', '--get', 'branch.feature.remote').trim(), 'origin');
});

test('pushing an existing upstream reports how many commits went', async () => {
  const { dir, remote } = makeRepoWithRemote();
  commitIn(dir, 'c.txt', 'three\n', 'third');
  commitIn(dir, 'd.txt', 'four\n', 'fourth');

  const result = await run(dir, 'weft.push', repoTarget());

  assert.match(result.message, /2 commits/);
  assert.equal(sh(remote, 'rev-parse', 'main').trim(), sh(dir, 'rev-parse', 'HEAD').trim());
});

test('pushing with nothing to push says so instead of running git', async () => {
  const { dir } = makeRepoWithRemote();
  const result = await run(dir, 'weft.push', repoTarget());

  assert.match(result.message, /already has everything/);
});

test('a push the remote has moved past is rejected, and the message says why', async () => {
  const { dir, remote } = makeRepoWithRemote();

  const other = cloneOf(remote);
  commitIn(other, 'theirs.txt', 'theirs\n', 'from someone else');
  sh(other, 'push', '-q');

  commitIn(dir, 'ours.txt', 'ours\n', 'ours');

  await assert.rejects(
    () => run(dir, 'weft.push', repoTarget()),
    (err: unknown) => {
      const mapped = mapGitError(err);
      assert.match(mapped.message, /remote/i);
      assert.deepEqual(mapped.remedies, [Remedy.Fetch], 'and offers to go and look');
      return true;
    },
  );

  // The important half: the remote still has their commit, not ours.
  assert.equal(sh(remote, 'rev-parse', 'main').trim(), sh(other, 'rev-parse', 'HEAD').trim());
});

test('force push says how many commits on the remote it would strand', async () => {
  const { dir, remote } = makeRepoWithRemote();

  const other = cloneOf(remote);
  commitIn(other, 'theirs.txt', 'theirs\n', 'from someone else');
  sh(other, 'push', '-q');

  commitIn(dir, 'ours.txt', 'ours\n', 'ours');

  const ui = fakeUi({ confirm: false });
  const result = await run(dir, 'weft.pushForce', repoTarget(), ui);

  assert.equal(result.ran, false, 'declining leaves the remote alone');
  assert.match(ui.confirmations[0] ?? '', /1 commit on origin\/main will stop being reachable/);
  assert.match(ui.confirmations[0] ?? '', /not in your reflog/);
  assert.equal(sh(remote, 'rev-parse', 'main').trim(), sh(other, 'rev-parse', 'HEAD').trim());
});

test('force push replaces the remote branch once it is confirmed', async () => {
  const { dir, remote } = makeRepoWithRemote();

  const other = cloneOf(remote);
  commitIn(other, 'theirs.txt', 'theirs\n', 'from someone else');
  sh(other, 'push', '-q');

  const ours = commitIn(dir, 'ours.txt', 'ours\n', 'ours');
  const result = await run(dir, 'weft.pushForce', repoTarget());

  assert.equal(result.ran, true);
  assert.equal(sh(remote, 'rev-parse', 'main').trim(), ours);
});

test('the lease refuses a force push when the remote moved while the dialog was open', async () => {
  const { dir, remote } = makeRepoWithRemote();

  const other = cloneOf(remote);
  commitIn(other, 'theirs.txt', 'theirs\n', 'from someone else');
  sh(other, 'push', '-q');

  commitIn(dir, 'ours.txt', 'ours\n', 'ours');

  // This is the whole point of --force-with-lease over --force: the fetch inside confirmDetail
  // has already run, so the lease is current, and then somebody pushes anyway.
  const theirsLatest = { sha: '' };
  const ui = fakeUi({
    whileConfirming: () => {
      theirsLatest.sha = commitIn(other, 'theirs2.txt', 'more\n', 'and another');
      sh(other, 'push', '-q');
    },
  });

  await assert.rejects(
    () => run(dir, 'weft.pushForce', repoTarget(), ui),
    (err: unknown) => {
      assert.match(mapGitError(err).message, /lease refused/);
      return true;
    },
  );

  assert.equal(
    sh(remote, 'rev-parse', 'main').trim(),
    theirsLatest.sha,
    'their newest commit survives - which --force would have destroyed',
  );
});

test('fetch updates the remote-tracking ref and touches nothing else', async () => {
  const { dir, remote } = makeRepoWithRemote();
  const before = sh(dir, 'rev-parse', 'HEAD').trim();

  const other = cloneOf(remote);
  const theirs = commitIn(other, 'theirs.txt', 'theirs\n', 'from someone else');
  sh(other, 'push', '-q');

  const result = await run(dir, 'weft.fetch', repoTarget());

  assert.match(result.message, /1 commit/);
  assert.equal(sh(dir, 'rev-parse', 'origin/main').trim(), theirs);
  assert.equal(sh(dir, 'rev-parse', 'HEAD').trim(), before, 'HEAD does not move');
  assert.equal(sh(dir, 'status', '--porcelain').trim(), '', 'and the tree stays clean');
});

test('pull fast-forwards without asking anything', async () => {
  const { dir, remote } = makeRepoWithRemote();

  const other = cloneOf(remote);
  const theirs = commitIn(other, 'theirs.txt', 'theirs\n', 'from someone else');
  sh(other, 'push', '-q');

  const ui = fakeUi();
  const result = await run(dir, 'weft.pull', repoTarget(), ui);

  assert.deepEqual(ui.questions, [], 'a fast-forward is not a decision');
  assert.match(result.message, /Fast-forwarded 1 commit/);
  assert.equal(sh(dir, 'rev-parse', 'HEAD').trim(), theirs);
});

test('pull with nothing to get says so', async () => {
  const { dir } = makeRepoWithRemote();
  const result = await run(dir, 'weft.pull', repoTarget());

  assert.match(result.message, /Already up to date/);
});

test('pull asks how to reconcile when both sides have moved, and merges when told to', async () => {
  const { dir, theirs } = makeDivergence();
  const ui = fakeUi({ choices: ['Merge'] });

  const result = await run(dir, 'weft.pull', repoTarget(), ui);

  assert.equal(ui.questions.length, 1, 'it asks exactly once');
  assert.match(ui.questions[0] ?? '', /have both moved/);
  assert.equal(result.ran, true);

  const parents = sh(dir, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ');
  assert.equal(parents.length, 3, 'a merge commit');
  assert.ok(parents.includes(theirs), 'with their commit as a parent');
});

test('pull rebases instead when told to, and keeps one line of history', async () => {
  const { dir, theirs } = makeDivergence();
  const ui = fakeUi({ choices: ['Rebase'] });

  const result = await run(dir, 'weft.pull', repoTarget(), ui);

  assert.match(result.message, /Rebased 1 commit/);

  const parents = sh(dir, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ');
  assert.equal(parents.length, 2, 'not a merge');
  assert.equal(parents[1], theirs, 'replayed straight onto theirs');
});

test('dismissing the question leaves the repository exactly where it was', async () => {
  const { dir } = makeDivergence();
  const head = sh(dir, 'rev-parse', 'HEAD').trim();

  const result = await run(dir, 'weft.pull', repoTarget(), fakeUi({ choices: [] }));

  assert.equal(result.ran, false);
  assert.equal(sh(dir, 'rev-parse', 'HEAD').trim(), head);
  assert.equal(await readOperation((await open(dir)).gitDir), Operation.None);
});

test('the in-progress banner offers only ways out of the operation', async () => {
  const { dir } = makeRepoWithRemote();
  const state = await readRepoState(git, await open(dir));

  // The banner renders every repo-targeted action in the `operation` group. Selecting by exclusion
  // instead put Force Push in there, one click from someone trying to escape a bad rebase.
  const banner = buildMenu(repoTarget(), state)
    .filter((item) => item.group === 'operation')
    .map((item) => item.id);

  assert.deepEqual(banner.sort(), [
    'weft.abortOperation',
    'weft.continueOperation',
    'weft.skipOperation',
  ]);
});

test('network actions are unavailable with no remote, and say which is missing', async () => {
  const repo = await open(makeRepo());
  const state = await readRepoState(git, repo);
  const menu = buildMenu(repoTarget(), state);

  for (const id of ['weft.fetch', 'weft.pull', 'weft.push', 'weft.pushForce']) {
    assert.equal(menu.find((item) => item.id === id)?.disabledReason, 'No remotes configured', id);
  }
});

test('pull is unavailable on a branch that tracks nothing', async () => {
  const { dir } = makeRepoWithRemote();
  sh(dir, 'checkout', '-q', 'feature');

  const state = await readRepoState(git, await open(dir));
  const menu = buildMenu(repoTarget(), state);

  assert.equal(
    menu.find((item) => item.id === 'weft.pull')?.disabledReason,
    'This branch is not tracking a remote',
  );

  // Push is still offered - that is exactly how a branch gets an upstream in the first place.
  assert.equal(menu.find((item) => item.id === 'weft.push')?.disabledReason, null);
});

test('a remote that connects and then says nothing is given up on, not waited on forever', async () => {
  const dir = makeRepo();
  const remote = await silentRemote();

  try {
    const failure = launched.runNetwork(dir, ['fetch', remote.url], { idleTimeoutMs: 1500 }).then(
      () => null,
      (err: unknown) => err,
    );

    // A deadline of its own: a git that is never given up on has to fail this test, not hang the
    // run - which is what it did, for eleven minutes, before anything looked.
    assert.ok(await within(failure, 15_000), 'it gives up promptly rather than hanging the host');

    const err = await failure;
    assert.ok(err instanceof GitTimeoutError, `expected a timeout, got ${String(err)}`);
    assert.match(err.message, /stopped responding/);

    // Given up on and ended. Ending only the launcher left the real git on the connection - and on
    // the pipes, so the wait above never finished at all.
    assert.ok(await within(remote.hungUp, 5_000), 'and the git that was waiting on it is gone');
  } finally {
    remote.close();
  }
});

test('cancelling a command ends git, not just the wait for it', async () => {
  const dir = makeRepo();

  // Both ways git is run: to the end, and streamed. A fetch stands in for a walk on the streamed
  // side, because any walk this repository could hold is over before it can be cancelled.
  const ways: [string, (url: string, signal: AbortSignal) => Promise<unknown>][] = [
    ['run', (url, signal) => launched.runNetwork(dir, ['fetch', url], { signal, idleTimeoutMs: 0 })],
    ['streamed', (url, signal) => launched.stream(dir, ['fetch', url], () => undefined, { signal })],
  ];

  for (const [way, run] of ways) {
    const remote = await silentRemote();
    const controller = new AbortController();

    try {
      const outcome = ending(run(remote.url, controller.signal));

      assert.ok(await within(remote.reached, 10_000), `${way}: git reached the remote`);
      controller.abort();

      assert.ok(await within(outcome, 5_000), `${way}: the cancel is heard promptly`);
      assert.equal(await outcome, 'cancelled', way);
      assert.ok(await within(remote.hungUp, 5_000), `${way}: and the git it cancelled is gone`);
    } finally {
      remote.close();
    }
  }
});

test('a cancelled git is let go even when something it started still holds its output', async () => {
  // What no kill can reach: a process whose parent has already exited belongs to no tree. The alias
  // leaves one behind on git's stdout, says so, and waits - so the cancel is only heard in time if
  // the pipes are let go once git itself has gone.
  const dir = makeRepo();
  const controller = new AbortController();
  let said = '';
  let ready = (): void => undefined;
  const readied = new Promise<void>((resolve) => {
    ready = () => resolve();
  });

  const outcome = ending(
    launched.stream(
      dir,
      ['-c', 'alias.linger=!(sleep 20 &); echo ready; sleep 20', 'linger'],
      (text) => {
        said += text;

        if (said.includes('ready')) {
          ready();
        }
      },
      { signal: controller.signal },
    ),
  );

  assert.ok(await within(readied, 10_000), 'the alias got as far as leaving something behind');
  controller.abort();

  assert.ok(await within(outcome, 5_000), 'the cancel is heard promptly');
  assert.equal(await outcome, 'cancelled');
});

test('a remote name git would reject never reaches git', () => {
  assert.equal(nameProblem('upstream', ['origin']), null);
  assert.match(nameProblem('', []) ?? '', /needs a name/);
  assert.match(nameProblem('two words', []) ?? '', /spaces/);
  // `origin/x` would make `origin/x/main` ambiguous with a branch called `x/main` on `origin`.
  assert.match(nameProblem('origin/x', []) ?? '', /slash/);
  assert.match(nameProblem('-f', []) ?? '', /dash/);
  assert.match(nameProblem('.', []) ?? '', /this repository/);
  assert.match(nameProblem('origin', ['origin']) ?? '', /already a remote called origin/);
});

test('adding a remote configures it and fetches what is on it', async () => {
  const dir = makeRepo();
  const server = makeRepo();

  const ui = fakeUi({ choices: ['Add a remote...'], inputs: ['origin', server] });
  const result = await run(dir, 'weft.manageRemotes', REPO, ui);

  assert.equal(result.ran, true);
  assert.deepEqual(remoteNames(dir), ['origin']);
  assert.equal(sh(dir, 'remote', 'get-url', 'origin').trim(), server);

  // Configured is half of it. The branches on the other repository have to have arrived.
  assert.ok(
    tracking(dir, 'origin').includes('refs/remotes/origin/main'),
    `expected origin/main among ${tracking(dir, 'origin').join(', ')}`,
  );
  assert.match(result.message, /Added origin and fetched it/);
});

test('a remote that cannot be reached is still added, and says so', async () => {
  const dir = makeRepo();
  const nowhere = join(dir, 'not-a-repository');

  const ui = fakeUi({ choices: ['Add a remote...'], inputs: ['origin', nowhere] });
  const result = await run(dir, 'weft.manageRemotes', REPO, ui);

  // The distinction that matters: the fetch failed, the configuration did not, and the message has
  // to say which - otherwise the next thing the user does is add it again.
  assert.deepEqual(remoteNames(dir), ['origin']);
  assert.match(result.message, /Added origin\. Fetching it failed/);
});

test('renaming a remote takes its tracking refs with it', async () => {
  const dir = makeRepo();
  const server = makeRepo();

  sh(dir, 'remote', 'add', 'origin', server);
  sh(dir, 'fetch', '-q', 'origin');
  assert.ok(tracking(dir, 'origin').length > 0, 'fixture should have fetched something');

  const remotes = await readRemotes(git, await open(dir));
  const ui = fakeUi({ choices: [`origin  ${server}`, 'Rename'], inputs: ['upstream'] });
  const result = await run(dir, 'weft.manageRemotes', REPO, ui);

  assert.equal(remotes.length, 1);
  assert.equal(result.ran, true);
  assert.deepEqual(remoteNames(dir), ['upstream']);
  assert.deepEqual(tracking(dir, 'origin'), [], 'the old tracking refs should be gone');
  assert.ok(tracking(dir, 'upstream').includes('refs/remotes/upstream/main'));
});

test('changing a remote URL repoints it and does not fetch', async () => {
  const dir = makeRepo();
  const server = makeRepo();
  const moved = makeRepo();

  sh(dir, 'remote', 'add', 'origin', server);
  sh(dir, 'fetch', '-q', 'origin');
  const before = tracking(dir, 'origin');

  const ui = fakeUi({ choices: [`origin  ${server}`, 'Change URL'], inputs: [moved] });
  const result = await run(dir, 'weft.manageRemotes', REPO, ui);

  assert.equal(sh(dir, 'remote', 'get-url', 'origin').trim(), moved);

  // Refs fetched from the old URL are left exactly as they were: whether they still mean anything
  // is not something the action can know, so it does not quietly decide.
  assert.deepEqual(tracking(dir, 'origin'), before);
  assert.match(result.message, /Fetch to see what is there/);
});

test('removing a remote counts what it strands, and deletes it', async () => {
  const dir = makeRepo();
  const server = makeRepo();

  sh(dir, 'remote', 'add', 'origin', server);
  sh(dir, 'fetch', '-q', 'origin');
  const stranded = tracking(dir, 'origin').length;
  assert.ok(stranded > 0);

  const ui = fakeUi({ choices: [`origin  ${server}`, 'Remove origin'] });
  const result = await run(dir, 'weft.manageRemotes', REPO, ui);

  assert.match(ui.confirmations[0] ?? '', new RegExp(`^${stranded} remote-tracking branch`));
  assert.match(ui.confirmations[0] ?? '', /Nothing on the server changes/);
  assert.equal(result.ran, true);
  assert.deepEqual(remoteNames(dir), []);
  assert.deepEqual(tracking(dir, 'origin'), []);
});

test('backing out of removing a remote leaves it alone', async () => {
  const dir = makeRepo();
  const server = makeRepo();

  sh(dir, 'remote', 'add', 'origin', server);
  sh(dir, 'fetch', '-q', 'origin');
  const before = tracking(dir, 'origin');

  const ui = fakeUi({ confirm: false, choices: [`origin  ${server}`, 'Remove origin'] });
  const result = await run(dir, 'weft.manageRemotes', REPO, ui);

  assert.equal(result.ran, false);
  assert.deepEqual(remoteNames(dir), ['origin']);
  assert.deepEqual(tracking(dir, 'origin'), before);
});

test('a separate push URL is read back, and the same one is not', async () => {
  const dir = makeRepo();
  const server = makeRepo();
  const elsewhere = makeRepo();

  sh(dir, 'remote', 'add', 'origin', server);

  // With no pushurl set, `git remote -v` prints the fetch URL for both. Reporting that as a
  // separate push URL would put a redundant "(pushes to ...)" on every remote there is.
  const plain = await readRemotes(git, await open(dir));
  assert.equal(plain[0]?.fetchUrl, server);
  assert.equal(plain[0]?.pushUrl, null);

  sh(dir, 'remote', 'set-url', '--push', 'origin', elsewhere);
  const split = await readRemotes(git, await open(dir));
  assert.equal(split[0]?.fetchUrl, server);
  assert.equal(split[0]?.pushUrl, elsewhere);
});

test('managing remotes is offered even when there are none', async () => {
  const dir = makeRepo();
  const repo = await open(dir);
  const state = await readRepoState(git, repo);

  const menu = buildMenu({ kind: 'repo' }, state);
  const entry = menu.find((item) => item.id === 'weft.manageRemotes');

  // Every other network action is greyed out with "No remotes configured", which is a dead end if
  // the only way to configure one is also greyed out.
  assert.notEqual(entry, undefined);
  assert.equal(entry?.disabledReason, null);
  assert.equal(
    menu.find((item) => item.id === 'weft.fetch')?.disabledReason,
    'No remotes configured',
  );
});
