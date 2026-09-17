/**
 * The watcher's fingerprint, against real repositories.
 *
 * Whether the graph reloads - or redraws only its banner, or does nothing - is decided by whether
 * this changes. So each case is something done from a terminal and then looked for in the graph.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Git } from '../src/git/exec.ts';
import { discover } from '../src/git/discovery.ts';
import type { RepoInfo } from '../src/git/discovery.ts';
import { Operation } from '../src/git/repoState.ts';
import { RepoWatcher, isNoise, repoFingerprint } from '../src/git/watcher.ts';

const git = new Git({});
const made: string[] = [];

function sh(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** One commit on `main`, a clean tree. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-fingerprint-')).split('\\').join('/');
  made.push(dir);

  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Weft Test');
  sh(dir, 'config', 'user.email', 'test@example.invalid');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  sh(dir, 'config', 'core.autocrlf', 'false');

  writeFileSync(join(dir, 'a.txt'), 'one\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'first');

  return dir;
}

async function open(dir: string): Promise<RepoInfo> {
  const repo = await discover(git, dir);
  assert.notEqual(repo, null, 'fixture should be a repository');
  return repo as RepoInfo;
}

after(() => {
  for (const dir of made) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checking out another branch at the same commit changes the fingerprint', async () => {
  const dir = makeRepo();
  sh(dir, 'branch', 'twin');
  const repo = await open(dir);

  const before = await repoFingerprint(git, repo);
  sh(dir, 'checkout', '-q', 'twin');
  const after = await repoFingerprint(git, repo);

  // One commit, the same refs pointing at it: only which branch HEAD is on has moved.
  assert.equal(sh(dir, 'rev-parse', 'main').trim(), sh(dir, 'rev-parse', 'twin').trim());
  assert.notEqual(after.refs, before.refs);
  assert.equal(after.operation, Operation.None);
});

test('a merge that stops on a conflict changes the operation and nothing else', async () => {
  const dir = makeRepo();
  sh(dir, 'checkout', '-q', '-b', 'clash');
  writeFileSync(join(dir, 'a.txt'), 'theirs\n');
  sh(dir, 'commit', '-q', '-am', 'theirs');
  sh(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'a.txt'), 'ours\n');
  sh(dir, 'commit', '-q', '-am', 'ours');
  const repo = await open(dir);

  const before = await repoFingerprint(git, repo);

  // git exits 1 when the merge stops on the conflict, which is the case being made.
  assert.throws(() => sh(dir, 'merge', 'clash'));
  const during = await repoFingerprint(git, repo);

  assert.equal(before.operation, Operation.None);
  assert.equal(during.operation, Operation.Merge);
  assert.equal(during.refs, before.refs);
});

test('a file written into the worktree changes nothing', async () => {
  const dir = makeRepo();
  const repo = await open(dir);

  const before = await repoFingerprint(git, repo);
  writeFileSync(join(dir, 'untracked.txt'), 'not a commit\n');

  assert.deepEqual(await repoFingerprint(git, repo), before);
});

test('the churn a watcher sleeps through, and the churn it must not', () => {
  // Written by every `git status`, including the built-in git extension's, on every file saved.
  assert.equal(isNoise('index'), true);

  // A ref actually called `index` arrives from the deep watch as the same word, and is a ref moving.
  assert.equal(isNoise('index', true), false);
  assert.equal(isNoise('heads/index', true), false);

  assert.equal(isNoise('heads/main.lock'), true, 'a lock is a write in progress, not a write');
  assert.equal(isNoise('objects/ab/cdef0123'), true, 'objects arrive before the ref that points at them');
  assert.equal(isNoise('COMMIT_EDITMSG'), true);
  assert.equal(isNoise('FETCH_HEAD'), true, "Weft's own fetches must not wake it");

  assert.equal(isNoise('HEAD'), false, 'the one that says a checkout happened');
  assert.equal(isNoise('packed-refs'), false);
  assert.equal(isNoise('heads/main', true), false);
  assert.equal(isNoise('remotes/origin/main', true), false);
  assert.equal(isNoise('ORIG_HEAD'), false);
});

test('dropping a stash that is not the newest wakes the watcher', async () => {
  const dir = makeRepo();

  // Two stashes, so that the one dropped is not the one `refs/stash` points at.
  for (const text of ['first stash\n', 'second stash\n']) {
    writeFileSync(join(dir, 'a.txt'), text);
    sh(dir, 'stash', 'push', '-q', '-m', text.trim());
  }

  const repo = await open(dir);
  let woke = 0;
  const watcher = new RepoWatcher(repo, () => (woke += 1), 20);

  try {
    const top = sh(dir, 'rev-parse', 'refs/stash').trim();

    sh(dir, 'stash', 'drop', 'stash@{1}');

    /*
     * This is the part worth pinning. Only the newest stash is a ref - the rest of the stack lives in
     * `logs/refs/stash`, which nothing here watches - so it reads like a change the watcher cannot
     * see, and it was written up as a bug. It is not one: git rewrites `refs/stash` as well, with the
     * same value it had, and a rewrite is an event whatever it wrote. Nothing had to be added for
     * this to work, and a watch of the reflogs would have been a watch for nothing - but the reason
     * is git's, not Weft's, so it is worth a test rather than a comment.
     */
    assert.equal(sh(dir, 'rev-parse', 'refs/stash').trim(), top, 'the ref this is not about did not move');

    const by = Date.now() + 5_000;

    while (Date.now() < by && woke === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(woke > 0, 'the graph would otherwise go on drawing a stash that is gone');
  } finally {
    watcher.dispose();
  }
});
