/**
 * Locks git left behind: reading the lock out of what git said, telling an old lock from a young one,
 * and explaining a real failure against a lock file whose age is set.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitError } from '../src/git/exec.ts';
import { Remedy, lockNamed, mapGitError, staleLockMessage } from '../src/git/errors.ts';
import { explainStaleLock } from '../src/git/staleLock.ts';

test('the lock git could not create is read out of what it said', () => {
  assert.equal(lockNamed('error: could not lock config file .git/config: File exists'), '.git/config.lock');
  // A rename or a delete says it with no reason given.
  assert.equal(
    lockNamed('error: could not lock config file .git/config\nfatal: branch is renamed, but update of config-file failed'),
    '.git/config.lock',
  );
  assert.equal(
    lockNamed("fatal: Unable to create 'D:/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running"),
    'D:/repo/.git/index.lock',
  );
  assert.equal(
    lockNamed("error: cannot lock ref 'refs/heads/x': Unable to create 'D:/repo/.git/refs/heads/x.lock': File exists."),
    'D:/repo/.git/refs/heads/x.lock',
  );
  assert.equal(lockNamed('fatal: not a git repository'), null);
});

test('a lock is called left behind only once it is older than any command runs', () => {
  const now = new Date('2026-09-14T12:00:00Z');

  assert.equal(staleLockMessage('.git/config.lock', new Date('2026-09-14T11:58:00Z'), now), null, 'two minutes old');

  const old = staleLockMessage('.git/config.lock', new Date('2026-01-16T08:26:54Z'), now) ?? '';
  assert.match(old, /^\.git\/config\.lock has been there since 2026-01-16/);
  assert.match(old, /delete it/);
});

test('a failure on a lock left behind says which file, and that deleting it is the fix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weft-lock-'));

  try {
    mkdirSync(join(dir, '.git'));
    const lock = join(dir, '.git', 'config.lock');
    writeFileSync(lock, '[core]\n');

    const failure = new GitError(
      ['branch', '-m', 'a', 'b'],
      128,
      'error: could not lock config file .git/config\nfatal: branch is renamed, but update of config-file failed\n',
    );

    const fresh = await explainStaleLock(mapGitError(failure), dir);
    assert.match(fresh.message, /Another git process/, 'a lock made a moment ago may still be in use');

    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(lock, twoDaysAgo, twoDaysAgo);

    const stale = await explainStaleLock(mapGitError(failure), dir);
    assert.match(stale.message, /^\.git\/config\.lock has been there since/);
    assert.deepEqual(stale.remedies, [Remedy.ShowLog]);
    assert.equal(stale.raw, mapGitError(failure).raw, "git's own words kept, for the log");

    const gone = await explainStaleLock(mapGitError(failure), join(dir, 'elsewhere'));
    assert.match(gone.message, /Another git process/, 'a lock that is not there any more is not described');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
