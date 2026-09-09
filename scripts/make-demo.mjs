/**
 * A small repository that looks like a project, for the screenshots in the README.
 *
 * Not a fixture: `make-fixture.mjs` builds a hundred thousand commits to measure against, and what
 * it produces is deliberately uniform. This one is the opposite - a few dozen commits with names on
 * them, branches open at the same time, merges that cross, two tags and work still in flight -
 * because a screenshot of a graph has to show the thing the graph is for.
 *
 * Invented, and that is the point. Rendering somebody's real repository into a public README puts
 * their branch names, their ticket numbers, their colleagues and their internal git URL on the
 * internet, and none of that can be taken back.
 *
 *   node scripts/make-demo.mjs <dir>
 *   node scripts/preview.mjs <dir> && node scripts/serve.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];

if (dir === undefined) {
  console.error('usage: node scripts/make-demo.mjs <dir>');
  process.exit(1);
}

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });

/**
 * The same, at a fixed moment.
 *
 * Through the environment because `git merge` has no `--date` at all, and because `commit --date`
 * sets only the author's - leaving the committer stamped with whenever the screenshot was taken,
 * which is the difference between a history and a history that appears to end today.
 */
const gitAt = (when, ...args) =>
  execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });

const PEOPLE = {
  ada: ['Ada Fischer', 'ada@example.com'],
  nils: ['Nils Berg', 'nils@example.com'],
  rui: ['Rui Santos', 'rui@example.com'],
};

/** Fixed, so running this twice draws the same picture. */
let clock = Date.parse('2025-11-03T09:00:00Z');
let sequence = 0;

const now = () => new Date(clock).toISOString();

/**
 * One commit, touching a file nobody else touches.
 *
 * Per commit rather than per branch, because two branches editing one file is a conflict at merge
 * time, and a script that stops to ask about a conflict is not a script that makes a screenshot.
 */
function commit(who, message) {
  clock += 190 * 60_000;
  sequence += 1;

  const [name, email] = PEOPLE[who];

  writeFileSync(join(dir, `src-${String(sequence).padStart(3, '0')}.txt`), `${message}\n`);
  git('add', '-A');
  gitAt(
    now(),
    '-c', `user.name=${name}`,
    '-c', `user.email=${email}`,
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', message,
  );
}

function merge(name) {
  clock += 190 * 60_000;

  gitAt(
    now(),
    '-c', 'user.name=Ada Fischer',
    '-c', 'user.email=ada@example.com',
    '-c', 'commit.gpgsign=false',
    'merge', '-q', '--no-ff', '--no-edit', name,
  );

  git('branch', '-q', '-d', name);
}

function tag(name, message) {
  gitAt(
    now(),
    '-c', 'user.name=Ada Fischer',
    '-c', 'user.email=ada@example.com',
    'tag', '-a', name, '-m', message,
  );
}

/**
 * Several branches open at once, interleaved with the trunk.
 *
 * A branch that opens and merges before the next one starts gives a graph two lanes wide, which is
 * a graph nobody has. Real work overlaps - three people are somewhere else at the same time - and
 * the lanes running beside each other is the thing worth a picture.
 */
function parallel(branches, trunk = []) {
  for (const [name] of branches) {
    git('checkout', '-q', '-b', name, 'main');
  }

  const rounds = Math.max(...branches.map(([, , messages]) => messages.length), trunk.length);

  for (let round = 0; round < rounds; round++) {
    for (const [name, who, messages] of branches) {
      const message = messages[round];

      if (message !== undefined) {
        git('checkout', '-q', name);
        commit(who, message);
      }
    }

    const onTrunk = trunk[round];

    if (onTrunk !== undefined) {
      git('checkout', '-q', 'main');
      commit(onTrunk[0], onTrunk[1]);
    }
  }

  git('checkout', '-q', 'main');

  for (const [name] of branches) {
    merge(name);
  }
}

git('init', '-q', '-b', 'main');
git('config', 'core.autocrlf', 'false');

commit('ada', 'Initial commit');
commit('ada', 'Walk the history with one process');
commit('nils', 'Read the config on open');

parallel(
  [
    ['feat/streaming-pages', 'nils', ['Stream pages instead of waiting', 'Emit a page every 500 commits', 'Keep the first page small']],
    ['feat/lane-colours', 'rui', ['Give each lane a colour of its own', 'Fall back where a theme has none']],
    ['fix/ref-cache', 'ada', ['Cache the ref list', 'Drop it on a checkout', 'Read it once per reload']],
  ],
  [
    ['ada', 'Tidy the lane allocator'],
    ['rui', 'Escape the search box properly'],
    ['nils', 'Log every command git is given'],
  ],
);

tag('v1.0.0', 'First release');

parallel(
  [
    ['feat/blame-column', 'rui', ['Blame the whole file into a column', 'Fold repeated authors', 'Follow the cursor']],
    ['feat/line-history', 'nils', ['Ask git for the history of a line range', 'Put it in a section of its own']],
    ['fix/detached-head', 'ada', ['Do not call a detached HEAD a branch']],
  ],
  [
    ['ada', 'Widen the date column when there is room'],
    ['rui', 'Correct the author fold for separators'],
  ],
);

commit('ada', 'Measure a frame before optimising it');
tag('v1.1.0', 'Blame and line history');

// Two branches left open, because a graph with nothing in flight is not a graph anybody has.
for (const [name, who, messages] of [
  ['feat/columnar-store', 'nils', ['Weigh a row', 'Interleave the lane points']],
  ['fix/stale-palette', 'rui', ['Read the palette every frame']],
]) {
  git('checkout', '-q', '-b', name, 'main');

  for (const message of messages) {
    commit(who, message);
  }
}

git('checkout', '-q', 'main');
commit('ada', 'Say when the walk stopped at the limit');

// Something uncommitted, so the working-tree row is in the picture as well.
writeFileSync(join(dir, 'src-001.txt'), 'Initial commit, edited but not committed\n');
writeFileSync(join(dir, 'notes.md'), 'Not added yet.\n');

const commits = git('rev-list', '--count', '--all').trim();
const refs = git('for-each-ref', '--format=%(refname:short)').trim().split('\n');

console.log(`${dir}\n  ${commits} commits, ${refs.length} refs: ${refs.join(', ')}`);
