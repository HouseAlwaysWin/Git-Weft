/**
 * The history of a few lines.
 *
 * `git log -L` re-derives the range at every step, so this is not the file's history filtered down
 * to the lines: a commit that changed a different part of the same file is not in it, and a line
 * that moved is followed to where it moved. That is the property worth testing, because a list of
 * commits that all touched the right *file* looks completely convincing.
 *
 * And the constraint that decided where the answer goes: `-L` digs from exactly one commit. Two
 * refs are `fatal: More than one commit to dig from`, the exclusion shape the graph uses for
 * *only here* is `fatal: No commit specified?`. So a ref must never reach this command line, and
 * that is asserted rather than assumed - it is the difference between a section beside the graph
 * and a mode inside it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Git } from '../src/git/exec.ts';
import { discover } from '../src/git/discovery.ts';
import { clampRange, lineHistory } from '../src/git/lineHistory.ts';
import type { GitLogEntry } from '../src/git/exec.ts';

const dir = mkdtempSync(join(tmpdir(), 'weft-lines-')).split('\\').join('/');
const ran: GitLogEntry[] = [];
const git = new Git({ onCommand: (entry) => ran.push(entry) });

function sh(...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function commit(lines: readonly string[], message: string): void {
  writeFileSync(`${dir}/file.txt`, `${lines.join('\n')}\n`);
  sh('add', '-A');
  sh('-c', 'user.name=Weft Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', message);
}

sh('init', '-q', '-b', 'main');
sh('config', 'commit.gpgsign', 'false');
sh('config', 'core.autocrlf', 'false');

/*
 * Six lines, then three commits that each touch one of them. The top of the file and the bottom of
 * it have separate histories from here on, which is the whole point.
 */
const base = ['one', 'two', 'three', 'four', 'five', 'six'];

commit(base, 'the file');
commit(['one', 'TWO', 'three', 'four', 'five', 'six'], 'line two');
commit(['one', 'TWO', 'three', 'four', 'FIVE', 'six'], 'line five');
commit(['one', 'TWO!', 'three', 'four', 'FIVE', 'six'], 'line two again');

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('a line history is the lines, not the file they are in', async () => {
  const repo = await discover(git, dir);

  assert.notEqual(repo, null);

  const top = await lineHistory(git, repo!, { path: 'file.txt', from: 1, to: 3 });
  const bottom = await lineHistory(git, repo!, { path: 'file.txt', from: 5, to: 5 });

  assert.deepEqual(
    top.map((c) => c.subject),
    ['line two again', 'line two', 'the file'],
    'the top of the file has never heard of the commit that changed line five',
  );

  assert.deepEqual(
    bottom.map((c) => c.subject),
    ['line five', 'the file'],
    'and the bottom has never heard of either commit that changed line two',
  );

  // Which is the difference from asking about the file: that answer is all four.
  const whole = await lineHistory(git, repo!, { path: 'file.txt', from: 1, to: 6 });

  assert.equal(whole.length, 4, 'the whole file is every commit that touched it');
});

test('no ref ever reaches a -L command line', async () => {
  /*
   * git digs from one commit, and says so twice over: two refs are "More than one commit to dig
   * from" and the graph's exclusion shape is "No commit specified?". Neither is recoverable at the
   * point it happens - the walk is already gone - so the command is built without refs at all.
   */
  const repo = await discover(git, dir);

  ran.length = 0;
  await lineHistory(git, repo!, { path: 'file.txt', from: 2, to: 2 });

  const walk = ran.find((entry) => entry.args.includes('log'));

  assert.notEqual(walk, undefined, 'the walk was not run');

  const ranges = (walk?.args ?? []).filter((arg) => arg.startsWith('-L'));

  assert.deepEqual(ranges, ['-L2,2:file.txt'], 'one range, spelled as one argument');

  const refs = (walk?.args ?? []).filter(
    (arg) => arg.startsWith('refs/') || arg === '--all' || arg === '--not' || arg === 'HEAD',
  );

  assert.deepEqual(refs, [], `a ref reached the command line: ${refs.join(' ')}`);
});

test('a range is whole, positive, and the right way round', () => {
  // Editors count lines from zero and `-L` counts from one, so a zero here is somebody's off-by-one
  // arriving as a range git would refuse.
  assert.deepEqual(clampRange({ path: 'a.txt', from: 0, to: 4 }), {
    path: 'a.txt',
    from: 1,
    to: 4,
  });

  assert.deepEqual(clampRange({ path: 'a.txt', from: 9, to: 2 }), {
    path: 'a.txt',
    from: 9,
    to: 9,
  });

  assert.deepEqual(clampRange({ path: 'a.txt', from: 2.7, to: 5.2 }), {
    path: 'a.txt',
    from: 2,
    to: 5,
  });
});

test('a range past the end of the file says so rather than coming back empty', async () => {
  const repo = await discover(git, dir);

  await assert.rejects(
    () => lineHistory(git, repo!, { path: 'file.txt', from: 900, to: 900 }),
    /file has only|has only 6 lines|fatal/,
    'git explains this one, and an empty list would not',
  );
});
