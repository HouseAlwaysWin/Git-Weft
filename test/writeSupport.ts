/**
 * What every one of the write-action test files needs: the fixtures, the fake UI, and the cleanup.
 *
 * These tests were one file of two thousand seven hundred lines, and node runs the tests in a file one
 * after another - so the suite took 313 seconds of which this file was 92%. Split by subject, they run
 * in parallel and take a fifth of that. What is shared is here rather than copied: a fixture that drifts
 * between two files is worse than a long file.
 *
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
import { delimiter, join } from 'node:path';

import { interactiveRebaseArgs, interactiveRebaseEnv } from '../src/actions/merge.ts';
import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';

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
import type { ActionUi, PickRequest, Target } from '../src/actions/registry.ts';
import { buildMenu, confirmIfNeeded, findAction } from '../src/actions/registry.ts';
import { RepoLock } from '../src/git/lock.ts';
import { listStashes } from '../src/git/stash.ts';
import { nameProblem, readRemotes } from '../src/git/remotes.ts';
import { HistoryLoader } from '../src/git/history.ts';
import { compareCommits } from '../src/git/details.ts';

export const git = new Git({});
export const made: string[] = [];

export function sh(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/**
 * A stand-in for VS Code's own command line, to be put first on the PATH.
 *
 * git runs its editors through `sh` - on Windows too - so a shell script named `code` is what both
 * `GIT_SEQUENCE_EDITOR` and `GIT_EDITOR` will find. It writes down every file it was handed and edits
 * it: the list loses everything after `keep`'s first line, or has its first line reworded, and a commit
 * message becomes one sentence. Being called at all is half of what is being tested - an editor that is
 * never run is exactly the failure this is here for.
 */
export function fakeEditor(edit: 'keep one' | 'reword the first'): { dir: string; called: string } {
  const dir = mkdtempSync(join(tmpdir(), 'weft-editor-')).split('\\').join('/');
  made.push(dir);

  const called = `${dir}/called.txt`;
  const todo =
    edit === 'keep one' ? 'head -n 1 "$2" > "$2.next"' : `sed '1s/^pick/reword/' "$2" > "$2.next"`;

  writeFileSync(
    `${dir}/code`,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$2" >> '${called}'`,
      'case "$2" in',
      `  *git-rebase-todo) ${todo} && mv "$2.next" "$2" ;;`,
      `  *) printf 'reworded by the editor\\n' > "$2" ;;`,
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  return { dir, called };
}

/** Run something with the fake editor first on the PATH, and put the PATH back afterwards. */
export async function withEditor(editor: { dir: string }, run: () => Promise<unknown>): Promise<void> {
  const path = process.env.PATH ?? '';

  process.env.PATH = `${editor.dir}${delimiter}${path}`;

  try {
    await run();
  } finally {
    process.env.PATH = path;
  }
}

/** A repository with `main`, a `feature` branch one commit ahead, and a clean tree. */
export function makeRepo(): string {
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

export async function open(dir: string): Promise<RepoInfo> {
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
export function fakeUi(
  options: {
    confirm?: boolean;
    inputs?: string[];
    /** Answers for `choose`, in order. Running out answers null, which is a cancel. */
    choices?: string[];
    /** Runs while the confirmation is "open" - for testing what a race actually does. */
    whileConfirming?: () => void;
    /** Answers for `pick`, in order: the labels ticked when it is accepted. Running out is a cancel. */
    picks?: string[][];
    protectedBranches?: string[];
    remoteHosts?: Record<string, string>;
  } = {},
): ActionUi & {
  confirmations: string[];
  prompts: string[];
  questions: string[];
  picked: PickRequest[];
  logged: string[];
  opened: string[];
} {
  const confirmations: string[] = [];
  const prompts: string[] = [];
  const questions: string[] = [];
  const inputs = [...(options.inputs ?? [])];
  const choices = [...(options.choices ?? [])];
  const picks = [...(options.picks ?? [])];
  const picked: PickRequest[] = [];
  const logged: string[] = [];
  const opened: string[] = [];

  return {
    confirmations,
    prompts,
    questions,
    picked,
    logged,
    opened,
    pick: async (request) => {
      picked.push(request);
      return picks.shift() ?? null;
    },
    log: (line) => void logged.push(line),
    protectedBranches: () => options.protectedBranches ?? ['main', 'release/*'],
    openUrl: async (url) => {
      opened.push(url);
      return true;
    },
    remoteHosts: () => options.remoteHosts ?? {},
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

export const branch = (label: string): Target => ({
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












/** Commit as somebody in particular, without touching the repository's configured identity. */
export function commitAs(dir: string, name: string, email: string, file: string): void {
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

/*
 * The same person having configured git on three machines is not three people, and it is the most
 * common way a contributor list grows duplicates. Every spelling is kept, because a tick has to
 * name them all: `--author` is case-sensitive, so the row's count and what the graph walks would
 * otherwise part company.
 */

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







/*
 * And why the address is not a key. One service account is a dozen people's commits; folding on it
 * would put a dozen names in one row and a number belonging to none of them.
 */


/** Every commit one walk produced, so a filter can be measured by what it left. */
export async function walk(dir: string, options: Record<string, unknown>): Promise<string[]> {
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


/*
 * The negative side is `--glob=refs/*` and not `--all`, which is the same set plus HEAD - and HEAD
 * is on the branch being asked about, so `--all` there excludes the branch from itself and the
 * answer is always nothing, whichever branch is asked.
 */



/*
 * The buffer, not the file. git blames what is on disk, and an editor holding unsaved edits has
 * moved every line below the first change - so the annotation beside line twelve would be about
 * whatever line twelve used to be.
 */


/** A repository where the stash was made somewhere the other branch cannot see. */
export function makeStashed(): string {
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

export async function stashMap(dir: string): Promise<Map<string, string>> {
  const stashes = await listStashes(git, await open(dir));
  return new Map(stashes.map((stash) => [stash.sha, stash.name]));
}

/*
 * A stash is a commit, and naming one puts everything it can reach into the walk with it. Left
 * unchecked that undoes the ref filter from the side: ticking one branch produced a graph full of
 * commits from branches that had been unticked, with the stashes sitting at the top of it.
 */



export const commit = (sha: string): Target => ({ kind: 'commit', sha, subject: 'x' });

export async function run(dir: string, id: string, target: Target, ui = fakeUi()) {
  const repo = await open(dir);
  const state = await readRepoState(git, repo);
  const action = findAction(id);

  assert.notEqual(action, undefined, `no such action: ${id}`);

  const context = { git, repo, state, target, ui };
  const allowed = await confirmIfNeeded(action!, context);

  return allowed ? action!.run(context) : { message: '', ran: false };
}










export const stashTarget = (name: string, sha: string, message = 'WIP'): Target => ({
  kind: 'stash',
  name,
  sha,
  message,
});

/** A repository with two stashes: stash@{0} is the newer one. */
export function makeRepoWithStashes(): string {
  const dir = makeRepo();

  writeFileSync(join(dir, 'a.txt'), 'first change\n');
  sh(dir, 'stash', 'push', '-m', 'older');
  writeFileSync(join(dir, 'a.txt'), 'second change\n');
  sh(dir, 'stash', 'push', '-m', 'newer');

  return dir;
}


















export const repoTarget = (): Target => ({ kind: 'repo' });

/** main and conflicting both change b.txt, so merging them cannot succeed. */
export function makeConflictingRepo(): string {
  const dir = makeRepo();

  sh(dir, 'checkout', '-q', '-b', 'conflicting', 'main');
  writeFileSync(join(dir, 'b.txt'), 'theirs\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'conflicting change');

  return dir;
}








/* ------------------------------------------------------------------ network operations
 *
 * A bare repository on disk is a real remote as far as git is concerned, so every one of these
 * runs end to end - a genuine push, a genuine rejection - with no network, no credentials and
 * nothing external to be flaky. The cases worth having are the refusals: a push that is rejected,
 * and a lease that holds.
 */

/** A repository with a bare `origin` it has already pushed `main` to. */
export function makeRepoWithRemote(): { dir: string; remote: string } {
  const dir = makeRepo();
  const remote = mkdtempSync(join(tmpdir(), 'weft-remote-')).split('\\').join('/') + '/origin.git';

  made.push(remote);
  sh(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  sh(dir, 'remote', 'add', 'origin', remote);
  sh(dir, 'push', '-q', '-u', 'origin', 'main');

  return { dir, remote };
}

/** Somebody else's clone of the same remote, for the races that only two people can produce. */
export function cloneOf(remote: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-other-')).split('\\').join('/') + '/clone';

  made.push(dir);
  execFileSync('git', ['clone', '-q', remote, dir], { encoding: 'utf8' });
  sh(dir, 'config', 'user.name', 'Someone Else');
  sh(dir, 'config', 'user.email', 'other@example.invalid');
  sh(dir, 'config', 'commit.gpgsign', 'false');

  return dir;
}

export function commitIn(dir: string, file: string, text: string, message: string): string {
  writeFileSync(join(dir, file), text);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', message);
  return sh(dir, 'rev-parse', 'HEAD').trim();
}














/** Both sides move, which is the case `git pull` refuses to decide on its own. */
export function makeDivergence(): { dir: string; remote: string; theirs: string } {
  const { dir, remote } = makeRepoWithRemote();
  const other = cloneOf(remote);
  const theirs = commitIn(other, 'theirs.txt', 'theirs\n', 'from someone else');

  sh(other, 'push', '-q');
  commitIn(dir, 'ours.txt', 'ours\n', 'ours');

  return { dir, remote, theirs };
}







/**
 * The `git` Git for Windows' installer puts on PATH: its launcher, `cmd\git.exe`, which runs the
 * real git as a child of its own - so ending only what was started leaves git running. A shell of
 * Git's own puts the real git first on PATH instead, where the two are the same thing, so the tests
 * below name the launcher: what they check does not depend on where they are run from. Anywhere
 * else it is just `git`.
 */
export function launcher(): string {
  if (process.platform !== 'win32') {
    return 'git';
  }

  const libexec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  const found = join(libexec, '..', '..', '..', 'cmd', 'git.exe');

  return existsSync(found) ? found : 'git';
}

export const launched = new Git({ gitPath: launcher() });

/**
 * A remote that accepts the connection and never answers, which is what a hung one looks like from
 * here. `hungUp` is that connection closing - the git on the other end of it gone, which from out
 * here is the only sign of it there is.
 *
 * The error handler matters: killing git resets the socket, and an unhandled 'error' on it would
 * fail the test for the very thing it is checking happens.
 */
export async function silentRemote(): Promise<{
  url: string;
  reached: Promise<void>;
  hungUp: Promise<void>;
  close: () => void;
}> {
  const sockets = new Set<Socket>();
  let reach = (): void => undefined;
  let hangUp = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    reach = () => resolve();
  });
  const hungUp = new Promise<void>((resolve) => {
    hangUp = () => resolve();
  });

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => hangUp());
    socket.resume();
    reach();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `git://127.0.0.1:${(server.address() as AddressInfo).port}/silent.git`,
    reached,
    hungUp,
    // Every connection too, so a git that outlived its test cannot hold the test run open with it.
    close: () => {
      for (const socket of sockets) {
        socket.destroy();
      }

      server.close();
    },
  };
}

/** Whether it settles within `ms` - for waiting on something that, broken, would never happen at all. */
export async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** How a command ended, as a word: `finished`, or what it was rejected with - `cancelled`, say. */
export function ending(running: Promise<unknown>): Promise<string> {
  return running.then(
    () => 'finished',
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
}





/*
 * Remotes, against a real one.
 *
 * The remote is a second repository on disk, added by path. Nothing here is mocked: the fetch is a
 * fetch, and what it writes into `refs/remotes/` is what the assertions read back. A remote that is
 * configured correctly and fetches nothing is exactly the failure worth a test.
 */

export const REPO: Target = { kind: 'repo' };

/** The names git reports, so an assertion reads what git thinks rather than what the action said. */
export function remoteNames(dir: string): string[] {
  return sh(dir, 'remote')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Remote-tracking refs under one remote. */
export function tracking(dir: string, name: string): string[] {
  return sh(dir, 'for-each-ref', '--format=%(refname)', `refs/remotes/${name}/`)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}











/*
 * Deleting a branch on the server.
 *
 * The remote is a bare repository on disk, so the push is a real push and the assertions read the
 * branch list out of the server rather than out of the clone that asked for it to go.
 */

export const remoteRef = (label: string): Target => ({
  kind: 'ref',
  refName: `refs/remotes/${label}`,
  label,
  refKind: 'remote',
});

/** A bare repository with `main` and `doomed` on it, and a clone that has fetched both. */
export function makeServed(): { dir: string; server: string } {
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

export function serverBranches(server: string): string[] {
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










/*
 * Merging: the question, and the one that declines to merge at all.
 *
 * The assertions are about the shape of the history afterwards - how many parents the new commit
 * has, whether HEAD moved at all - because that is the whole of what these options differ by.
 */

/** How many parents HEAD has. Two means a merge commit; one means it did not record a merge. */
export function parentCount(dir: string): number {
  return sh(dir, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(/\s+/).length - 1;
}

/** `main` strictly behind `feature`, so a fast-forward is on the table. */
export function makeBehind(): string {
  const dir = makeRepo();
  sh(dir, 'checkout', '-q', 'main');
  sh(dir, 'merge', '-q', '--ff-only', 'feature');
  sh(dir, 'reset', '-q', '--hard', 'HEAD~1');
  return dir;
}

/** Both branches moved, so a merge commit is the only thing a merge can produce. */
export function makeDiverged(): string {
  const dir = makeRepo();
  writeFileSync(join(dir, 'c.txt'), 'three\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'on main only');
  return dir;
}



















