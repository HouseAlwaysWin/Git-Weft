/**
 * Write actions, against real repositories.
 *
 * These assert on **git's state afterwards** - where HEAD points, what `status` says - rather than
 * on anything the UI did. A write action that draws the right thing and does the wrong thing is the
 * failure mode worth spending a test on.
 *
 * Every destructive path gets a test that it *refuses*, not just one that it works. "It does the
 * thing" is the easy half.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import { Git, GitError, GitTimeoutError } from '../src/git/exec.ts';
import { discover } from '../src/git/discovery.ts';
import type { RepoInfo } from '../src/git/discovery.ts';
import {
  Operation,
  describeOperation,
  parseBranchHeader,
  parseStatus,
  readOperation,
  readRepoState,
  workAtRisk,
} from '../src/git/repoState.ts';
import { Remedy, mapGitError } from '../src/git/errors.ts';
import type { Author } from '../src/git/authors.ts';
import { groupAuthors, listAuthors, readGroupAssignments } from '../src/git/authors.ts';
import { blameFile } from '../src/git/blame.ts';
import type { ActionUi, Target } from '../src/actions/registry.ts';
import { buildMenu, confirmIfNeeded, findAction } from '../src/actions/registry.ts';
import { RepoLock } from '../src/git/lock.ts';
import { listStashes } from '../src/git/stash.ts';
import { nameProblem, readRemotes } from '../src/git/remotes.ts';
import { HistoryLoader } from '../src/git/history.ts';

const git = new Git({});
const made: string[] = [];

function sh(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** A repository with `main`, a `feature` branch one commit ahead, and a clean tree. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-write-')).split('\\').join('/');
  made.push(dir);

  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Weft Test');
  sh(dir, 'config', 'user.email', 'test@example.invalid');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  sh(dir, 'config', 'core.autocrlf', 'false');

  writeFileSync(join(dir, 'a.txt'), 'one\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'first');

  sh(dir, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'b.txt'), 'two\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'second');
  sh(dir, 'checkout', '-q', 'main');

  return dir;
}

async function open(dir: string): Promise<RepoInfo> {
  const repo = await discover(git, dir);
  assert.notEqual(repo, null, 'fixture should be a repository');
  return repo as RepoInfo;
}

/**
 * Records what it was asked and answers however the test says.
 *
 * `inputs` are handed out in order, so a test can script a whole prompt sequence; running out
 * answers null, which every action treats as a cancel.
 */
function fakeUi(
  options: {
    confirm?: boolean;
    inputs?: string[];
    /** Answers for `choose`, in order. Running out answers null, which is a cancel. */
    choices?: string[];
    /** Runs while the confirmation is "open" - for testing what a race actually does. */
    whileConfirming?: () => void;
  } = {},
): ActionUi & { confirmations: string[]; prompts: string[]; questions: string[] } {
  const confirmations: string[] = [];
  const prompts: string[] = [];
  const questions: string[] = [];
  const inputs = [...(options.inputs ?? [])];
  const choices = [...(options.choices ?? [])];

  return {
    confirmations,
    prompts,
    questions,
    choose: async (request) => {
      questions.push(request.title);
      return choices.shift() ?? null;
    },
    confirm: async (request) => {
      confirmations.push(request.detail);
      options.whileConfirming?.();
      return options.confirm ?? true;
    },
    input: async (request) => {
      prompts.push(request.title);
      const next = inputs.shift();

      if (next === undefined) {
        return null;
      }

      const rejection = request.validate?.(next) ?? null;
      assert.equal(rejection, null, `the test supplied a value the action rejects: ${rejection}`);
      return next;
    },
    progress: async (_title, work) => work(new AbortController().signal),
    notify: () => undefined,
  };
}

const branch = (label: string): Target => ({
  kind: 'ref',
  refName: `refs/heads/${label}`,
  label,
  refKind: 'local',
});

test.after(() => {
  for (const dir of made) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
});

test('an unrecognised failure keeps git own words rather than inventing vaguer ones', () => {
  const mapped = mapGitError(new GitError(['push'], 1, 'fatal: something entirely new happened\n'));

  assert.equal(mapped.message, 'something entirely new happened');
  assert.ok(mapped.remedies.includes(Remedy.ShowLog));
});

/** Commit as somebody in particular, without touching the repository's configured identity. */
function commitAs(dir: string, name: string, email: string, file: string): void {
  writeFileSync(join(dir, file), `${file}\n`);
  sh(dir, 'add', '-A');
  sh(dir, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', file);
}

/*
 * The author list is one row per name, and that is not what `shortlog` hands over.
 *
 * Without a .mailmap - which almost no repository has - one person committing from a laptop and a
 * build box is two of its lines. Two rows for one name tick as one, because the tick is
 * `--author=<name>`, so leaving them apart showed a number that no click could ever produce.
 */
test('one row per name, however many addresses that name has committed from', async () => {
  const dir = makeRepo();

  commitAs(dir, 'jiaying_wu', 'jia@laptop.invalid', 'one.txt');
  commitAs(dir, 'jiaying_wu', 'jia@build.invalid', 'two.txt');
  commitAs(dir, 'jiaying_wu', 'jia@build.invalid', 'three.txt');

  const listed = groupAuthors(await listAuthors(git, await open(dir)));
  const jia = listed.filter((author) => author.name === 'jiaying_wu');

  assert.equal(jia.length, 1, 'one row, not one per address');
  assert.equal(jia[0]?.commits, 3, 'and the count is all of them together');
  assert.deepEqual(
    [...(jia[0]?.emails ?? [])].sort(),
    ['jia@build.invalid', 'jia@laptop.invalid'],
    'both addresses are kept, so the row can say why the number is what it is',
  );
  assert.deepEqual(
    jia[0]?.members.map((member) => member.name),
    ['jiaying_wu'],
    'one spelling, so one name to filter by',
  );
});

/*
 * The same person having configured git on three machines is not three people, and it is the most
 * common way a contributor list grows duplicates. Every spelling is kept, because a tick has to
 * name them all: `--author` is case-sensitive, so the row's count and what the graph walks would
 * otherwise part company.
 */
test('spellings that differ only in case or separators are one person, and all are kept', async () => {
  const dir = makeRepo();

  commitAs(dir, 'sean_lin', 'sean@example.invalid', 'lower.txt');
  commitAs(dir, 'Sean Lin', 'sean@work.invalid', 'spaced1.txt');
  commitAs(dir, 'Sean Lin', 'sean@work.invalid', 'spaced2.txt');
  commitAs(dir, 'SEAN_LIN', 'sean@example.invalid', 'shouty.txt');

  const sean = (groupAuthors(await listAuthors(git, await open(dir)))).filter(
    (author) => author.name.toLowerCase().replace('_', ' ') === 'sean lin',
  );

  assert.equal(sean.length, 1, 'one row, not one per spelling');
  assert.equal(sean[0]?.commits, 4);
  assert.equal(sean[0]?.name, 'Sean Lin', 'shown as whichever spelling has the most behind it');
  assert.deepEqual(
    (sean[0]?.members ?? []).map((member) => member.name).sort(),
    ['SEAN_LIN', 'Sean Lin', 'sean_lin'],
    'all three are kept, or a tick walks a fraction of what the row counted',
  );
  assert.deepEqual([...(sean[0]?.emails ?? [])].sort(), ['sean@example.invalid', 'sean@work.invalid']);
});

/*
 * Where the folding stops. `Lineric` and `lineric_lin` share a prefix and nothing that can be
 * proved, and two people folded into one row is a worse answer than one person shown twice - the
 * count would then be a number no tick could produce. Deciding these is what `.mailmap` is for.
 */
/*
 * Where the rule stops, a hand takes over.
 *
 * The rule folds what it can prove and no further, so the two halves of a person who spells
 * themselves two different ways stay apart until somebody says otherwise. Saying so is an
 * override on one spelling, not a rewrite of the list.
 */
test('a group made by hand joins spellings the rule will not', async () => {
  const dir = makeRepo();

  commitAs(dir, 'Lineric', 'lin@example.invalid', 'short.txt');
  commitAs(dir, 'lineric_lin', 'lin@example.invalid', 'long.txt');

  const identities = await listAuthors(git, await open(dir));
  const custom = new Map([['Lineric', ['Lineric Lin']], ['lineric_lin', ['Lineric Lin']]]);

  const grouped = groupAuthors(identities, custom).filter((author) => author.custom);

  assert.equal(grouped.length, 1, 'one person, not two');
  assert.equal(grouped[0]?.name, 'Lineric Lin', 'and it is called what it was named');
  assert.deepEqual(
    (grouped[0]?.members ?? []).map((member) => member.name).sort(),
    ['Lineric', 'lineric_lin'],
    'with both spellings kept, because --author still needs each of them',
  );
});

test('one person can be in more than one group at a time', async () => {
  /*
   * Somebody is on the platform team and on the release rota, and a list that makes them pick one
   * is not describing the place they work. So a spelling carries as many group names as it needs
   * and is listed under each of them.
   *
   * Which means the counts overlap: both rows count the same commits, because both rows would walk
   * them. The alternative is a row whose number no tick of it would produce.
   */
  const dir = makeRepo();

  commitAs(dir, 'Winni_Lee', 'winni@example.invalid', 'a.txt');
  commitAs(dir, 'Wei_Pan', 'wei@example.invalid', 'b.txt');

  const identities = await listAuthors(git, await open(dir));

  const grouped = groupAuthors(
    identities,
    new Map([
      ['Winni_Lee', ['Platform', 'Release Rota']],
      ['Wei_Pan', ['Platform']],
    ]),
  );

  const platform = grouped.find((author) => author.name === 'Platform');
  const rota = grouped.find((author) => author.name === 'Release Rota');

  assert.deepEqual(
    (platform?.members ?? []).map((member) => member.name).sort(),
    ['Wei_Pan', 'Winni_Lee'],
    'the team has both of them',
  );

  assert.deepEqual(
    (rota?.members ?? []).map((member) => member.name),
    ['Winni_Lee'],
    'and the rota has the one who is on it',
  );

  // Listed where they were put, and nowhere else: an assignment replaces what the rule would have
  // done with a spelling rather than adding to it, or grouping anybody would list them twice.
  assert.equal(
    grouped.filter((author) => author.members.some((member) => member.name === 'Winni_Lee')).length,
    2,
    'in exactly the two groups they were put in',
  );

  assert.equal(
    (platform?.commits ?? 0) + (rota?.commits ?? 0) > (platform?.commits ?? 0),
    true,
    'and both rows count the commits they would walk, overlap included',
  );
});

test('a group named twice over is one group, not two', async () => {
  // The same fold that makes `Sean Lin` and `sean_lin` one person: a group is named by a person,
  // and people do not type a name the same way twice.
  const dir = makeRepo();

  commitAs(dir, 'Gaga_Liu', 'gaga@example.invalid', 'a.txt');
  commitAs(dir, 'Corey_Lai', 'corey@example.invalid', 'b.txt');

  const identities = await listAuthors(git, await open(dir));

  const grouped = groupAuthors(
    identities,
    new Map([
      ['Gaga_Liu', ['Backend']],
      ['Corey_Lai', ['backend']],
    ]),
  );

  const backend = grouped.filter((author) => author.custom);

  assert.equal(backend.length, 1, 'one row, whichever way it was typed');
  assert.equal(backend[0]?.members.length, 2);
});

test('the rule can be told it was wrong about two spellings', async () => {
  /*
   * It folds by case and separators, which is right nine times in ten: `Max_Chiue` and
   * `max_chiue` are one person who configured git on two machines. The tenth time they are two
   * people, and the list had no way of being told - the group the rule made offered nothing but
   * "add to a group", and adding both to one would have said the opposite of what was meant.
   *
   * No groups at all is the third answer, and it is not the same as no assignment: no assignment
   * means "the rule decides", and the rule is exactly what is being overruled.
   */
  const dir = makeRepo();

  commitAs(dir, 'Max_Chiue', 'max@example.invalid', 'upper.txt');
  commitAs(dir, 'max_chiue', 'max@example.invalid', 'lower.txt');

  const identities = await listAuthors(git, await open(dir));
  const named = (list: readonly Author[]): Author[] =>
    list.filter((one) => one.name.toLowerCase() === 'max_chiue');

  assert.equal(named(groupAuthors(identities)).length, 1, 'the rule folds them to begin with');

  const apart = groupAuthors(
    identities,
    new Map<string, string[]>([
      ['Max_Chiue', []],
      ['max_chiue', []],
    ]),
  );

  assert.equal(named(apart).length, 2, 'and comes apart when it is told to');
  assert.deepEqual(named(apart).map((one) => one.members.length), [1, 1]);

  assert.ok(
    named(apart).every((one) => !one.custom),
    'kept apart by hand is not the same as put together by hand, and the row should not say it is',
  );

  // One of the two, for the group of four where three of them really are the same person.
  const one = groupAuthors(identities, new Map<string, string[]>([['max_chiue', []]]));

  assert.equal(named(one).length, 2, 'taking one spelling out leaves the rest folded');

  // And back: an empty entry is an override, and removing an override restores what was underneath.
  assert.equal(named(groupAuthors(identities, new Map())).length, 1);
});

test('the groups remembered by an older version are still read', async () => {
  /*
   * A spelling used to be in one group, and one group was stored as one string. Reading the old
   * shape as if it were the new one gives a group per letter - so it is read as what it is, and
   * nobody loses the grouping they did last week.
   */
  assert.deepEqual(
    [...readGroupAssignments({ Lineric: 'Lineric Lin', lineric_lin: 'Lineric Lin' })],
    [
      ['Lineric', ['Lineric Lin']],
      ['lineric_lin', ['Lineric Lin']],
    ],
  );

  assert.deepEqual(
    [...readGroupAssignments({ Winni_Lee: ['Platform', 'Release Rota'] })],
    [['Winni_Lee', ['Platform', 'Release Rota']]],
  );

  assert.deepEqual([...readGroupAssignments({})], []);
});

test('a group made by hand can take a spelling back out of one the rule made', async () => {
  const dir = makeRepo();

  commitAs(dir, 'Max_Chiue', 'max@example.invalid', 'upper.txt');
  commitAs(dir, 'max_chiue', 'max@example.invalid', 'lower.txt');

  const identities = await listAuthors(git, await open(dir));

  assert.equal(
    groupAuthors(identities).filter((a) => a.name.toLowerCase() === 'max_chiue').length,
    1,
    'the rule puts them together',
  );

  const apart = groupAuthors(identities, new Map([['max_chiue', ['Somebody Else']]]));

  assert.deepEqual(
    apart.filter((a) => a.members.some((m) => m.name.toLowerCase() === 'max_chiue')).map((a) => a.name).sort(),
    ['Max_Chiue', 'Somebody Else'],
    'and naming one of them separately takes it back out',
  );
});

test('names differing by more than case and separators are left alone', async () => {
  const dir = makeRepo();

  commitAs(dir, 'Lineric', 'lin@example.invalid', 'short.txt');
  commitAs(dir, 'lineric_lin', 'lin@example.invalid', 'long.txt');

  const names = (groupAuthors(await listAuthors(git, await open(dir)))).map((author) => author.name);

  assert.ok(names.includes('Lineric'));
  assert.ok(names.includes('lineric_lin'));
});

/*
 * And why the address is not a key. One service account is a dozen people's commits; folding on it
 * would put a dozen names in one row and a number belonging to none of them.
 */
test('a shared address does not merge the people using it', async () => {
  const dir = makeRepo();

  commitAs(dir, 'Deploy Bot', 'admin@example.invalid', 'deployed.txt');
  commitAs(dir, 'Administrator', 'admin@example.invalid', 'administered.txt');

  const names = (groupAuthors(await listAuthors(git, await open(dir)))).map((author) => author.name);

  assert.ok(names.includes('Deploy Bot'));
  assert.ok(names.includes('Administrator'));
});

test('the author list comes back busiest first, after the folding has moved names about', async () => {
  const dir = makeRepo();

  commitAs(dir, 'busy', 'a@example.invalid', 'a1.txt');
  commitAs(dir, 'busy', 'b@example.invalid', 'a2.txt');
  commitAs(dir, 'busy', 'c@example.invalid', 'a3.txt');
  commitAs(dir, 'quiet', 'd@example.invalid', 'b1.txt');

  const counts = (groupAuthors(await listAuthors(git, await open(dir)))).map((author) => author.commits);

  assert.deepEqual(
    counts,
    [...counts].sort((a, b) => b - a),
    'three ones folded into a three has to be sorted again, or it sits where the one sat',
  );
});

/** Every commit one walk produced, so a filter can be measured by what it left. */
async function walk(dir: string, options: Record<string, unknown>): Promise<string[]> {
  const repo = await open(dir);
  const loader = new HistoryLoader(git, repo);
  const subjects: string[] = [];

  await loader.load((page) => {
    for (const c of page.commits) {
      subjects.push(c.subject);
    }
  }, options);

  return subjects;
}

/*
 * "Show me this branch" and "show me what is on this branch" are different questions, and only the
 * second is the one people mean. Ticking a branch narrows where git *starts*: everything merged
 * into it is still reachable, so on a branch cut off a busy trunk it narrows almost nothing.
 */
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

/*
 * The negative side is `--glob=refs/*` and not `--all`, which is the same set plus HEAD - and HEAD
 * is on the branch being asked about, so `--all` there excludes the branch from itself and the
 * answer is always nothing, whichever branch is asked.
 */
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

/*
 * The buffer, not the file. git blames what is on disk, and an editor holding unsaved edits has
 * moved every line below the first change - so the annotation beside line twelve would be about
 * whatever line twelve used to be.
 */
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

/** A repository where the stash was made somewhere the other branch cannot see. */
function makeStashed(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-stash-')).split('\\').join('/');
  made.push(dir);

  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Weft Test');
  sh(dir, 'config', 'user.email', 'test@example.invalid');
  sh(dir, 'config', 'commit.gpgsign', 'false');

  writeFileSync(join(dir, 'a.txt'), 'base\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'base');

  sh(dir, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'f.txt'), 'on the feature\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'only on feature');

  sh(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'm.txt'), 'on main\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'only on main');

  // Made on main, so its parent is a commit `feature` has never seen.
  writeFileSync(join(dir, 'a.txt'), 'edited before stashing\n');
  sh(dir, 'stash', '-q');

  return dir;
}

async function stashMap(dir: string): Promise<Map<string, string>> {
  const stashes = await listStashes(git, await open(dir));
  return new Map(stashes.map((stash) => [stash.sha, stash.name]));
}

/*
 * A stash is a commit, and naming one puts everything it can reach into the walk with it. Left
 * unchecked that undoes the ref filter from the side: ticking one branch produced a graph full of
 * commits from branches that had been unticked, with the stashes sitting at the top of it.
 */
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

const commit = (sha: string): Target => ({ kind: 'commit', sha, subject: 'x' });

async function run(dir: string, id: string, target: Target, ui = fakeUi()) {
  const repo = await open(dir);
  const state = await readRepoState(git, repo);
  const action = findAction(id);

  assert.notEqual(action, undefined, `no such action: ${id}`);

  const context = { git, repo, state, target, ui };
  const allowed = await confirmIfNeeded(action!, context);

  return allowed ? action!.run(context) : { message: '', ran: false };
}

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

const stashTarget = (name: string, sha: string, message = 'WIP'): Target => ({
  kind: 'stash',
  name,
  sha,
  message,
});

/** A repository with two stashes: stash@{0} is the newer one. */
function makeRepoWithStashes(): string {
  const dir = makeRepo();

  writeFileSync(join(dir, 'a.txt'), 'first change\n');
  sh(dir, 'stash', 'push', '-m', 'older');
  writeFileSync(join(dir, 'a.txt'), 'second change\n');
  sh(dir, 'stash', 'push', '-m', 'newer');

  return dir;
}

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

const repoTarget = (): Target => ({ kind: 'repo' });

/** main and conflicting both change b.txt, so merging them cannot succeed. */
function makeConflictingRepo(): string {
  const dir = makeRepo();

  sh(dir, 'checkout', '-q', '-b', 'conflicting', 'main');
  writeFileSync(join(dir, 'b.txt'), 'theirs\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'conflicting change');

  return dir;
}

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

/* ------------------------------------------------------------------ network operations
 *
 * A bare repository on disk is a real remote as far as git is concerned, so every one of these
 * runs end to end - a genuine push, a genuine rejection - with no network, no credentials and
 * nothing external to be flaky. The cases worth having are the refusals: a push that is rejected,
 * and a lease that holds.
 */

/** A repository with a bare `origin` it has already pushed `main` to. */
function makeRepoWithRemote(): { dir: string; remote: string } {
  const dir = makeRepo();
  const remote = mkdtempSync(join(tmpdir(), 'weft-remote-')).split('\\').join('/') + '/origin.git';

  made.push(remote);
  sh(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  sh(dir, 'remote', 'add', 'origin', remote);
  sh(dir, 'push', '-q', '-u', 'origin', 'main');

  return { dir, remote };
}

/** Somebody else's clone of the same remote, for the races that only two people can produce. */
function cloneOf(remote: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-other-')).split('\\').join('/') + '/clone';

  made.push(dir);
  execFileSync('git', ['clone', '-q', remote, dir], { encoding: 'utf8' });
  sh(dir, 'config', 'user.name', 'Someone Else');
  sh(dir, 'config', 'user.email', 'other@example.invalid');
  sh(dir, 'config', 'commit.gpgsign', 'false');

  return dir;
}

function commitIn(dir: string, file: string, text: string, message: string): string {
  writeFileSync(join(dir, file), text);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', message);
  return sh(dir, 'rev-parse', 'HEAD').trim();
}

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

/** Both sides move, which is the case `git pull` refuses to decide on its own. */
function makeDivergence(): { dir: string; remote: string; theirs: string } {
  const { dir, remote } = makeRepoWithRemote();
  const other = cloneOf(remote);
  const theirs = commitIn(other, 'theirs.txt', 'theirs\n', 'from someone else');

  sh(other, 'push', '-q');
  commitIn(dir, 'ours.txt', 'ours\n', 'ours');

  return { dir, remote, theirs };
}

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

  // Accepts the connection and never answers, which is what a hung remote looks like from here.
  // The error handler matters: killing git resets the socket, and an unhandled 'error' on it would
  // fail this test for the very thing it is checking happens.
  const server = createServer((socket) => {
    socket.on('error', () => undefined);
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const started = Date.now();

    await assert.rejects(
      () =>
        git.runNetwork(dir, ['fetch', `git://127.0.0.1:${port}/silent.git`], {
          idleTimeoutMs: 1500,
        }),
      (err: unknown) => {
        assert.ok(err instanceof GitTimeoutError, `expected a timeout, got ${String(err)}`);
        assert.match((err as Error).message, /stopped responding/);
        return true;
      },
    );

    assert.ok(Date.now() - started < 15_000, 'and gives up promptly rather than hanging the host');
  } finally {
    server.close();
  }
});


/*
 * Remotes, against a real one.
 *
 * The remote is a second repository on disk, added by path. Nothing here is mocked: the fetch is a
 * fetch, and what it writes into `refs/remotes/` is what the assertions read back. A remote that is
 * configured correctly and fetches nothing is exactly the failure worth a test.
 */

const REPO: Target = { kind: 'repo' };

/** The names git reports, so an assertion reads what git thinks rather than what the action said. */
function remoteNames(dir: string): string[] {
  return sh(dir, 'remote')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Remote-tracking refs under one remote. */
function tracking(dir: string, name: string): string[] {
  return sh(dir, 'for-each-ref', '--format=%(refname)', `refs/remotes/${name}/`)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

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


/*
 * Deleting a branch on the server.
 *
 * The remote is a bare repository on disk, so the push is a real push and the assertions read the
 * branch list out of the server rather than out of the clone that asked for it to go.
 */

const remoteRef = (label: string): Target => ({
  kind: 'ref',
  refName: `refs/remotes/${label}`,
  label,
  refKind: 'remote',
});

/** A bare repository with `main` and `doomed` on it, and a clone that has fetched both. */
function makeServed(): { dir: string; server: string } {
  const server = mkdtempSync(join(tmpdir(), 'weft-server-')).split('\\').join('/');
  made.push(server);
  sh(server, 'init', '-q', '--bare', '-b', 'main');

  const dir = makeRepo();
  sh(dir, 'checkout', '-q', '-b', 'doomed');
  writeFileSync(join(dir, 'only-here.txt'), 'nowhere else\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'a commit that lives on this branch alone');
  sh(dir, 'checkout', '-q', 'main');

  sh(dir, 'remote', 'add', 'origin', server);
  sh(dir, 'push', '-q', 'origin', 'main', 'doomed');
  sh(dir, 'fetch', '-q', 'origin');

  return { dir, server };
}

function serverBranches(server: string): string[] {
  return sh(server, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

/*
 * Checkout, from the remote side of a branch that also exists locally.
 *
 * The pair `origin/uat` and `uat` sit on the same row of the graph, and right-clicking the remote
 * one is at least as natural as right-clicking the local one. It used to refuse - "local branch
 * already exists" - which is true, is not a problem, and reads like "you are already on it".
 */
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


/*
 * Merging: the question, and the one that declines to merge at all.
 *
 * The assertions are about the shape of the history afterwards - how many parents the new commit
 * has, whether HEAD moved at all - because that is the whole of what these options differ by.
 */

/** How many parents HEAD has. Two means a merge commit; one means it did not record a merge. */
function parentCount(dir: string): number {
  return sh(dir, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(/\s+/).length - 1;
}

/** `main` strictly behind `feature`, so a fast-forward is on the table. */
function makeBehind(): string {
  const dir = makeRepo();
  sh(dir, 'checkout', '-q', 'main');
  sh(dir, 'merge', '-q', '--ff-only', 'feature');
  sh(dir, 'reset', '-q', '--hard', 'HEAD~1');
  return dir;
}

/** Both branches moved, so a merge commit is the only thing a merge can produce. */
function makeDiverged(): string {
  const dir = makeRepo();
  writeFileSync(join(dir, 'c.txt'), 'three\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'on main only');
  return dir;
}

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
