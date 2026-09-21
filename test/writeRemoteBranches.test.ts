/**
 * Remote branches, the merge questions, and everything that needs a second repository.
 *
 * One of the files `test/write.test.ts` was split into - see `writeSupport.ts` for why, and for
 * everything they have in common.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { interactiveRebaseArgs, interactiveRebaseEnv } from '../src/actions/merge.ts';
import { buildMenu, confirmIfNeeded, findAction } from '../src/actions/registry.ts';
import type { ActionUi, Target } from '../src/actions/registry.ts';
import { blameFile } from '../src/git/blame.ts';
import { compareCommits } from '../src/git/details.ts';
import { Git } from '../src/git/exec.ts';
import { Operation, describeOperation, readRepoState } from '../src/git/repoState.ts';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { branch, commit, fakeEditor, fakeUi, git, made, makeBehind, makeDiverged, makeRepo, makeServed, open, parentCount, remoteRef, run, serverBranches, sh, stashTarget, tracking, withEditor } from './writeSupport.ts';

test('checking out a remote branch whose local branch exists goes to the local branch', async () => {
  const { dir } = makeServed();
  const repo = await open(dir);
  const state = await readRepoState(git, repo);

  assert.equal(
    findAction('weft.checkoutRemoteBranch')?.unavailable(remoteRef('origin/doomed'), state),
    null,
    'the local branch existing is what makes this possible, not what blocks it',
  );

  const result = await run(dir, 'weft.checkoutRemoteBranch', remoteRef('origin/doomed'));

  assert.equal(result.ran, true);
  assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'doomed');
  assert.match(
    sh(dir, 'status', '--short', '--branch'),
    /## doomed/,
    'on the branch, not detached at the remote tip',
  );
});

test('checking out a remote branch with no local branch creates one that tracks it', async () => {
  const { dir } = makeServed();
  sh(dir, 'branch', '-D', 'doomed');

  const result = await run(dir, 'weft.checkoutRemoteBranch', remoteRef('origin/doomed'));

  assert.equal(result.ran, true);
  assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'doomed');
  assert.equal(
    sh(dir, 'config', '--get', 'branch.doomed.remote').trim(),
    'origin',
    'and following the remote it came from',
  );
});

test('a remote branch is refused only when the branch it leads to is the one already on', async () => {
  const { dir } = makeServed();
  const repo = await open(dir);
  const state = await readRepoState(git, repo);

  assert.equal(
    findAction('weft.checkoutRemoteBranch')?.unavailable(remoteRef('origin/main'), state),
    'Already checked out',
  );
});

test('deleting a remote branch removes it from the server, not just here', async () => {
  const { dir, server } = makeServed();

  assert.deepEqual(serverBranches(server), ['doomed', 'main']);

  const ui = fakeUi();
  const result = await run(dir, 'weft.deleteRemoteBranch', remoteRef('origin/doomed'), ui);

  assert.equal(result.ran, true);
  assert.deepEqual(serverBranches(server), ['main'], 'the branch should be gone from the server');

  // The push takes the remote-tracking ref with it, so nothing is left pointing at a branch that
  // no longer exists.
  assert.equal(sh(dir, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/doomed').trim(), '');
});

test('the confirmation names the remote, the strandings, and what stops tracking', async () => {
  const { dir } = makeServed();

  // A local branch tracking the one about to go.
  sh(dir, 'checkout', '-q', '-b', 'mine', '--track', 'origin/doomed');
  sh(dir, 'checkout', '-q', 'main');

  const ui = fakeUi();
  await run(dir, 'weft.deleteRemoteBranch', remoteRef('origin/doomed'), ui);

  const said = ui.confirmations[0] ?? '';

  assert.match(said, /will be deleted from origin/);
  assert.match(said, /Everyone who fetches from it loses the branch/);
  assert.match(said, /mine tracks it/);
  // The habit that makes deleting a local branch feel cheap is the reflog, and it does not apply.
  assert.match(said, /no reflog on the server/);
});

test('a remote branch whose commits are reachable elsewhere says nothing was stranded', async () => {
  const { dir } = makeServed();

  // Merge it, so its commits are on main too.
  sh(dir, 'merge', '-q', '--no-edit', 'doomed');

  const ui = fakeUi();
  await run(dir, 'weft.deleteRemoteBranch', remoteRef('origin/doomed'), ui);

  assert.doesNotMatch(ui.confirmations[0] ?? '', /can be reached from nothing else/);
});

test('backing out of deleting a remote branch leaves it on the server', async () => {
  const { dir, server } = makeServed();

  const ui = fakeUi({ confirm: false });
  const result = await run(dir, 'weft.deleteRemoteBranch', remoteRef('origin/doomed'), ui);

  assert.equal(result.ran, false);
  assert.deepEqual(serverBranches(server), ['doomed', 'main']);
});

test('origin/HEAD is not offered for deletion, and neither is an unknown remote', async () => {
  const { dir } = makeServed();
  const repo = await open(dir);
  const state = await readRepoState(git, repo);
  const action = findAction('weft.deleteRemoteBranch');

  // A symbolic alias for whichever branch the server calls default. There is no ref of that name
  // to delete, and asking git to would either fail or take the wrong one.
  assert.match(action?.unavailable(remoteRef('origin/HEAD'), state) ?? '', /symbolic alias/);
  assert.match(action?.unavailable(remoteRef('nowhere/main'), state) ?? '', /known remote/);
  assert.equal(action?.unavailable(remoteRef('origin/doomed'), state), null);
});

test('deleting on a remote is offered for remote branches and nothing else', async () => {
  const { dir } = makeServed();
  const repo = await open(dir);
  const state = await readRepoState(git, repo);

  const onRemote = buildMenu(remoteRef('origin/doomed'), state);
  const onLocal = buildMenu(branch('feature'), state);

  assert.ok(onRemote.some((item) => item.id === 'weft.deleteRemoteBranch'));
  assert.ok(!onRemote.some((item) => item.id === 'weft.deleteBranch'));

  // And the local one is never a push: the two are separate actions so that the word Delete keeps
  // meaning one thing in each place it appears.
  assert.ok(!onLocal.some((item) => item.id === 'weft.deleteRemoteBranch'));
});

test('merging asks how only when a fast-forward is actually possible', async () => {
  const behind = makeBehind();
  const asked = fakeUi({ choices: ['Fast-forward'] });
  await run(behind, 'weft.merge', branch('feature'), asked);

  assert.equal(asked.questions.length, 1, 'a branch that is strictly behind has a real choice');
  assert.match(asked.questions[0] ?? '', /behind feature/);

  const diverged = makeDiverged();
  const notAsked = fakeUi();
  await run(diverged, 'weft.merge', branch('feature'), notAsked);

  // Offering "fast-forward or merge commit" when only one of them is possible is a choice of one.
  assert.deepEqual(notAsked.questions, [], 'diverged histories have nothing to choose');
  assert.equal(parentCount(diverged), 2);
});

test('fast-forward moves the branch and records nothing', async () => {
  const dir = makeBehind();
  const result = await run(dir, 'weft.merge', branch('feature'), fakeUi({ choices: ['Fast-forward'] }));

  assert.equal(result.ran, true);
  assert.equal(parentCount(dir), 1, 'a fast-forward is not a merge commit');
  assert.equal(
    sh(dir, 'rev-parse', 'main').trim(),
    sh(dir, 'rev-parse', 'feature').trim(),
    'main should now be exactly where feature is',
  );
});

test('choosing a merge commit records one even though it could have fast-forwarded', async () => {
  const dir = makeBehind();
  const result = await run(dir, 'weft.merge', branch('feature'), fakeUi({ choices: ['Merge commit'] }));

  assert.equal(result.ran, true);
  assert.equal(parentCount(dir), 2, 'the fork should still be in the history');
  assert.match(result.message, /with a merge commit/);
  assert.notEqual(sh(dir, 'rev-parse', 'main').trim(), sh(dir, 'rev-parse', 'feature').trim());
});

test('backing out of the merge question merges nothing', async () => {
  const dir = makeBehind();
  const before = sh(dir, 'rev-parse', 'main').trim();
  const result = await run(dir, 'weft.merge', branch('feature'), fakeUi({ choices: [] }));

  assert.equal(result.ran, false);
  assert.equal(sh(dir, 'rev-parse', 'main').trim(), before);
});

test('squashing stages the changes and commits nothing', async () => {
  const dir = makeDiverged();
  const before = sh(dir, 'rev-parse', 'HEAD').trim();
  const result = await run(dir, 'weft.mergeSquash', branch('feature'), fakeUi());

  assert.equal(result.ran, true);
  assert.equal(sh(dir, 'rev-parse', 'HEAD').trim(), before, 'HEAD must not move');
  assert.match(sh(dir, 'status', '--porcelain'), /^A\s+b\.txt/m, 'the changes should be staged');
  assert.ok(existsSync(join(dir, '.git', 'SQUASH_MSG')), 'git should have prepared a message');
  assert.match(result.message, /Commit them in Source Control/);
});

test('the squash confirmation says the branch will still look unmerged', async () => {
  const dir = makeDiverged();
  const ui = fakeUi();
  await run(dir, 'weft.mergeSquash', branch('feature'), ui);

  // The consequence people are surprised by afterwards, said beforehand.
  assert.match(ui.confirmations[0] ?? '', /will still consider feature\s+unmerged/);
  assert.match(ui.confirmations[0] ?? '', /Nothing is committed/);

  // And it is true: git does not count a squashed branch as merged.
  assert.doesNotMatch(sh(dir, 'branch', '--merged', 'main'), /feature/);
});

test('a staged squash is an operation, and abandoning it cleans up after itself', async () => {
  const dir = makeDiverged();
  await run(dir, 'weft.mergeSquash', branch('feature'), fakeUi());

  const repo = await open(dir);
  const during = await readRepoState(git, repo);

  // Without this the repository sits with staged changes and no banner saying why, and `git merge
  // --abort` refuses it - the state Weft would have put the user into with no way out on offer.
  assert.equal(during.operation, Operation.Squash);
  assert.equal(describeOperation(during.operation), 'a squash merge');

  const result = await run(dir, 'weft.abortOperation', { kind: 'repo' }, fakeUi());

  assert.equal(result.ran, true);
  assert.equal(sh(dir, 'status', '--porcelain').trim(), '', 'nothing staged, nothing changed');
  assert.equal(existsSync(join(dir, '.git', 'SQUASH_MSG')), false);

  const after = await readRepoState(git, await open(dir));
  assert.equal(after.operation, Operation.None);
});

test('continue is not offered for a squash, and says where the commit box is', async () => {
  const dir = makeDiverged();
  await run(dir, 'weft.mergeSquash', branch('feature'), fakeUi());

  const state = await readRepoState(git, await open(dir));
  const menu = buildMenu({ kind: 'repo' }, state);

  assert.match(
    menu.find((item) => item.id === 'weft.continueOperation')?.disabledReason ?? '',
    /Source Control/,
  );
  assert.equal(menu.find((item) => item.id === 'weft.abortOperation')?.disabledReason, null);
});

test('squashing refuses while something else is staged', async () => {
  const dir = makeDiverged();
  writeFileSync(join(dir, 'unrelated.txt'), 'mine\n');
  sh(dir, 'add', 'unrelated.txt');

  const repo = await open(dir);
  const state = await readRepoState(git, repo);
  const action = findAction('weft.mergeSquash');

  // A squash lands in the index; anything already there would ride along into a commit whose
  // message is about the branch.
  assert.match(action?.unavailable(branch('feature'), state) ?? '', /already staged/);
});

test("a stash's menu does not offer a branch at the commit that holds it", async () => {
  const repo = await open(makeRepo());
  const state = await readRepoState(git, repo);
  const offers = (target: Target) => buildMenu(target, state).some((item) => item.id === 'weft.createBranch');

  assert.equal(offers(stashTarget('stash@{0}', '0'.repeat(40))), false);

  // Still offered where it means something.
  assert.equal(offers(branch('main')), true);
  assert.equal(offers(commit(state.head!)), true);
});

test('deleting a branch counts what it would strand once, and shows that it is counting', async () => {
  const dir = makeRepo();
  const repo = await open(dir);
  const ran: string[][] = [];
  const counting = new Git({ onCommand: (entry) => ran.push([...entry.args]) });
  const state = await readRepoState(counting, repo);
  const titles: string[] = [];
  const ui: ActionUi = {
    ...fakeUi(),
    progress: async <T>(title: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      titles.push(title);
      return work(new AbortController().signal);
    },
  };

  const action = findAction('weft.deleteBranch');
  assert.notEqual(action, undefined);

  const context = { git: counting, repo, state, target: branch('feature'), ui };
  assert.equal(await confirmIfNeeded(action!, context), true);
  const result = await action!.run(context);

  const counts = ran.filter((args) => args[0] === 'rev-list' && args.includes('--count'));

  assert.equal(result.ran, true);
  assert.equal(counts.length, 1, 'the confirmation and the delete asked the same question twice');
  assert.ok(titles.some((title) => title.startsWith('Counting')), `nothing on screen while counting: ${JSON.stringify(titles)}`);
  assert.equal(sh(dir, 'branch', '--list', 'feature').trim(), '');
});

test('blame of one line asks about that line alone, and a stopped blame is not an empty one', async () => {
  const dir = makeRepo();
  const repo = await open(dir);

  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  sh(dir, 'commit', '-qam', 'second line');

  const second = await blameFile(git, repo, join(dir, 'a.txt'), undefined, { line: 1 });

  assert.equal(second[1]?.summary, 'second line');
  assert.equal(second[0], undefined, 'nothing but the line asked about');

  const stopped = new AbortController();
  stopped.abort();

  await assert.rejects(blameFile(git, repo, join(dir, 'a.txt'), undefined, { line: 0, signal: stopped.signal }));
});

test('a comparison lists the commits only on each side, newest first and no more than asked', async () => {
  const dir = makeRepo();
  const repo = await open(dir);

  sh(dir, 'checkout', '-q', 'feature');
  writeFileSync(join(dir, 'c.txt'), 'three\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'third');
  sh(dir, 'checkout', '-q', 'main');

  const main = sh(dir, 'rev-parse', 'main').trim();
  const feature = sh(dir, 'rev-parse', 'feature').trim();
  const all = await compareCommits(git, repo, main, feature);
  const one = await compareCommits(git, repo, main, feature, undefined, 1);

  assert.equal(all.onlyTo, 2);
  assert.deepEqual(all.onlyToCommits.map((commit) => commit.subject), ['third', 'second']);
  assert.equal(all.onlyFromCommits.length, 0);
  assert.ok(all.onlyToCommits.every((commit) => commit.sha.length === 40 && commit.author === 'Weft Test' && commit.date > 0));

  // The count still says two; the list stops where it was told to, at the newest.
  assert.equal(one.onlyTo, 2);
  assert.deepEqual(one.onlyToCommits.map((commit) => commit.subject), ['third']);
});

test('cleaning up deletes the merged branches picked, and logs every tip before it does', async () => {
  const dir = makeRepo();
  sh(dir, 'branch', 'done_one', 'main');
  sh(dir, 'branch', 'done_two', 'main');
  sh(dir, 'branch', 'release/keep', 'main');
  const tip = sh(dir, 'rev-parse', 'done_one').trim();

  const ui = fakeUi({ picks: [['done_one', 'done_two']] });
  const result = await run(dir, 'weft.cleanUpBranches', { kind: 'repo' }, ui);
  const offered = ui.picked[0]?.items ?? [];

  assert.deepEqual(offered.filter((item) => item.picked).map((item) => item.label).sort(), ['done_one', 'done_two']);
  assert.ok(!offered.some((item) => ['release/keep', 'main', 'feature'].includes(item.label)), JSON.stringify(offered));
  assert.equal(result.ran, true);
  assert.equal(sh(dir, 'branch', '--list', 'done_one', 'done_two').trim(), '');
  assert.match(sh(dir, 'branch', '--list', 'release/keep'), /release\/keep/);
  assert.ok(ui.logged.some((line) => line.includes('done_one') && line.includes(tip)), 'the tip is in the log');
  assert.match(ui.confirmations[0] ?? '', /done_one/);
});

test('a branch whose upstream is gone is offered unticked, and goes only by a choice of its own', async () => {
  const dir = makeRepo();
  const remote = mkdtempSync(join(tmpdir(), 'weft-cleanup-remote-')).split('\\').join('/');
  made.push(remote);

  sh(remote, 'init', '-q', '--bare');
  sh(dir, 'remote', 'add', 'origin', remote);
  sh(dir, 'push', '-q', '-u', 'origin', 'feature');
  sh(dir, 'push', '-q', 'origin', '--delete', 'feature');
  sh(dir, 'fetch', '-q', '--prune', 'origin');

  // Ticked, then "merged only": the unmerged one stays where it is.
  const kept = fakeUi({ picks: [['feature']], choices: ['Merged Only'] });
  const first = await run(dir, 'weft.cleanUpBranches', { kind: 'repo' }, kept);
  const offered = kept.picked[0]?.items.find((item) => item.label === 'feature');

  assert.equal(offered?.picked, false, 'offered, and not ticked');
  assert.match(offered?.description ?? '', /upstream gone, 1 commit only here/);
  assert.equal(first.ran, false);
  assert.match(sh(dir, 'branch', '--list', 'feature'), /feature/);

  // Ticked, then "delete them too": now it goes, and its tip is in the log.
  const tip = sh(dir, 'rev-parse', 'feature').trim();
  const gone = fakeUi({ picks: [['feature']], choices: ['Delete Them Too'] });
  const second = await run(dir, 'weft.cleanUpBranches', { kind: 'repo' }, gone);

  assert.equal(second.ran, true);
  assert.equal(sh(dir, 'branch', '--list', 'feature').trim(), '');
  assert.ok(gone.logged.some((line) => line.includes(tip)));
});

test('open on the web: a GitLab only Git Credential Manager names, a commit the remote lacks, branches pushed by hand', async () => {
  const dir = makeRepo();
  sh(dir, 'remote', 'add', 'origin', 'http://10.20.30.40/erp/dlp.git');
  sh(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
  sh(dir, 'config', 'credential.http://10.20.30.40.provider', 'gitlab');

  const repo = await open(dir);
  const state = await readRepoState(git, repo);
  const action = findAction('weft.openOnWeb');
  assert.notEqual(action, undefined);

  const main = sh(dir, 'rev-parse', 'main').trim();
  const feature = sh(dir, 'rev-parse', 'feature').trim();
  const ui = fakeUi({ confirm: false });
  const run = (target: Target) => action?.run({ git, repo, state, target, ui });

  await run({ kind: 'commit', sha: main, subject: 'first' });
  assert.deepEqual(ui.opened, [`http://10.20.30.40/erp/dlp/-/commit/${main}`], 'in the remote\'s own scheme');
  assert.equal(ui.confirmations.length, 0, 'a commit origin has opens without a question');

  await run({ kind: 'commit', sha: feature, subject: 'second' });
  assert.equal(ui.confirmations.length, 1, 'a commit origin has not been seen to have is asked about');
  assert.equal(ui.opened.length, 1, 'and not opened when the answer is no');

  // Pushed by hand, no upstream set: origin's branch of the same name is the one it was pushed as.
  sh(dir, 'update-ref', 'refs/remotes/origin/feature', 'feature');
  await run(branch('feature'));
  assert.equal(ui.opened.at(-1), 'http://10.20.30.40/erp/dlp/-/tree/feature');

  sh(dir, 'update-ref', 'refs/remotes/origin/release/v1.3', 'main');
  await run({ kind: 'ref', refName: 'refs/remotes/origin/release/v1.3', label: 'origin/release/v1.3', refKind: 'remote' });
  assert.equal(ui.opened.at(-1), 'http://10.20.30.40/erp/dlp/-/tree/release/v1.3');

  sh(dir, 'branch', 'Dev_ACR080VN_ERP-10147', 'main');
  const unpushed = await run(branch('Dev_ACR080VN_ERP-10147'));
  assert.equal(unpushed?.refused, true, 'a branch no remote has is refused, not guessed at');
  assert.match(unpushed?.message ?? '', /No remote has Dev_ACR080VN_ERP-10147 yet/);
  assert.equal(ui.opened.length, 3);

  // Told nothing, it refuses and names the setting; named there, it opens.
  sh(dir, 'config', 'credential.http://10.20.30.40.provider', 'generic');
  const unknown = await run({ kind: 'commit', sha: main, subject: 'first' });
  assert.equal(unknown?.refused, true);
  assert.match(unknown?.message ?? '', /weft\.remoteHosts/);

  const told = fakeUi({ remoteHosts: { '10.20.30.40': 'gitea' } });
  await action?.run({ git, repo, state, target: { kind: 'commit', sha: main, subject: 'first' }, ui: told });
  assert.deepEqual(told.opened, [`http://10.20.30.40/erp/dlp/commit/${main}`]);

  // And with no remote at all, the menu says so before anything is asked.
  const alone = await open(makeRepo());
  const entry = buildMenu({ kind: 'commit', sha: main, subject: 'first' }, await readRepoState(git, alone)).find(
    (item) => item.id === 'weft.openOnWeb',
  );
  assert.equal(entry?.disabledReason, 'No remote to open it on');
});

test('an interactive rebase opens the list, waits for it, and replays what the list says', async () => {
  assert.deepEqual(interactiveRebaseArgs('abc1234'), ['rebase', '-i', 'abc1234']);
  assert.deepEqual(interactiveRebaseEnv(), { GIT_SEQUENCE_EDITOR: 'code --wait', GIT_EDITOR: 'code --wait' });

  const dir = makeRepo();

  // Two commits on feature, so a list that keeps one line is a rebase that replays one of them.
  sh(dir, 'checkout', '-q', 'feature');
  writeFileSync(join(dir, 'd.txt'), 'three\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'third');

  const editor = fakeEditor('keep one');
  const ui = fakeUi();

  await withEditor(editor, () => run(dir, 'weft.rebaseInteractive', branch('main'), ui));

  assert.match(ui.confirmations[0] ?? '', /2 commits on feature will be rewritten/);
  assert.match(readFileSync(editor.called, 'utf8'), /git-rebase-todo/, 'the list was handed to an editor');
  assert.deepEqual(
    sh(dir, 'log', '--format=%s', 'main..HEAD').trim().split('\n'),
    ['second'],
    'and only the line the editor left behind was replayed',
  );
  assert.equal(sh(dir, 'status', '--porcelain').trim(), '', 'the rebase finished rather than stopping');
});

test('a reword in the list stops at the message editor, which is the other one git is given', async () => {
  const dir = makeRepo();

  sh(dir, 'checkout', '-q', 'feature');

  const editor = fakeEditor('reword the first');

  await withEditor(editor, () => run(dir, 'weft.rebaseInteractive', branch('main')));

  // Both editors ran: the list, and then the message the reword stopped at.
  assert.equal(readFileSync(editor.called, 'utf8').trim().split('\n').length, 2);
  assert.equal(sh(dir, 'log', '-1', '--format=%s', 'feature').trim(), 'reworded by the editor');
});
