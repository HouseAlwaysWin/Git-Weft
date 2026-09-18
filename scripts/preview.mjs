/**
 * Renders the webview outside VS Code, with real data from a real repository.
 *
 * The extension host half can be exercised from Node, but the drawing half normally needs an
 * Extension Development Host to look at. This stubs `acquireVsCodeApi` and the handful of
 * `--vscode-*` theme variables the stylesheet reads, then replays exactly the messages the panel
 * would post - so what renders here is what renders in VS Code.
 *
 *   npm run build && node scripts/preview.mjs [repo] [--light]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { Git } from '../src/git/exec.ts';
import { discover } from '../src/git/discovery.ts';
import { HistoryLoader } from '../src/git/history.ts';
import { BODY_MARKUP, REBASE_MARKUP, STATS_MARKUP } from '../src/webview/markup.ts';
import { describeTodo, parseTodo } from '../src/git/rebaseTodo.ts';
import { authorHue } from '../src/webview/authorColor.ts';
import { describeScope } from '../src/stats/scope.ts';
import { summarize } from '../src/stats/summary.ts';
import { CommitTally } from '../src/stats/tally.ts';
import { loadCommitDetails } from '../src/git/details.ts';
import { readRepoState } from '../src/git/repoState.ts';

const repoPath = process.argv[2] ?? 'D:/DotNetProjects/GitFlick';
const light = process.argv.includes('--light');
const maxCommits = Number(process.argv.find((a) => a.startsWith('--max='))?.slice(6) ?? 5000);

const git = new Git({});
const repo = await discover(git, repoPath);

if (repo === null) {
  console.error(`not a git repository: ${repoPath}`);
  process.exit(1);
}

const loader = new HistoryLoader(git, repo);
const messages = [];

// Counted as the panel counts it, for the statistics tab's page - and its merges counted apart from the
// tally, so what the page says can be held to a number the tally did not produce.
const walkTally = new CommitTally();
let walkMerges = 0;

await loader.load(
  (page) => {
    walkTally.add(page.commits);
    walkMerges += page.commits.filter((commit) => commit.parents.length > 1).length;

    if (page.commits.length > 0 || page.done) {
      messages.push({
        type: 'page',
        rows: page.commits.map((c, at) => ({
          sha: c.sha,
          /*
           * One subject long enough to be cut short, on the row that also carries the longest badge: a
           * page where nothing gives way proves nothing about what gives way first.
           */
          subject:
            messages.length === 0 && at === 4
              ? `${c.subject} - and a tail on this one long enough that the row has to give something up somewhere`
              : c.subject,
          author: c.author,
          date: c.authorDate,
          refs: c.refs,
          isHead: c.isHead,
          /*
           * What the came-from switch puts on a row, on two of the first page's, so the badges are
           * something that can be looked at here and held to a shape by the probe. The switch itself is
           * the host's, and a preview has no host to turn it on.
           */
          ...(messages.length > 0 || at > 4
            ? {}
            : at === 2
              ? { cameFrom: { branch: 'uat', how: 'merge' } }
              : at === 4
                ? // Long on purpose: a badge that fits proves nothing about one that does not.
                  { cameFrom: { branch: 'uat_deploy_2026_holding_branch', how: 'copy' } }
                : {}),
        })),
        delta: page.delta,
      });
    }
  },
  { batchSize: 500, maxCommits },
);

// The working tree, read for real: the row that stands for it is only worth looking at against a
// repository that actually has uncommitted changes in it.
const state = await readRepoState(git, repo);

messages.push({
  type: 'working',
  total: state.files.length,
  staged: state.files.filter((f) => f.staged).length,
  unstaged: state.files.filter((f) => f.unstaged).length,
  untracked: state.files.filter((f) => f.untracked).length,
  conflicted: state.files.filter((f) => f.conflicted).length,
  branch: state.branch,
  upstream: state.upstream,
  fetchedAt: state.fetchedAt,
});

/*
 * The refs, for the header's branch menu. Read from the real repository like everything else here,
 * and all ticked - the preview has no sidebar to have unticked anything in.
 */
/*
 * The same fields the real view is handed, `updated` included. A harness that builds this message
 * by hand is one field away from showing something the extension never shows - which is the one
 * thing it exists not to do.
 */
const refLines = execFileSync(
  'git',
  ['for-each-ref', '--format=%(refname)%00%(committerdate:unix)'],
  { cwd: repo.root, encoding: 'utf8' },
)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => {
    const [refName = '', updated = ''] = line.split('\x00');
    return { refName, updated: Number(updated) > 0 ? Number(updated) * 1000 : 0 };
  });

messages.push({
  type: 'refs',
  branch: state.branch,
  refs: refLines.map(({ refName, updated }) => ({
    refName,
    label: refName.replace(/^refs\/(heads|remotes|tags)\//, ''),
    kind: refName.startsWith('refs/tags/')
      ? 'tag'
      : refName.startsWith('refs/remotes/')
        ? 'remote'
        : 'local',
    visible: true,
    updated,
  })),
});

messages.push({ type: 'done', total: loader.rowCount, elapsedMs: 0 });

// A stand-in for a stopped merge, so the in-progress banner is something that can be looked at.
if (process.argv.includes('--conflict')) {
  messages.push({
    type: 'operation',
    operation: 'merge',
    description: 'a merge',
    conflicted: ['GitFlick/ViewModels/HistoryViewModel.cs', 'CHANGELOG.md'],
    controls: [
      { id: 'weft.continueOperation', label: 'Continue', group: 'operation', destructive: false, disabledReason: 'Resolve the conflicts first' },
      { id: 'weft.skipOperation', label: 'Skip', group: 'operation', destructive: false, disabledReason: 'A merge cannot skip a commit' },
      { id: 'weft.abortOperation', label: 'Abort', group: 'danger', destructive: false, disabledReason: null },
    ],
  });
}

// Replay a selection too, so the details pane is part of what gets looked at rather than something
// only ever seen inside VS Code. Its file list moved to the Source Control sidebar, which is not
// something this harness can render, so any commit with a message will do.
const sample = messages.find((m) => m.type === 'page')?.rows?.[0];

if (sample !== undefined) {
  const { files: _files, ...info } = await loadCommitDetails(git, repo, sample.sha);
  messages.push({ type: 'details', details: info });
}

/*
 * Approximations of VS Code's own Dark Modern / Light Modern values. A light theme is not a dark
 * theme with a white background: its accent colours are darker too. Getting that wrong here made
 * the preview lie about contrast - which is the one thing this harness exists to be honest about.
 */
const dark = {
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-editor-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-list-activeSelectionBackground': '#04395e',
  '--vscode-panel-border': '#2b2b2b',
  '--vscode-errorForeground': '#f14c4c',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-progressBar-background': '#0078d4',
  '--vscode-font-family': 'system-ui, sans-serif',
  '--vscode-font-size': '13px',
  '--vscode-editor-font-family': 'Consolas, monospace',
  '--vscode-editorWidget-background': '#252526',
  '--vscode-input-background': '#313131',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-input-border': '#3c3c3c',
  '--vscode-inputOption-activeBackground': 'rgba(36, 137, 219, 0.35)',
  '--vscode-inputOption-activeBorder': '#2488db',
  '--vscode-inputOption-activeForeground': '#ffffff',
  '--vscode-editor-findMatchHighlightBackground': 'rgba(234, 92, 0, 0.33)',
  '--vscode-textCodeBlock-background': '#2b2b2b',
  '--vscode-textLink-foreground': '#4daafc',
  '--vscode-charts-blue': '#3794ff',
  '--vscode-charts-green': '#89d185',
  '--vscode-charts-orange': '#d18616',
  '--vscode-charts-purple': '#b180d7',
  '--vscode-charts-red': '#f14c4c',
  '--vscode-charts-yellow': '#cca700',
  '--vscode-charts-foreground': '#cccccc',
  '--vscode-gitDecoration-addedResourceForeground': '#81b88b',
  '--vscode-gitDecoration-modifiedResourceForeground': '#e2c08d',
  '--vscode-gitDecoration-deletedResourceForeground': '#c74e39',
  '--vscode-gitDecoration-renamedResourceForeground': '#73c991',
};

const lightTheme = {
  ...dark,
  '--vscode-editor-background': '#ffffff',
  '--vscode-editor-foreground': '#3b3b3b',
  '--vscode-descriptionForeground': '#717171',
  '--vscode-list-hoverBackground': '#f0f0f0',
  '--vscode-list-activeSelectionBackground': '#e4e6f1',
  '--vscode-panel-border': '#e5e5e5',
  '--vscode-editorWidget-background': '#f8f8f8',
  '--vscode-input-background': '#ffffff',
  '--vscode-input-foreground': '#3b3b3b',
  '--vscode-input-border': '#cecece',
  '--vscode-inputOption-activeBackground': 'rgba(0, 122, 204, 0.2)',
  '--vscode-inputOption-activeBorder': '#005fb8',
  '--vscode-inputOption-activeForeground': '#000000',
  '--vscode-editor-findMatchHighlightBackground': 'rgba(234, 92, 0, 0.33)',
  '--vscode-textCodeBlock-background': '#f3f3f3',
  '--vscode-textLink-foreground': '#005fb8',
  '--vscode-charts-blue': '#1a85ff',
  '--vscode-charts-green': '#388a34',
  '--vscode-charts-orange': '#b5620a',
  '--vscode-charts-purple': '#652d90',
  '--vscode-charts-red': '#cd3131',
  '--vscode-charts-yellow': '#a67c00',
  '--vscode-charts-foreground': '#3b3b3b',
  '--vscode-gitDecoration-addedResourceForeground': '#587c0c',
  '--vscode-gitDecoration-modifiedResourceForeground': '#895503',
  '--vscode-gitDecoration-deletedResourceForeground': '#ad0707',
  '--vscode-gitDecoration-renamedResourceForeground': '#007100',
};

const theme = light ? lightTheme : dark;
const vars = Object.entries(theme)
  .map(([k, v]) => `  ${k}: ${v};`)
  .join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Weft preview - ${repo.root}</title>
<style>:root {\n${vars}\n}</style>
<link href="style.css" rel="stylesheet">
</head>
<body class="${light ? 'vscode-light' : 'vscode-dark'}">
${BODY_MARKUP}
<script>
  const sent = window.__sent = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => {
      sent.push(m);
      if (m.type === 'ready') replay();
      // Stand in for the host so the menu can be looked at: a real one, plus a disabled one.
      if (m.type === 'requestMenu') {
        window.postMessage({
          type: 'menu',
          target: m.target,
          x: m.x,
          y: m.y,
          items: m.target.kind === 'ref'
            ? [
                { id: 'weft.checkoutBranch', label: 'Checkout ' + m.target.label, group: 'branch', destructive: false, disabledReason: null },
                { id: 'weft.renameBranch', label: 'Rename ' + m.target.label + '…', group: 'branch', destructive: false, disabledReason: null },
                { id: 'weft.createBranch', label: 'Create branch from ' + m.target.label + '…', group: 'create', destructive: false, disabledReason: null },
                { id: 'weft.createTag', label: 'Create tag at ' + m.target.label + '…', group: 'create', destructive: false, disabledReason: null },
                { id: 'weft.deleteBranch', label: 'Delete ' + m.target.label, group: 'danger', destructive: false, disabledReason: null },
              ]
            : [
                { id: 'weft.checkoutCommit', label: 'Checkout ' + m.target.sha.slice(0,8) + ' (detached)', group: 'branch', destructive: false, disabledReason: null },
                { id: 'weft.createBranch', label: 'Create branch from ' + m.target.sha.slice(0,8) + '…', group: 'create', destructive: false, disabledReason: null },
                { id: 'weft.createTag', label: 'Create tag at ' + m.target.sha.slice(0,8) + '…', group: 'create', destructive: false, disabledReason: null },
                { id: 'demo.reset', label: 'Reset main to here (hard)', group: 'danger', destructive: true, disabledReason: 'Not built yet' },
              ],
        }, '*');
      }
    },
    // A real store rather than a stub: the view's layout and filters are supposed to survive the
    // tab being hidden, and a getState that always answers undefined would hide it if they did not.
    getState: () => { try { return JSON.parse(sessionStorage.getItem('weft.state') ?? 'null') ?? undefined; } catch { return undefined; } },
    setState: (v) => { try { sessionStorage.setItem('weft.state', JSON.stringify(v)); } catch {} },
  });
  const MESSAGES = ${JSON.stringify(messages)};
  const INIT = ${JSON.stringify({
    type: 'init',
    repoName: repo.root.split('/').pop(),
    repoRoot: repo.root,
    rowHeight: 24,
    authorColors: true,
    kind: repo.isBare ? 'bare' : repo.isLinkedWorktree ? 'linked worktree' : null,
    // weft.ticketLinks is a setting, and a preview has none: no id is a link here.
    ticketPatterns: [],
  })};
  function replay() {
    window.postMessage(INIT, '*');
    // The panel always opens a load with a reset; replaying without one would hide anything the
    // view only learns from it.
    window.postMessage({ type: 'reset', filtered: false }, '*');
    for (const m of MESSAGES) window.postMessage(m, '*');
  }
</script>
<script src="main.js"></script>
</body>
</html>`;

writeFileSync('dist/preview.html', html);
console.log(
  `dist/preview.html  <- ${loader.rowCount} commits from ${repo.root}${light ? ' (light)' : ' (dark)'}`,
);

/*
 * The statistics tab's page, beside the graph's: the same stand-in for VS Code, handed summaries made the
 * way the panel makes them - by the real tally and summary - with the commits and merges behind each
 * counted here without them, for the probe to hold the page to.
 *
 * One is this walk. The rest are made up, by a seeded generator so they are the same on every run, because
 * a demo of three people over a week cannot show what the tab has to get right: three years counted by the
 * month, more people than the stack has colours and more than the list shows at first, two the graph
 * colours alike, a spelling the rule folds, a group made by hand, someone in two groups, someone who only
 * merges, a name in another script, and a name that is markup.
 */
{
  const everything = describeScope({ refs: null, search: null, authors: 0, dates: null, firstParent: false, onlyHere: false });
  const facts = (scope, extra = {}) => ({ truncated: false, limit: 250_000, scope, dated: false, ...extra });

  // Park-Miller: small, seeded, and the same numbers on every machine.
  let seed = 20_260_115;
  const random = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;

  /** `count` commits by `author`, on days spread over `span` days from `from` days after 2 January 2023. */
  const madeUp = (author, count, span, from = 0) =>
    Array.from({ length: count }, () => {
      const day = new Date(Date.UTC(2023, 0, 2 + from + Math.floor(random() * span)));
      return { author, authorDate: `${day.toISOString().slice(0, 10)}T12:00:00+08:00` };
    });

  /** The same, as merges: two parents each, which is all that makes a commit one. */
  const madeUpMerges = (author, count, span, from = 0) =>
    madeUp(author, count, span, from).map((commit) => ({ ...commit, parents: ['1'.repeat(40), '2'.repeat(40)] }));

  /** The same again, as the release commits a build writes: named for their day. */
  const madeUpReleases = (author, count, span, from = 0) =>
    madeUp(author, count, span, from).map((commit) => ({ ...commit, subject: `release [${commit.authorDate.slice(0, 10)}]` }));

  // Two names the graph colours alike, found rather than written down, so a change to the hash cannot
  // quietly give them different colours and leave the clash untested.
  const pool = Array.from({ length: 60 }, (_, i) => `Contributor ${i}`);
  const alike = pool.find((name) => pool.some((other) => other !== name && authorHue(other) === authorHue(name)));
  const alsoAlike = pool.find((name) => name !== alike && authorHue(name) === authorHue(alike));

  const long = [
    ...madeUp('Ada Fischer', 420, 1095),
    ...madeUpMerges('Ada Fischer', 60, 1095),
    ...madeUp('Nils Berg', 300, 1095),
    ...madeUp('Rui Santos', 260, 900, 150),
    ...madeUp(alike, 240, 1095),
    ...madeUp(alsoAlike, 200, 1095),
    ...madeUp('Sean Lin', 110, 1095),
    ...madeUp('sean_lin', 70, 600, 400),
    ...madeUp('Lineric', 90, 1095),
    ...madeUp('lineric_lin', 60, 1095),
    ...madeUp('Bo Wang', 120, 700),
    ...madeUp('陳大文', 80, 1095),
    ...madeUp('<b>not bold</b>', 40, 1095),
    ...madeUpMerges('Mia Merger', 90, 1095),
    // More people than the stack has colours, and more than the list shows before Show all.
    ...Array.from({ length: 48 }, (_, i) => madeUp(`Occasional ${String(i).padStart(2, '0')}`, 1 + (i % 7), 1095)).flat(),
  ];

  const groups = new Map([
    ['Lineric', ['Eric']],
    ['lineric_lin', ['Eric']],
    ['Nils Berg', ['Backend']],
    ['Rui Santos', ['Release']],
    ['Bo Wang', ['Backend', 'Release']],
  ]);

  /**
   * Made-up commits summarized each way, with what is in them counted straight off them: a commit a rule
   * matches is excluded, merge or not, and a merge is a merge only when no rule matched it.
   */
  const scenario = (commits, custom, walkFacts, rules = []) => {
    const patterns = rules.map((rule) => new RegExp(rule));
    const tally = new CommitTally(patterns);
    tally.add(commits);

    const isExcluded = (commit) => commit.subject !== undefined && patterns.some((pattern) => pattern.test(commit.subject));
    const excluded = commits.filter(isExcluded).length;
    const merges = commits.filter((commit) => !isExcluded(commit) && (commit.parents?.length ?? 0) > 1).length;

    return {
      summary: summarize(tally, custom, walkFacts),
      withMerges: summarize(tally, custom, walkFacts, { merges: true }),
      withExcluded: summarize(tally, custom, walkFacts, { excluded: true }),
      expected: { commits: commits.length - merges - excluded, merges, excluded },
    };
  };

  const threeYears = scenario(long, groups, facts(everything));
  const fortyDays = scenario(
    [...madeUp('Ada Fischer', 30, 40, 500), ...madeUp('Nils Berg', 12, 40, 500)],
    new Map(),
    facts('main · from 2024-05-16'),
  );
  const one = scenario([{ author: 'Ada Fischer', authorDate: '2026-01-14T09:30:00+01:00' }], new Map(), facts('main'));
  const nothing = scenario([], new Map(), facts('no branch ticked'));
  const stopped = scenario(
    madeUp('Ada Fischer', 25, 200),
    new Map(),
    facts('every branch and tag · from 2023-03-01', { truncated: true, limit: 25, dated: true }),
  );

  // Release commits among ordinary ones, one of them a merge, with a rule for them and one that cannot be read.
  const released = scenario(
    [
      ...madeUp('Ada Fischer', 30, 120),
      ...madeUpReleases('Ada Fischer', 20, 120),
      ...madeUpReleases('Rel Bot', 15, 120),
      ...madeUpReleases('Nils Berg', 1, 120).map((commit) => ({ ...commit, parents: ['1'.repeat(40), '2'.repeat(40)] })),
      ...madeUp('Nils Berg', 12, 120),
    ],
    new Map(),
    facts('main', { excludeRules: ['^release \\['], unreadableRules: ['['] }),
    ['^release \\['],
  );

  const summaries = {
    walk: summarize(walkTally, new Map(), facts(everything, { truncated: loader.rowCount >= maxCommits, limit: maxCommits })),
    long: threeYears.summary,
    longWithMerges: threeYears.withMerges,
    fortyDays: fortyDays.summary,
    one: one.summary,
    nothing: nothing.summary,
    stopped: stopped.summary,
    released: released.summary,
    releasedWithExcluded: released.withExcluded,
  };

  const expected = {
    walk: { commits: loader.rowCount - walkMerges, merges: walkMerges },
    long: threeYears.expected,
    fortyDays: fortyDays.expected,
    one: one.expected,
    stopped: stopped.expected,
    released: released.expected,
  };

  // Into a script element, where a `<` in somebody's name must not be taken for markup.
  const inline = (value) => JSON.stringify(value).replaceAll('<', '\\u003c');

  writeFileSync(
    'dist/stats-preview.html',
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Weft statistics preview</title>
<style>:root {\n${vars}\n}</style>
<link href="style.css" rel="stylesheet">
</head>
<body class="weft-stats ${light ? 'vscode-light' : 'vscode-dark'}">
${STATS_MARKUP}
<script>
  const sent = window.__sent = [];
  window.__stats = ${inline(summaries)};
  window.__expected = ${inline(expected)};
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => {
      sent.push(m);
      if (m.type === 'ready') {
        window.postMessage({ type: 'init', repoName: ${inline(repo.root.split('/').pop())} }, '*');
        window.postMessage({ type: 'summary', summary: window.__stats.walk }, '*');
      }
    },
    getState: () => window.__state,
    setState: (state) => { window.__state = state; },
  });
</script>
<script src="stats.js"></script>
</body>
</html>`,
  );

  console.log(`dist/stats-preview.html  <- the walk, and ${long.length} made-up commits over three years among the rest`);
}

/*
 * The interactive rebase editor's page, beside the other two.
 *
 * Fed the way the editor feeds it: a todo file as git writes one, read back by `parseTodo` and summed up
 * by `describeTodo`, its commits filled in with the subjects and authors of real commits from this
 * repository - the same shape `rebaseEditor.send` posts, built by the same two functions.
 *
 * One commit at the end is made up, and its subject carries markup and quotes on purpose: the page
 * promises that subjects and names only ever go in as text, and a promise about other people's
 * keyboards needs something from one.
 */
{
  const recent = messages.flatMap((message) => (message.type === 'page' ? message.rows : [])).slice(0, 7);
  const actions = ['pick', 'squash', 'pick', 'drop', 'reword', 'fixup', 'edit'];
  const written = [
    ...recent.map((row, at) => ({
      sha: row.sha.slice(0, 7),
      action: actions[at] ?? 'pick',
      subject: row.subject,
      author: row.author,
    })),
    {
      sha: 'beef123',
      action: 'pick',
      subject: 'Fix <b>the</b> total & "half" of it <script>alert(1)</script>',
      author: 'A. Person <someone@example.invalid>',
    },
  ];

  // As git writes it: the commands, a blank line, and the comments it puts underneath, one of which is onto.
  const file = [
    ...written.map((row) => `${row.action} ${row.sha} ${row.subject}`),
    '',
    `# Rebase ${written.at(-1).sha}..${written[0].sha} onto ${written.at(-1).sha} (${written.length} commands)`,
    '#',
    '# Commands:',
    '# p, pick <commit> = use commit',
  ].join('\n');

  const lines = parseTodo(file);
  const known = new Map(written.map((row) => [row.sha, row]));
  const todo = {
    type: 'todo',
    rows: lines
      .filter((line) => line.kind === 'commit')
      .map((line) => ({
        sha: line.sha,
        action: line.action,
        subject: known.get(line.sha)?.subject ?? line.rest,
        author: known.get(line.sha)?.author ?? '',
      })),
    summary: describeTodo(lines),
    onto: /^#\s*(Rebase\s.*)$/m.exec(file)?.[1] ?? '',
  };

  // Into a script element, where a `<` in somebody's subject must not be taken for markup.
  const inline = (value) => JSON.stringify(value).replaceAll('<', '\\u003c');

  writeFileSync(
    'dist/rebase-preview.html',
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Weft interactive rebase preview</title>
<style>:root {\n${vars}\n}</style>
<link href="style.css" rel="stylesheet">
</head>
<body class="weft-rebase ${light ? 'vscode-light' : 'vscode-dark'}">
${REBASE_MARKUP}
<script>
  const sent = window.__sent = [];
  window.__todo = ${inline(todo)};
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => {
      sent.push(m);
      // The host answers a ready with the file as it stands, and answers nothing else by itself: what a
      // change comes back as is the probe's to say, because that is the part this page does not decide.
      if (m.type === 'ready') window.postMessage(window.__todo, '*');
    },
  });
</script>
<script src="rebase.js"></script>
</body>
</html>`,
  );

  console.log(`dist/rebase-preview.html  <- ${todo.rows.length} commits as a todo git could have written`);
}
