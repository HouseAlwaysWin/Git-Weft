/**
 * Branches, tags and stashes: making them, moving them, and refusing to.
 *
 * One of the files `test/write.test.ts` was split into - see `writeSupport.ts` for why, and for
 * everything they have in common.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMenu, findAction } from '../src/actions/registry.ts';
import type { ActionUi } from '../src/actions/registry.ts';
import { HistoryLoader } from '../src/git/history.ts';
import { readRepoState } from '../src/git/repoState.ts';
import { listStashes } from '../src/git/stash.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { branch, commit, fakeUi, git, makeRepo, makeRepoWithStashes, open, run, sh, stashTarget, walk } from './writeSupport.ts';

test('creating a branch makes it and checks it out', async () => {
  const dir = makeRepo();
  const head = sh(dir, 'rev-parse', 'HEAD').trim();

  await run(dir, 'weft.createBranch', commit(head), fakeUi({ inputs: ['topic/new-thing'] }));

  assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'topic/new-thing');
  assert.equal(sh(dir, 'rev-parse', 'topic/new-thing').trim(), head);
});

test('a branch name git would reject never reaches git', async () => {
  const dir = makeRepo();
  const head = sh(dir, 'rev-parse', 'HEAD').trim();
  const ui = fakeUi({ inputs: [] });
  const repo = await open(dir);
  const state = await readRepoState(git, repo);

  // The action asks; the fake declines. Nothing should have been created either way.
  await findAction('weft.createBranch')?.run({ git, repo, state, target: commit(head), ui });
  assert.equal(sh(dir, 'branch', '--list', '--format=%(refname:short)').trim().split('\n').sort().join(','), 'feature,main');

  // And the validator the action supplies rejects what git rejects.
  const captured: Array<(v: string) => string | null> = [];
  const capturingUi: ActionUi = {
    ...fakeUi(),
    input: async (request) => {
      if (request.validate !== undefined) {
        captured.push(request.validate);
      }
      return null;
    },
  };

  await findAction('weft.createBranch')?.run({ git, repo, state, target: commit(head), ui: capturingUi });

  const validate = captured[0];
  assert.notEqual(validate, undefined);
  assert.equal(validate?.('main'), 'main already exists');
  assert.match(validate?.('has space') ?? '', /Not allowed/);
  assert.match(validate?.('bad..name') ?? '', /Not allowed/);
  assert.match(validate?.('ends.lock') ?? '', /end with .lock/);
  assert.equal(validate?.('perfectly/fine'), null);
  // 'feature' already exists, so it cannot also be a folder holding 'feature/x'.
  assert.match(validate?.('feature/x') ?? '', /Conflicts with feature/);
});

test('renaming a branch moves the name and keeps the commit', async () => {
  const dir = makeRepo();
  const before = sh(dir, 'rev-parse', 'feature').trim();

  await run(dir, 'weft.renameBranch', branch('feature'), fakeUi({ inputs: ['feature-renamed'] }));

  assert.equal(sh(dir, 'rev-parse', 'feature-renamed').trim(), before);
  assert.equal(sh(dir, 'branch', '--list', 'feature').trim(), '');
});

test('deleting a merged branch says nothing is lost, and deletes it', async () => {
  const dir = makeRepo();
  sh(dir, 'merge', '--no-edit', '-q', 'feature');

  const ui = fakeUi();
  const result = await run(dir, 'weft.deleteBranch', branch('feature'), ui);

  assert.equal(result.ran, true);
  assert.match(ui.confirmations[0] ?? '', /reachable from somewhere else/);
  assert.equal(sh(dir, 'branch', '--list', 'feature').trim(), '');
});

test('deleting an unmerged branch counts the commits it would strand', async () => {
  const dir = makeRepo();
  const ui = fakeUi();

  const result = await run(dir, 'weft.deleteBranch', branch('feature'), ui);

  // `feature` is one commit ahead of main and nowhere else, so exactly one commit is at stake.
  assert.match(ui.confirmations[0] ?? '', /^1 commit is on this branch and nowhere else/);
  assert.match(ui.confirmations[0] ?? '', /reflog/);
  assert.equal(result.ran, true);
  assert.equal(sh(dir, 'branch', '--list', 'feature').trim(), '');
});

test('declining the confirmation leaves the branch alone', async () => {
  const dir = makeRepo();

  const result = await run(dir, 'weft.deleteBranch', branch('feature'), fakeUi({ confirm: false }));

  assert.equal(result.ran, false);
  assert.match(sh(dir, 'branch', '--list', 'feature'), /feature/);
});

test('the branch you are standing on is not offered for deletion', async () => {
  const repo = await open(makeRepo());
  const state = await readRepoState(git, repo);
  const item = buildMenu(branch('main'), state).find((i) => i.id === 'weft.deleteBranch');

  assert.equal(item?.disabledReason, 'Currently checked out');
});

test('an empty tag message makes a lightweight tag, a message makes an annotated one', async () => {
  const dir = makeRepo();
  const head = sh(dir, 'rev-parse', 'HEAD').trim();

  await run(dir, 'weft.createTag', commit(head), fakeUi({ inputs: ['v1.0', ''] }));
  await run(dir, 'weft.createTag', commit(head), fakeUi({ inputs: ['v2.0', 'the second one'] }));

  assert.equal(sh(dir, 'cat-file', '-t', 'v1.0').trim(), 'commit', 'lightweight tags point straight at the commit');
  assert.equal(sh(dir, 'cat-file', '-t', 'v2.0').trim(), 'tag', 'annotated tags are their own object');
  assert.match(sh(dir, 'tag', '-n', '--list', 'v2.0'), /the second one/);
});

test('checking out a commit detaches HEAD and says how to get back', async () => {
  const dir = makeRepo();
  const first = sh(dir, 'rev-list', '--max-parents=0', 'HEAD').trim();

  const result = await run(dir, 'weft.checkoutCommit', commit(first));

  assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'HEAD', 'detached HEAD has no branch name');
  assert.equal(sh(dir, 'rev-parse', 'HEAD').trim(), first);
  assert.match(result.message, /detached/);
  assert.match(result.message, /git checkout main/);
});

test('stashes are listed newest first, with their positions', async () => {
  const repo = await open(makeRepoWithStashes());
  const stashes = await listStashes(git, repo);

  assert.equal(stashes.length, 2);
  assert.equal(stashes[0]?.name, 'stash@{0}');
  assert.match(stashes[0]?.message ?? '', /newer/);
  assert.match(stashes[1]?.message ?? '', /older/);
});

test('a stash is drawn with one parent, not the two or three git records', async () => {
  const dir = makeRepoWithStashes();
  const repo = await open(dir);
  const stashes = await listStashes(git, repo);
  const top = stashes[0];

  assert.notEqual(top, undefined);

  // git really does record more than one parent - that is what is being folded away.
  const rawParents = sh(dir, 'rev-list', '--parents', '-n', '1', top!.sha).trim().split(' ').slice(1);
  assert.equal(rawParents.length >= 2, true, 'a stash commit has an index parent as well as HEAD');

  const loader = new HistoryLoader(git, repo);
  const seen: string[][] = [];

  await loader.load(
    (page) => {
      for (const c of page.commits) {
        if (c.sha === top!.sha) {
          seen.push(c.parents);
        }
      }
    },
    { stashes: new Map(stashes.map((s) => [s.sha, s.name])) },
  );

  assert.deepEqual(seen.length, 1, 'the stash should appear in the walk exactly once');
  assert.deepEqual(seen[0]?.length, 1, 'only the commit HEAD was on is history');
  assert.equal(seen[0]?.[0], rawParents[0]);
});

test('applying a stash restores the change and leaves the entry in place', async () => {
  const dir = makeRepoWithStashes();
  const repo = await open(dir);
  const top = (await listStashes(git, repo))[0]!;

  const result = await run(dir, 'weft.stashApply', stashTarget(top.name, top.sha));

  assert.equal(result.ran, true);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'second change\n');
  assert.equal((await listStashes(git, repo)).length, 2, 'apply keeps the stash');
});

test('popping a stash restores the change and removes the entry', async () => {
  const dir = makeRepoWithStashes();
  const repo = await open(dir);
  const top = (await listStashes(git, repo))[0]!;

  await run(dir, 'weft.stashPop', stashTarget(top.name, top.sha));

  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'second change\n');
  assert.equal((await listStashes(git, repo)).length, 1, 'pop drops the stash it applied');
});

test('dropping a stash hands over the sha it can be recovered from', async () => {
  const dir = makeRepoWithStashes();
  const repo = await open(dir);
  const top = (await listStashes(git, repo))[0]!;
  const ui = fakeUi();

  await run(dir, 'weft.stashDrop', stashTarget(top.name, top.sha, 'WIP on main'), ui);

  assert.match(ui.confirmations[0] ?? '', new RegExp(`git stash apply ${top.sha}`));
  assert.equal((await listStashes(git, repo)).length, 1);

  // The claim in that confirmation has to be true, not just reassuring.
  sh(dir, 'stash', 'apply', top.sha);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'second change\n');
});

test('a stash position that has shifted underneath us is refused, not acted on', async () => {
  const dir = makeRepoWithStashes();
  const repo = await open(dir);
  const before = await listStashes(git, repo);
  const stale = before[0]!;

  // Someone else drops the top stash: stash@{1} slides into stash@{0}, and a menu built a moment
  // ago now names the wrong thing.
  sh(dir, 'stash', 'drop', 'stash@{0}');

  const result = await run(dir, 'weft.stashDrop', stashTarget('stash@{0}', stale.sha));

  assert.equal(result.ran, false);
  assert.match(result.message, /different stash|no longer exists/);
  assert.equal((await listStashes(git, repo)).length, 1, 'the surviving stash must still be there');
});

test('stashing is not offered when there is nothing to stash', async () => {
  const repo = await open(makeRepo());
  const state = await readRepoState(git, repo);
  const clean = buildMenu({ kind: 'repo' }, state).find((i) => i.id === 'weft.stashPush');

  assert.equal(clean?.disabledReason, 'Nothing to stash');
});

test('unticking every ref shows an empty graph, not the whole history', async () => {
  // `git log` with no revision argument means HEAD, so "walk nothing" has to be handled before git
  // is ever spawned - otherwise the filter silently shows everything.
  const repo = await open(makeRepo());
  const loader = new HistoryLoader(git, repo);
  let delivered = 0;
  let finished = false;

  await loader.load(
    (page) => {
      delivered += page.commits.length;
      finished ||= page.done;
    },
    { refs: [] },
  );

  assert.equal(delivered, 0, 'no refs visible means no commits');
  assert.equal(finished, true, 'the view still needs to be told the load finished');
  assert.equal(loader.rowCount, 0);
});

test('a ref list that is absent still means everything', async () => {
  const repo = await open(makeRepo());
  const loader = new HistoryLoader(git, repo);
  let delivered = 0;

  await loader.load((page) => (delivered += page.commits.length), {});

  assert.equal(delivered, 2, 'main and feature between them have two commits');
});
