/**
 * Every check `npm test` runs, in groups that run at the same time as each other.
 *
 * Measured before this was written: the run took 275 seconds, and 255 of them were two stages that
 * share nothing - the unit tests at 114 and the load check at 140. The seven checks that read the
 * source cost one second between them. The machine has twelve cores and eleven of them were idle for
 * four minutes, because `&&` is a chain and a chain is one core wide.
 *
 * The groups are not arbitrary. `ui-probe` rebuilds `dist/` before it records, and the load check
 * requires the bundle out of `dist/` - so those two are one group, one after the other, and esbuild is
 * never writing a file another process is reading. Everything else reads `src/`, reads `package.json`,
 * or works in a repository of its own under the temp directory, and can run beside anything.
 *
 *   node scripts/check-all.mjs
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * The stages, grouped.
 *
 * A group is a chain and stops at its first failure, the way `&&` did: a bundle that did not build
 * says nothing about the check that would have read it. The other groups keep going, because when
 * something breaks it is worth knowing whether it broke one check or all of them.
 */
const GROUPS = [
  [
    ['ui probe', ['scripts/ui-probe.mjs', 'assert']],
    ['load check', ['scripts/load-check.mjs', '--watch']],
    ['load check, broken view', ['scripts/load-check.mjs', '--break-view=weft.files']],
    // The other answer: a section a window has never heard of costs it that section and nothing more.
    ['load check, missing section', ['scripts/load-check.mjs', '--break-view=weft.authorFiles']],
  ],
  [['unit tests', ['--test', 'test/**/*.test.ts']]],
  [
    ['colour', ['scripts/color-check.mjs']],
    ['columns', ['scripts/column-check.mjs']],
    ['wiring', ['scripts/wiring-check.mjs']],
    ['comments', ['scripts/comment-check.mjs']],
    ['text', ['scripts/text-check.mjs']],
    ['settings', ['scripts/settings-check.mjs']],
    ['icons', ['scripts/icon-check.mjs']],
  ],
];

/*
 * Every `*-check.mjs` in `scripts/` has to be named above.
 *
 * The list is written out rather than globbed, because the grouping and the order inside a group are
 * the whole of what makes this safe - so the glob is what holds the list honest instead. A check that
 * nothing runs is worse than no check: it goes stale quietly, and the next person to run it loses an
 * afternoon to a failure that has been there for months.
 */
const named = new Set(GROUPS.flat().flatMap(([, args]) => args));
const orphans = readdirSync(join(ROOT, 'scripts'))
  .filter((file) => file.endsWith('-check.mjs'))
  .filter((file) => !named.has(`scripts/${file}`));

if (orphans.length > 0) {
  console.error(`FAILED: scripts/${orphans.join(', scripts/')} - a check that nothing here runs.`);
  process.exit(2);
}

/** One stage, with everything it says kept rather than printed, so that six at once stay readable. */
function run(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd: ROOT });
    let text = '';

    child.stdout.on('data', (chunk) => {
      text += chunk;
    });
    child.stderr.on('data', (chunk) => {
      text += chunk;
    });
    child.on('close', (code) => done({ code: code ?? 1, text }));
  });
}

const started = Date.now();
const built = await run(['esbuild.mjs']);

if (built.code !== 0) {
  process.stdout.write(built.text);
  console.error('\nFAILED: the build, which every stage below reads.');
  process.exit(1);
}

const results = [];

async function chain(group) {
  for (const [at, [name, args]] of group.entries()) {
    const began = Date.now();
    const { code, text } = await run(args);
    const seconds = (Date.now() - began) / 1000;

    results.push({ name, code, seconds });
    /*
     * Header and output in one write, because two groups finishing together are two writes racing for
     * the same terminal - and verbatim, with nothing added to the front of a line, because the driver
     * reads node's own `tests` and `pass` and `fail` lines out of this.
     */
    process.stdout.write(`\n=== ${name}${code === 0 ? '' : ', FAILED'} (${seconds.toFixed(1)}s) ===\n${text}`);

    if (code !== 0) {
      for (const [skipped] of group.slice(at + 1)) {
        results.push({ name: skipped, code: null, seconds: 0 });
      }

      return;
    }
  }
}

await Promise.all(GROUPS.map(chain));

const failed = results.filter((result) => result.code !== null && result.code !== 0);
const wall = (Date.now() - started) / 1000;
const work = results.reduce((total, result) => total + result.seconds, 0);

console.log('\n=== what each stage cost ===');

for (const { name, code, seconds } of results) {
  console.log(`  ${name.padEnd(24)} ${code === null ? '   not run' : `${seconds.toFixed(1).padStart(7)}s`}${code === null || code === 0 ? '' : '  FAILED'}`);
}

console.log(`\n${results.length} stages, ${work.toFixed(0)}s of work in ${wall.toFixed(0)}s`);

if (failed.length > 0) {
  console.error(`\nFAILED: ${failed.map((result) => result.name).join(', ')}`);
  process.exit(1);
}
