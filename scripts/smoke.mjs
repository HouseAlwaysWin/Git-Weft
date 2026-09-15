// End-to-end check: real git -> streaming parser -> incremental layout.
// Reports time-to-first-page, which is the number that decides whether a big repo feels instant.
//
//   node scripts/smoke.mjs <repo> [--verbose] [--tally]
//
// --tally counts the walk for the statistics tab as the graph does, so runs with and without it measure
// what the counting costs. Under `node --expose-gc` it also says how much heap the tally keeps.
import { Git } from '../src/git/exec.ts';
import { discover, listWorktrees } from '../src/git/discovery.ts';
import { HistoryLoader } from '../src/git/history.ts';
import { summarize } from '../src/stats/summary.ts';
import { CommitTally } from '../src/stats/tally.ts';

const repoPath = process.argv[2] ?? 'D:/DotNetProjects/GitFlick';
const verbose = process.argv.includes('--verbose');
let tally = process.argv.includes('--tally') ? new CommitTally() : null;

const git = new Git({
  onCommand: (e) =>
    verbose && console.log(`  [${e.durationMs}ms exit=${e.exitCode}] git ${e.args.join(' ')}`),
});

const t0 = Date.now();
const repo = await discover(git, repoPath);

if (repo === null) {
  console.error(`not a git repository: ${repoPath}`);
  process.exit(1);
}

console.log(`repo            : ${repo.root}`);
console.log(`git dir         : ${repo.gitDir}`);
console.log(`common dir      : ${repo.commonDir}${repo.isLinkedWorktree ? '   <- differs: linked worktree' : ''}`);
console.log(`bare            : ${repo.isBare}`);
console.log(`submodule of    : ${repo.superproject ?? '(not a submodule)'}`);

const worktrees = await listWorktrees(git, repo);
console.log(`worktrees       : ${worktrees.length}`);
for (const w of worktrees) {
  console.log(`  ${w.path}  ${w.branch ?? (w.isDetached ? '(detached)' : '')}${w.isLocked ? ' [locked]' : ''}`);
}

const loader = new HistoryLoader(git, repo);
let pages = 0;
let firstPageAt = 0;
let commits = 0;
let arcs = 0;
let lanes = 0;

await loader.load(
  (page) => {
    if (!page.done) {
      pages++;
      commits += page.commits.length;
      arcs += page.delta.links.length;
      lanes += page.delta.paths.length;
      tally?.add(page.commits);
      if (firstPageAt === 0) {
        firstPageAt = Date.now() - t0;
      }
    }
  },
  { batchSize: 500 },
);

const total = Date.now() - t0;

console.log(`\ncommits         : ${commits}`);
console.log(`pages           : ${pages}`);
console.log(`merge arcs      : ${arcs}`);
console.log(`lane segments   : ${lanes}`);
console.log(`first page      : ${firstPageAt}ms   <- what the user waits for`);
console.log(`full history    : ${total}ms`);
console.log(`rows/sec        : ${Math.round((commits / Math.max(total, 1)) * 1000).toLocaleString()}`);

if (tally !== null) {
  // In a block of its own, so that nothing summarize returned is still reachable when the heap is measured.
  {
    const facts = { truncated: false, limit: 250_000, scope: '', dated: false };
    const times = [];

    for (let i = 0; i < 9; i++) {
      const started = performance.now();
      summarize(tally, new Map(), facts);
      times.push(performance.now() - started);
    }

    times.sort((a, b) => a - b);
    const summary = summarize(tally, new Map(), facts);

    console.log(`\ntallied         : ${tally.total} commits, ${summary.people.length} people, ${summary.buckets.length} ${summary.unit}s`);
    console.log(`summarize       : ${times[4].toFixed(2)}ms, the median of 9`);
    console.log(`summary         : ${(JSON.stringify(summary).length / 1024).toFixed(1)} KB as JSON`);
  }

  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    const holding = process.memoryUsage().heapUsed;
    tally = null;
    globalThis.gc();
    console.log(`tally keeps     : ${((holding - process.memoryUsage().heapUsed) / 1024).toFixed(0)} KB of heap`);
  }
}
