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
import { repoFingerprint } from '../src/git/watcher.ts';

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
