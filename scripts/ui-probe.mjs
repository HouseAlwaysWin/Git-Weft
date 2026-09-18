/**
 * The UI probe: drive the webview in headless Chrome, and record what it builds and what it sends.
 *
 * The view's HTML is generated, and generated HTML is exactly what a refactor of the code that
 * generates it can quietly change. So is what a click asks the host to do, which no amount of
 * looking at the page shows: the host owns most of the state, and in this harness nothing on screen
 * moves when a filter is asked for. The probe records both, as sections of text two builds can be
 * compared by - for the graph's page, then for the statistics tab's, whose sections are headed `stats: `.
 *
 *   node scripts/ui-probe.mjs print                 the recording, to stdout
 *   node scripts/ui-probe.mjs save <name>           ...to .ui-probe/<name>.txt
 *   node scripts/ui-probe.mjs check <name>          record again, compare with what was saved
 *   node scripts/ui-probe.mjs stable [n]            record n times (3 by default), require them identical
 *   node scripts/ui-probe.mjs assert                hold the recording to the invariants below (npm test)
 *   node scripts/ui-probe.mjs control <spec.mjs>    put bugs back one at a time, require each is caught
 *
 *   --repo <dir>       record against this repository instead of a freshly built demo
 *   --chrome <path>    Chrome to use (or WEFT_CHROME); without one this stops, it does not pass
 *
 * It lived in a session's scratch directory for most of its life, and each of the ways it was wrong
 * there is now a rule in here or in page.js: frames come from a timer, because headless Chrome stops
 * running animation frames once a page idles and the recording froze at its first state; recordings
 * are written by Node, because PowerShell added a byte-order mark and CRLF and every comparison came
 * out unequal; a control restores the file before it decides anything, because `process.exit()`
 * inside a `try` skips the `finally` that restores it, which once shipped a fix that was not in the
 * commit; and a control whose break does not build says so, instead of checking yesterday's bundle.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { serveDist } from './serve.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');
const STORE = join(ROOT, '.ui-probe');
const PAGE_SCRIPT = join(ROOT, 'scripts', 'ui-probe', 'page.js');
const PAGE = 'ui-probe.html';
const STATS_SCRIPT = join(ROOT, 'scripts', 'ui-probe', 'stats.js');
const STATS_PAGE = 'ui-probe-stats.html';
const REBASE_SCRIPT = join(ROOT, 'scripts', 'ui-probe', 'rebase.js');
const REBASE_PAGE = 'ui-probe-rebase.html';

/** Stops the run with an exit code - by throwing, so every `finally` on the way out still runs. */
class Stop extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new Stop(code, message);
};

const argv = process.argv.slice(2);

function option(name) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

const positional = argv.filter((arg, at) => !arg.startsWith('--') && !(at > 0 && argv[at - 1]?.startsWith('--')));
const [command, subject] = positional;

/** Run a program to completion without throwing, whatever it exits with. */
function run(file, args, options = {}) {
  return new Promise((done) => {
    execFile(
      file,
      args,
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
      },
    );
  });
}

const tail = (text, lines = 3) => text.trim().split('\n').slice(-lines).join(' | ');

/**
 * Build, and refuse a stale bundle.
 *
 * Asynchronous like everything here that spawns: the server answering Chrome lives on this event
 * loop, and a synchronous spawn would stop it answering the request Chrome is waiting on.
 */
async function build() {
  const built = await run(process.execPath, ['esbuild.mjs']);

  if (built.code !== 0) {
    return { ok: false, why: `the build failed: ${tail(built.stderr || built.stdout)}` };
  }

  const bundle = statSync(join(DIST, 'main.js'), { throwIfNoEntry: false });

  if (bundle === undefined) {
    return { ok: false, why: 'dist/main.js is missing after the build' };
  }

  const newest = readdirSync(join(ROOT, 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => statSync(join(entry.parentPath, entry.name)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);

  return newest > bundle.mtimeMs ? { ok: false, why: 'dist/main.js is older than src/ after the build' } : { ok: true };
}

let demo = null;

/** The repository recorded against: the one named, or a demo built once per run - fixed dates, fixed names. */
async function repository() {
  const named = option('--repo');

  if (named !== undefined) {
    return resolve(named);
  }

  if (demo === null) {
    const dir = join(tmpdir(), 'weft-ui-probe-demo');
    const made = await run(process.execPath, ['scripts/make-demo.mjs', dir]);

    if (made.code !== 0) {
      fail(2, `the demo repository could not be built: ${tail(made.stderr || made.stdout)}`);
    }

    demo = dir;
  }

  return demo;
}

/*
 * Two shims, ahead of main.js.
 *
 * Frames from a timer: headless Chrome stops running animation frames once the page goes idle, and
 * the view repaints from one - so `schedule()`'s pending flag latched on and every repaint after the
 * first was dropped, and the recording showed the first state for ever, which compares as "nothing
 * changed" against anything.
 *
 * A fixed clock: branch ages and "fetched 12m ago" are computed from now, so a recording made
 * tomorrow would differ from today's for no reason in the code.
 *
 * And a record of anything thrown from the start, main.js's own loading included.
 */
const SHIMS = `<script>
window.requestAnimationFrame = (fn) => window.setTimeout(() => fn(performance.now()), 0);
(() => {
  const FIXED = Date.UTC(2026, 0, 15, 12, 0, 0);
  const Real = Date;
  function Frozen(...args) {
    if (!new.target) return new Real(FIXED).toString();
    return args.length === 0 ? new Real(FIXED) : new Real(...args);
  }
  Frozen.prototype = Real.prototype;
  Frozen.now = () => FIXED;
  Frozen.parse = Real.parse;
  Frozen.UTC = Real.UTC;
  window.Date = Frozen;
})();
window.__thrown = [];
window.addEventListener('error', (e) => window.__thrown.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__thrown.push('rejected: ' + String(e.reason)));
</script>
`;

/** Regenerate the preview from the repository, and put the probe into a copy of it. */
async function writePage() {
  const made = await run(process.execPath, ['scripts/preview.mjs', await repository()]);

  if (made.code !== 0) {
    fail(2, `scripts/preview.mjs failed: ${tail(made.stderr || made.stdout)}`);
  }

  const source = readFileSync(join(DIST, 'preview.html'), 'utf8');

  if (!source.includes('</head>') || !source.includes('</body>')) {
    fail(2, 'dist/preview.html is not the shape the probe expects');
  }

  // LF, whatever the checkout wrote: a CR in the source is a CR in the dump.
  const script = readFileSync(PAGE_SCRIPT, 'utf8').replaceAll('\r\n', '\n');

  if (script.toLowerCase().includes('</script')) {
    fail(2, 'page.js contains "</script", which would end the tag it is put inside');
  }

  // Replacer functions, so a `$&` or `$1` inside the script is text rather than a pattern.
  writeFileSync(
    join(DIST, PAGE),
    source.replace('</head>', () => `${SHIMS}</head>`).replace('</body>', () => `<script>\n${script}\n</script>\n</body>`),
  );

  // And the statistics tab's page, which preview.mjs writes beside it, with a script of its own.
  const statsSource = readFileSync(join(DIST, 'stats-preview.html'), 'utf8');
  const statsScript = readFileSync(STATS_SCRIPT, 'utf8').replaceAll('\r\n', '\n');

  if (!statsSource.includes('</head>') || !statsSource.includes('</body>')) {
    fail(2, 'dist/stats-preview.html is not the shape the probe expects');
  }

  if (statsScript.toLowerCase().includes('</script')) {
    fail(2, 'stats.js contains "</script", which would end the tag it is put inside');
  }

  writeFileSync(
    join(DIST, STATS_PAGE),
    statsSource
      .replace('</head>', () => `${SHIMS}</head>`)
      .replace('</body>', () => `<script>\n${statsScript}\n</script>\n</body>`),
  );

  // And the rebase editor's, which had no page here at all - see the invariants headed `rebase: `.
  const rebaseSource = readFileSync(join(DIST, 'rebase-preview.html'), 'utf8');
  const rebaseScript = readFileSync(REBASE_SCRIPT, 'utf8').replaceAll('\r\n', '\n');

  if (!rebaseSource.includes('</head>') || !rebaseSource.includes('</body>')) {
    fail(2, 'dist/rebase-preview.html is not the shape the probe expects');
  }

  if (rebaseScript.toLowerCase().includes('</script')) {
    fail(2, 'rebase.js contains "</script", which would end the tag it is put inside');
  }

  writeFileSync(
    join(DIST, REBASE_PAGE),
    rebaseSource
      .replace('</head>', () => `${SHIMS}</head>`)
      .replace('</body>', () => `<script>\n${rebaseScript}\n</script>\n</body>`),
  );
}

function chromePath() {
  const named = option('--chrome') ?? process.env.WEFT_CHROME;
  const candidates =
    named !== undefined
      ? [named]
      : process.platform === 'win32'
        ? [
            'C:/Program Files/Google/Chrome/Application/chrome.exe',
            'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
          ]
        : process.platform === 'darwin'
          ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
          : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

  const found = candidates.find((path) => existsSync(path));

  if (found === undefined) {
    // Loud rather than skipped: a probe that quietly does not run is a guard that quietly is not one.
    fail(2, `no Chrome found (tried ${candidates.join(', ')}) - pass --chrome <path> or set WEFT_CHROME`);
  }

  return found;
}

/**
 * One recording of the pages as they are served now: the graph's, then the statistics tab's, then the
 * rebase editor's, as one text. The other two head their sections `stats: ` and `rebase: `, so no two
 * pages ever share a name.
 */
async function record(port) {
  await writePage();
  return [
    await recordPage(port, PAGE),
    await recordPage(port, STATS_PAGE),
    await recordPage(port, REBASE_PAGE),
  ].join('\n\n');
}

/** One page, loaded in headless Chrome until it has written its recording. */
async function recordPage(port, page) {
  const result = await run(chromePath(), [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${join(tmpdir(), 'weft-ui-probe-chrome')}`,
    '--virtual-time-budget=60000',
    '--window-size=1400,800',
    '--dump-dom',
    `http://127.0.0.1:${port}/${page}`,
  ]);

  /*
   * The last occurrence, not the first. page.js goes into the page as source, so any mention of this
   * tag in its text is in the dump too, ahead of the element it appends at the very end - and the
   * first version of this matched a comment, and read the script's own source as the recording.
   */
  const OPEN = '<pre id="ui-probe">';
  const start = result.stdout.lastIndexOf(OPEN);
  const end = start < 0 ? -1 : result.stdout.indexOf('</pre>', start);

  if (start < 0 || end < 0) {
    fail(1, `${page} never wrote its recording${result.stderr ? `: ${tail(result.stderr, 2)}` : ''}`);
  }

  return result.stdout
    .slice(start + OPEN.length, end)
    .replaceAll('\r\n', '\n')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

export function sections(text) {
  const found = {};
  let current = null;

  for (const line of text.split('\n')) {
    if (line.startsWith('=== ')) {
      current = line;
      found[current] = '';
    } else if (current !== null) {
      found[current] += `${line}\n`;
    }
  }

  return found;
}

export function differing(a, b) {
  const left = sections(a);
  const right = sections(b);

  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((key) => left[key] !== right[key]);
}

/** The messages a "... sends" section recorded, one JSON object per line. */
function sentIn(found, name) {
  const text = found[`=== ${name} ===`];

  if (text === undefined) {
    return null;
  }

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { unparsed: line };
      }
    });
}

const describe = (messages) =>
  messages === null ? 'no such section' : messages.length === 0 ? 'nothing' : messages.map((m) => m.type + (m.id ? ` ${m.id}` : '')).join(', ');

/** The statistics scenarios drawn from a summary, as the page's script names them. */
const DRAWN = ['walk', 'long', 'fortyDays', 'one', 'stopped', 'released'];

/** A statistics section's lines. */
const statsLines = (found, name) => (found[`=== stats: ${name} ===`] ?? '').split('\n').filter((line) => line.length > 0);

/** What a statistics section said after `key: `, or null when it said nothing of the kind. */
function statsSaid(found, name, key) {
  const line = statsLines(found, name).find((entry) => entry.startsWith(`${key}: `));
  return line === undefined ? null : line.slice(key.length + 2);
}

/** A count as the statistics page says one: "1 merge", "2,314 commits". */
const counting = (count, noun) => `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;

/** What the statistics page's script expects of a scenario: the commits and the merges that went in. */
function statsExpected(found, name) {
  const line = statsLines(found, 'expected').find((entry) => entry.startsWith(`${name}: `)) ?? '';
  const counts = /: commits=(\d+) merges=(\d+) excluded=(\d+)$/.exec(line);
  return counts === null ? null : { commits: Number(counts[1]), merges: Number(counts[2]), excluded: Number(counts[3]) };
}

/** The rows of the people chart: the name, the two counts, and every `key=value` cell by its key. */
function statsPeople(found, name) {
  return statsLines(found, name)
    .filter((line) => line.startsWith('person: '))
    .map((line) => {
      const cells = line.slice('person: '.length).split(' | ');
      const keyed = cells
        .filter((cell) => /^\w+=/.test(cell))
        .map((cell) => [cell.slice(0, cell.indexOf('=')), cell.slice(cell.indexOf('=') + 1)]);

      return { name: cells[0], commits: cells[1], merges: cells[2], ...Object.fromEntries(keyed) };
    });
}

/** The stacked chart's bars, as the statistics page's script wrote them down. */
function statsBars(found, name) {
  const sum = (text) => text.split('+').filter((n) => n.length > 0).reduce((total, n) => total + Number(n), 0);

  return statsLines(found, name)
    .filter((line) => line.startsWith('bar '))
    .map((line) => {
      const bar = /^bar \S+: total=(\d+|\?) counts=([\d+?]*) pieces=([\d+]*) who=(.*)$/.exec(line);

      return bar === null
        ? { line, total: NaN, counts: NaN, pixels: NaN, who: [] }
        : {
            line,
            total: Number(bar[1]),
            counts: sum(bar[2]),
            pixels: sum(bar[3]),
            who: bar[4].split(',').map((piece) => ({
              name: piece.slice(0, piece.lastIndexOf('@')),
              hue: piece.slice(piece.lastIndexOf('@') + 1),
            })),
          };
    });
}

/*
 * What must hold in every recording, whatever else changes.
 *
 * Each of these was a bug in a shipped build, and each would pass a plain before/after comparison
 * made on the build that had it - which is the reason they are held here, and not left to a diff.
 */
const INVARIANTS = [
  [
    'a branch name in the dropdown filters, and never checks out',
    (found) => {
      const sent = sentIn(found, 'clicking a branch name sends');
      return sent !== null && sent.length > 0 && sent.every((m) => m.type === 'setRefsVisible') ? null : `sent ${describe(sent)}`;
    },
  ],
  [
    'the name and its tick send the same thing',
    (found) => {
      const name = JSON.stringify(sentIn(found, 'clicking a branch name sends'));
      const tick = JSON.stringify(sentIn(found, 'clicking the row tick sends'));
      return name === tick ? null : `name sent ${name}, tick sent ${tick}`;
    },
  ],
  [
    'the remote row of the branch you are on filters too',
    (found) => {
      const sent = sentIn(found, 'clicking the remote row of the branch you are on sends');
      const ok =
        sent !== null &&
        sent.length > 0 &&
        sent.every((m) => m.type === 'setRefsVisible') &&
        sent.some((m) => (m.refNames ?? []).includes('refs/remotes/origin/main'));
      return ok ? null : `sent ${describe(sent)}`;
    },
  ],
  [
    'the quick-switch box is what switches branch',
    (found) => {
      const sent = sentIn(found, 'clicking a quick-switch row sends');
      const ok = sent !== null && sent.length === 1 && sent[0].type === 'runAction' && sent[0].id === 'weft.checkoutBranch';
      return ok ? null : `sent ${describe(sent)}`;
    },
  ],
  [
    'Drawn says what is drawn while the menu is still open',
    (found) => {
      const open = found['=== is the menu still open ==='] ?? '';
      const lines = (found['=== after ticking a row, with the menu still open ==='] ?? '').split('\n');
      const quiet = lines.findIndex((line) => line.endsWith('origin/quiet'));
      const local = lines.findIndex((line) => line.startsWith('(group) ') && line.includes('Local'));

      if (!open.includes('hidden=false')) {
        return 'the menu was not open, so this proves nothing';
      }

      return lines[0]?.includes('Drawn7') && quiet > 0 && quiet < local
        ? null
        : `the ticked row was not in Drawn: ${lines.slice(0, 9).join(' / ')}`;
    },
  ],
  [
    'the search marks follow the mode',
    (found) =>
      /<span class="subject"[^>]*>[^<]*<span class="hit">/.test(found['=== rows marked on author ==='] ?? '')
        ? 'author mode still marks the subject'
        : null,
  ],
  [
    'the case switch says what it does once the lock comes off',
    (found) => {
      const line = (found['=== toggles after following is switched off ==='] ?? '')
        .split('\n')
        .find((entry) => entry.startsWith('caseSensitive '));
      return line !== undefined && line.endsWith(' Match case') ? null : `it reads: ${line ?? 'no such section'}`;
    },
  ],
  [
    'a preset chip draws its preset, and Save asks the host',
    (found) => {
      const said = found['=== clicking a preset, then Save, sends ==='] ?? '';
      return said.includes('"type":"applyRefsPreset","name":"release work"') && said.includes('"type":"saveRefsPreset"')
        ? null
        : `it sent: ${said.trim() || 'nothing'}`;
    },
  ],
  [
    'branch folders start closed, and open when asked',
    (found) => {
      const closed = found['=== branch folders, closed ==='] ?? '';
      const opened = found['=== branch folders, one opened ==='] ?? '';
      const folded = /^\(folder\) .*Dev_/m.test(closed) && closed.includes('[ ] Fix_c');
      const shut = !/^\[ \] a$/m.test(closed);
      const shown = /^\[ \] a$/m.test(opened) && /^\[ \] b$/m.test(opened);

      return folded && shut && shown ? null : `closed: ${closed.split('\n').join(' / ')} | opened: ${opened.split('\n').join(' / ')}`;
    },
  ],
  [
    'a branch is compared by its name, and the answer is headed with the names',
    (found) => {
      const offered = (found['=== a branch badge menu ==='] ?? '').includes('>Select for Compare<');
      const asked = (sentIn(found, 'comparing a row with the marked branch sends') ?? []).find((m) => m.type === 'compare');
      const marked = found['=== mark: a branch selected ==='] ?? '';
      const mark = found['=== mark: a comparison ==='] ?? '';
      const pane = found['=== pane: a comparison ==='] ?? '';

      if (!offered) {
        return 'the menu on a branch badge did not offer Select for Compare';
      }

      // By its full name, so it is the branch as it is when the comparison runs - not the commit it was on.
      if (asked === undefined || asked.from?.rev !== `refs/heads/${asked.from?.label}`) {
        return `it asked about ${JSON.stringify(asked?.from ?? null)}, not a branch by its name`;
      }

      if (!marked.includes(`text="compare from ${asked.from.label}"`) || !mark.includes('text="main → origin/uat"')) {
        return `the mark read ${marked.slice(marked.indexOf(' text=') + 1).trim()}, then ${mark.slice(mark.indexOf(' text=') + 1).trim()}`;
      }

      if (!pane.includes('>main<') || !pane.includes('>origin/uat<') || !pane.includes('only on main')) {
        return `the pane read: ${pane.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}`;
      }

      // The pane's own Escape comes after this, and would only ever drop the comparison if it were still up.
      return (found['=== mark: dropped by Escape ==='] ?? '').includes('hidden=true') ? null : 'Escape left the comparison up';
    },
  ],
  [
    'a comparison lists each side, and draws the end the graph is not drawing',
    (found) => {
      const listed = found['=== comparison commits ==='] ?? '';
      const sent = sentIn(found, 'drawing the undrawn end of a comparison sends');
      const ok =
        listed.includes('Only on origin/uat - the newest 2 of 250') &&
        listed.includes('the newest on uat') &&
        sent !== null &&
        sent.length === 1 &&
        sent[0].type === 'setRefsVisible' &&
        JSON.stringify(sent[0].refNames) === JSON.stringify(['refs/remotes/origin/uat']);

      return ok ? null : `listed: ${listed.split('\n').join(' / ')} | sent ${describe(sent)}`;
    },
  ],
  [
    'a ticket id in a commit message opens by its text, clicked or from the keyboard',
    (found) => {
      const marked = (found['=== ticket links ==='] ?? '').match(/class="ticket"/g) ?? [];
      const sent = sentIn(found, 'opening ticket ids sends');
      const ok =
        marked.length === 2 &&
        JSON.stringify(sent) ===
          JSON.stringify([
            { type: 'openTicket', text: 'ERP-10147' },
            { type: 'openTicket', text: 'ERP-2' },
          ]);

      return ok ? null : `marked ${marked.length} of 2, sent ${JSON.stringify(sent)}`;
    },
  ],
  [
    'a badge is drawn whole, and the subject is what gives way',
    (found) => {
      const lines = (found['=== what was cut short ==='] ?? '').trim().split('\n');
      const value = (name) => lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
      const subjects = /^(\d+) of (\d+)$/.exec(value('subjects cut') ?? '');
      const ok =
        // Not one of them, including the long one the preview tags a row with on purpose.
        value('badges cut') === '[]' &&
        subjects !== null &&
        Number(subjects[2]) > 0 &&
        // And something did give way, or the page is too wide for any of this to mean anything.
        Number(subjects[1]) > 0;

      return ok ? null : lines.join(' / ');
    },
  ],
  [
    'a row the came-from filter kept says which branch it came from, and how',
    (found) => {
      const badges = (found['=== came-from badges ==='] ?? '').trim().split('\n');
      const ok =
        badges.length === 2 &&
        // The class carries which of the two it is, and the text says it in words beside the branch.
        badges[0] === 'ref came-from merge | merged uat | A merge that took uat into another branc' &&
        badges[1] ===
          'ref came-from copy | copied uat_deploy_2026_holding_branch | The same change as a commit on uat_deplo';

      return ok ? null : badges.join(' / ');
    },
  ],
  [
    'the merges-from box completes the name being typed, from the branches there are',
    (found) => {
      const lines = (found['=== merges from ==='] ?? '').trim().split('\n');
      const value = (name) => lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
      const offered = JSON.parse(value('offered for "uat, t"') ?? 'null');
      const ok =
        // Both branches with a `t` in them, and not `main`, which is the other one there is.
        JSON.stringify(offered) === JSON.stringify(['feat/columnar-store']) &&
        // The arrow moves the pick without changing what is offered.
        JSON.stringify(JSON.parse(value('after an arrow') ?? 'null')) === JSON.stringify(offered) &&
        // Return completes the name being typed and leaves the rest of the list alone.
        value('completed to') === '"uat, feat/columnar-store"' &&
        (value('and asked') ?? '').includes('"branches":["uat","feat/columnar-store"]') &&
        value('list after') === 'hidden=true' &&
        value('offered for nothing') === '[]';

      return ok ? null : lines.join(' / ');
    },
  ],
  [
    'the merges-from switch shows its box, fills it in, and asks for those branches',
    (found) => {
      const lines = (found['=== merges from ==='] ?? '').trim().split('\n');
      const value = (name) => lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
      const asked = (name) => {
        try {
          return JSON.parse(value(name) ?? 'null');
        } catch {
          return null;
        }
      };
      const ok =
        value('box hidden before') === 'true' &&
        value('box hidden after') === 'false' &&
        // Empty, and nothing asked for: the graph on screen is already the one an empty filter draws.
        value('box holds') === '""' &&
        (value('switch') ?? '').includes('on') &&
        value('asked') === '' &&
        // Edited to something else, which is asked for - the same value again is not, and is checked below.
        JSON.stringify(asked('after editing')) === JSON.stringify({ type: 'mergesFrom', branches: ['uat'] }) &&
        // Off is the filter dropped, and the box keeps what it holds for the next time it is turned on.
        JSON.stringify(asked('off again')) === JSON.stringify({ type: 'mergesFrom', branches: [] }) &&
        value('box kept') === '"uat, sit"' &&
        // Asked for again after the host dropped its filters, though the page had asked for it before.
        JSON.stringify(asked('after clearing')) === JSON.stringify({ type: 'mergesFrom', branches: ['uat', 'sit'] });

      return ok ? null : lines.join(' / ');
    },
  ],
  [
    'a corrected weft.ticketLinks marks the commit that is already on screen',
    (found) => {
      const body = found['=== ticket links after the setting changed ==='] ?? '';
      const ids = [...body.matchAll(/title="Open ([^"]+)"/g)].map((match) => match[1]);

      // The patterns that arrived match the one id the first set did not: nothing was re-sent, only re-marked.
      return JSON.stringify(ids) === JSON.stringify(['XERP-3'])
        ? null
        : `marked ${JSON.stringify(ids)} rather than ["XERP-3"]`;
    },
  ],
  [
    'the rebase editor draws the file it was given, and nothing of it threw',
    (found) => {
      const lines = (found['=== rebase: the list as drawn ==='] ?? '').trim().split('\n');
      const thrown = (found['=== rebase: thrown ==='] ?? '').trim();
      const drawn = lines.filter((line) => line.startsWith('action='));
      const actions = drawn.map((line) => /^action=(\w+)/.exec(line)?.[1]);
      const ok =
        thrown === '(nothing)' &&
        lines[0]?.startsWith('onto: Rebase ') &&
        /^summary: \d+ commits?/.test(lines[1] ?? '') &&
        lines[2] === 'problem: hidden=true' &&
        JSON.stringify(actions) ===
          JSON.stringify(['pick', 'squash', 'pick', 'drop', 'reword', 'fixup', 'edit', 'pick']) &&
        drawn.every((line) => /sha=[0-9a-f]{7} /.test(line) && !/subject="" /.test(line)) &&
        drawn[1]?.includes('class="rebase-row rebase-squash"');

      return ok ? null : `thrown ${thrown} | ${lines.slice(0, 3).join(' / ')} | ${JSON.stringify(actions)}`;
    },
  ],
  [
    'every action the rebase editor offers says what it does',
    (found) => {
      const offered = (found['=== rebase: what a row can be ==='] ?? '').trim().split('\n');
      const ok =
        offered.length === 6 &&
        JSON.stringify(offered.map((line) => line.split(':')[0])) ===
          JSON.stringify(['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']) &&
        offered.every((line) => / - \w/.test(line));

      return ok ? null : `offered ${JSON.stringify(offered)}`;
    },
  ],
  [
    'a subject in the rebase editor is text, whatever it looks like',
    (found) => {
      const said = (found['=== rebase: a subject with markup in it ==='] ?? '').trim().split('\n');
      const ok =
        said[0]?.includes('<b>the</b>') &&
        said[1] === 'elements: 0' &&
        (said[2] ?? '').includes('&lt;b&gt;') &&
        !(said[2] ?? '').includes('<b>');

      return ok ? null : said.join(' / ');
    },
  ],
  [
    'the rebase editor sends a change by the commit it is on',
    (found) => {
      const action = sentIn(found, 'rebase: changing an action sends');
      const moves = sentIn(found, 'rebase: the move buttons send');
      const keys = sentIn(found, 'rebase: the keyboard sends');
      const ok =
        JSON.stringify(action) === JSON.stringify([{ type: 'action', at: 2, action: 'fixup' }]) &&
        JSON.stringify(moves) ===
          JSON.stringify([
            { type: 'move', at: 1, by: 1 },
            { type: 'move', at: 3, by: -1 },
          ]) &&
        // Alt and an arrow move the commit; the same arrow without it belongs to the list and sends nothing.
        JSON.stringify(keys) === JSON.stringify([{ type: 'move', at: 4, by: -1 }]);

      return ok ? null : `action ${JSON.stringify(action)} | moves ${JSON.stringify(moves)} | keys ${JSON.stringify(keys)}`;
    },
  ],
  [
    'the keyboard follows the commit that moved, not the place it left',
    (found) => {
      const said = (found['=== rebase: after the list came back ==='] ?? '').trim().split('\n');
      const value = (name) => said.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
      const ok =
        value('focus row') === '3' &&
        value('focus class') === 'rebase-action' &&
        value('sha there') === value('sha that moved');

      return ok ? null : said.join(' / ');
    },
  ],
  [
    'a rebase change that could not be written is said where the buttons are',
    (found) => {
      const said = (found['=== rebase: a write that failed ==='] ?? '').trim().split('\n');
      const after = (found['=== rebase: and the list after it ==='] ?? '').trim();
      const ok =
        said[0] === 'problem: hidden=false' &&
        (said[1] ?? '').includes('could not be written') &&
        after === 'problem: hidden=true';

      return ok ? null : `${said.join(' / ')} | after: ${after}`;
    },
  ],
  [
    'Start Rebase and Abort ask for what they say',
    (found) => {
      const sent = sentIn(found, 'rebase: the buttons send');
      const ok = JSON.stringify(sent) === JSON.stringify([{ type: 'start' }, { type: 'abort' }]);

      return ok ? null : JSON.stringify(sent);
    },
  ],
  [
    'the commit menu opens from the keyboard, and the keyboard works it',
    (found) => {
      const lines = (found['=== the commit menu from the keyboard ==='] ?? '').split('\n');
      const said = (name) => {
        const line = lines.find((entry) => entry.startsWith(`${name}: `));
        return line === undefined ? null : line.slice(name.length + 2);
      };
      let choosable = [];

      try {
        choosable = JSON.parse(said('choosable') ?? '[]');
      } catch {
        // Read as nothing, and failed below.
      }

      let around = [];

      try {
        around = JSON.parse(said('around the greyed-out one') ?? '[]');
      } catch {
        // Read as nothing, and failed below.
      }

      const column = said('column menu') ?? '(outside the menu)';
      const wrong = [
        said('asked') === '"commit"' ? null : `Shift+F10 asked for ${said('asked')}`,
        said('echo swallowed') === 'true' ? null : 'the contextmenu after Shift+F10 was left to VS Code',
        choosable.length > 2 && said('opened on') === choosable[0] ? null : `it opened on ${said('opened on')}`,
        said('end') === choosable.at(-1) && said('home') === choosable[0] ? null : `End and Home went to ${said('end')} and ${said('home')}`,
        around.length === 2 &&
        around[0] !== '' &&
        around[1] !== '' &&
        said('past the greyed-out one') === around[1] &&
        said('and back') === around[0]
          ? null
          : `the arrows went to ${said('past the greyed-out one')} and back to ${said('and back')}, around ${JSON.stringify(around)}`,
        /"type":"runAction".*"kind":"commit"/.test(said('chose') ?? '') ? null : `Enter sent ${said('chose') || 'nothing'}`,
        said('after choosing') === 'closed, focus outside' && said('after escape') === 'closed, focus outside'
          ? null
          : `after choosing: ${said('after choosing')}; after Escape: ${said('after escape')}`,
        column !== '(outside the menu)' && !column.includes('Description') && said('column menu after escape') === 'closed, focus outside'
          ? null
          : `the column menu went to ${column}, then ${said('column menu after escape')}`,
      ].filter((problem) => problem !== null);

      return wrong.length === 0 ? null : wrong.join('; ');
    },
  ],
  [
    'the statistics tab counts the commits it was handed, with the merges left out said',
    (found) => {
      const wrong = DRAWN.filter((name) => {
        const want = statsExpected(found, name);
        const leftOut =
          want === null
            ? []
            : [
                ...(want.merges > 0 ? [counting(want.merges, 'merge')] : []),
                ...(want.excluded > 0
                  ? [`${want.excluded.toLocaleString('en-US')} excluded ${want.excluded === 1 ? 'commit' : 'commits'}`]
                  : []),
              ];
        const said =
          want === null
            ? null
            : leftOut.length === 0
              ? counting(want.commits, 'commit')
              : `${counting(want.commits, 'commit')}${leftOut.length === 1 ? ' and' : ','} ${leftOut.join(' and ')} left out`;

        return said === null || !(statsSaid(found, name, 'scope') ?? '').startsWith(`${said}, as the graph walked them`);
      });

      if ((statsExpected(found, 'long')?.merges ?? 0) === 0 || (statsExpected(found, 'walk')?.merges ?? 0) === 0) {
        return 'the three years or the walk holds no merges, so leaving them out proves nothing';
      }

      return wrong.length === 0
        ? null
        : wrong.map((name) => `${name} said ${JSON.stringify(statsSaid(found, name, 'scope'))} of ${JSON.stringify(statsExpected(found, name))}`).join('; ');
    },
  ],
  [
    'Include merges asks for them, is remembered, and counts them in',
    (found) => {
      const want = statsExpected(found, 'long');
      const scope = statsSaid(found, 'merges switched on', 'scope') ?? '';

      if (want === null) {
        return 'nothing was expected of the three years';
      }

      const wrong = [
        statsSaid(found, 'merges switched on', 'sends') === '{"type":"includeMerges","on":true}'
          ? null
          : `it sent ${statsSaid(found, 'merges switched on', 'sends') || 'nothing'}`,
        /"includeMerges":true/.test(statsSaid(found, 'merges switched on', 'remembered') ?? '')
          ? null
          : `it remembered ${statsSaid(found, 'merges switched on', 'remembered')}`,
        scope.startsWith(
          `${counting(want.commits + want.merges, 'commit')}, ${counting(want.merges, 'merge')} among them, as the graph walked them`,
        )
          ? null
          : `it said ${JSON.stringify(scope)}`,
      ].filter((problem) => problem !== null);

      return wrong.length === 0 ? null : wrong.join('; ');
    },
  ],
  [
    'excluded commits have a switch only where there is a rule, and it asks, is remembered, and counts them in',
    (found) => {
      const want = statsExpected(found, 'released');
      const scope = statsSaid(found, 'excluded switched on', 'scope') ?? '';

      if (want === null || want.excluded === 0) {
        return 'the release scenario holds no excluded commits, so this proves nothing';
      }

      const shownWithoutRule = DRAWN.filter(
        (name) => name !== 'released' && !(statsSaid(found, name, 'excluded switch') ?? '').startsWith('hidden=true'),
      );
      const bot = statsPeople(found, 'released').find((person) => person.name === 'Rel Bot');
      const wrong = [
        ...shownWithoutRule.map((name) => `${name} shows the excluded switch with no rule`),
        (statsSaid(found, 'released', 'excluded switch') ?? '').startsWith('hidden=false')
          ? null
          : 'the release scenario hid the switch',
        statsSaid(found, 'excluded switched on', 'sends') === '{"type":"includeExcluded","on":true}'
          ? null
          : `it sent ${statsSaid(found, 'excluded switched on', 'sends') || 'nothing'}`,
        /"includeExcluded":true/.test(statsSaid(found, 'excluded switched on', 'remembered') ?? '')
          ? null
          : `it remembered ${statsSaid(found, 'excluded switched on', 'remembered')}`,
        scope.startsWith(
          `${counting(want.commits + want.excluded, 'commit')}, ${want.excluded.toLocaleString('en-US')} excluded commits among them, as the graph walked them`,
        )
          ? null
          : `it said ${JSON.stringify(scope)}`,
        (statsSaid(found, 'released', 'notes') ?? '').includes('"[" could not be used') ? null : 'the rule that cannot be used went unnamed',
        bot !== undefined && bot.commits === '0' && bot.excluded === '15 excluded' && bot.hue === '-'
          ? null
          : `the release bot's row read ${JSON.stringify(bot ?? null)}`,
      ].filter((problem) => problem !== null);

      return wrong.length === 0 ? null : wrong.slice(0, 3).join('; ');
    },
  ],
  [
    'a stacked bar is its pieces, to the commit and to the pixel',
    (found) => {
      const wrong = [];

      for (const name of DRAWN) {
        const scale = /^top=(\d+) plot=(\d+)$/.exec(statsSaid(found, name, 'stacked scale') ?? '');
        const bars = statsBars(found, name);

        if (scale === null || bars.length === 0) {
          wrong.push(`${name} has no stacked bars to hold`);
          continue;
        }

        const plot = Number(scale[2]);
        const top = Number(scale[1]);

        for (const bar of bars) {
          const height = Math.round(bar.total * (plot / top));

          if (bar.counts !== bar.total || bar.pixels !== height) {
            wrong.push(`${name}: ${bar.line.slice(0, 100)} - the bar is ${height}px of ${plot}px up to ${top}`);
          }
        }
      }

      return wrong.length === 0 ? null : wrong.slice(0, 3).join('; ');
    },
  ],
  [
    'side by side gives each band its own bar from the baseline, on a scale of the busiest one',
    (found) => {
      const scale = /^top=(\d+) plot=(\d+)$/.exec(statsSaid(found, 'side by side', 'scale') ?? '');
      const months = statsLines(found, 'side by side').filter((line) => line.startsWith('month '));

      if (scale === null || months.length === 0) {
        return 'nothing was drawn side by side';
      }

      const top = Number(scale[1]);
      const plot = Number(scale[2]);
      const numbers = (text) => text.split('+').filter((n) => n.length > 0).map(Number);
      const bases = new Set();
      const wrong = [];
      let tallest = 0;

      for (const line of months) {
        const bar = /^month .*: counts=([\d+]*) heights=([\d+]*) xs=([\d.+]*) widths=([\d.+]*) bases=([\d.+]*)$/.exec(line);

        if (bar === null) {
          wrong.push(`unreadable: ${line.slice(0, 80)}`);
          continue;
        }

        const counts = numbers(bar[1]);
        const heights = numbers(bar[2]);
        const xs = numbers(bar[3]);
        const widths = numbers(bar[4]);

        numbers(bar[5]).forEach((base) => bases.add(base));
        tallest = Math.max(tallest, ...heights);

        for (const [index, count] of counts.entries()) {
          // Its own height from the baseline, a pixel at least, rather than a piece stacked on the one below.
          const want = Math.max(1, Math.round((count * plot) / top));

          if (heights[index] !== want) {
            wrong.push(`${line.slice(0, 60)}: ${count} commits drawn ${heights[index]}px, not ${want}px`);
          }

          if (index > 0 && xs[index] < xs[index - 1] + widths[index - 1] - 0.01) {
            wrong.push(`${line.slice(0, 60)}: bar ${index} at ${xs[index]} runs into the one before it`);
          }

          if (widths[index] < 1) {
            wrong.push(`${line.slice(0, 60)}: bar ${index} is ${widths[index]}px wide`);
          }
        }
      }

      /*
       * One baseline under every bar of every month, and the busiest of them filling half the chart at
       * least: a scale still taken from the bar's total would draw each of nine people at a ninth of it.
       */
      if (bases.size !== 1) {
        wrong.push(`the bars stand on ${bases.size} baselines: ${[...bases].slice(0, 4).join(', ')}`);
      }

      if (tallest < plot / 2) {
        wrong.push(`the tallest bar is ${tallest}px of ${plot}px, so the scale is not the busiest band's`);
      }

      if (!/"sideBySide":true/.test(statsSaid(found, 'side by side', 'remembered') ?? '')) {
        wrong.push(`it remembered ${statsSaid(found, 'side by side', 'remembered')}`);
      }

      return wrong.length === 0 ? null : wrong.slice(0, 3).join('; ');
    },
  ],
  [
    'the statistics count by the week over forty days and by the month over three years',
    (found) => {
      const long = statsSaid(found, 'long', 'total heading');
      const short = statsSaid(found, 'fortyDays', 'total heading');

      return long === 'Commits per month' && short === 'Commits per week'
        ? null
        : `three years read ${JSON.stringify(long)}, and forty days ${JSON.stringify(short)}`;
    },
  ],
  [
    'a person is one colour in every chart, and no two in the stack share one',
    (found) => {
      const wrong = [];

      for (const name of DRAWN) {
        const legend = statsLines(found, name)
          .filter((line) => line.startsWith('legend: '))
          .map((line) => ({ who: line.slice(8, line.lastIndexOf(' | hue=')), hue: line.slice(line.lastIndexOf(' | hue=') + 7) }))
          .filter((entry) => entry.hue !== '-');
        const listed = new Map(statsPeople(found, name).map((person) => [person.name, person.hue]));
        const stacked = new Map(statsBars(found, name).flatMap((bar) => bar.who.map((piece) => [piece.name, piece.hue])));

        if (name === 'long' && legend.length < 8) {
          wrong.push(`the three years have ${legend.length} coloured bands, which proves little`);
        }

        if (new Set(legend.map((entry) => entry.hue)).size !== legend.length) {
          wrong.push(`${name}: two bands share a colour, ${legend.map((entry) => `${entry.who} ${entry.hue}`).join(', ')}`);
        }

        for (const { who, hue } of legend) {
          if (listed.has(who) && listed.get(who) !== hue) {
            wrong.push(`${name}: ${who} is ${listed.get(who)} in the list and ${hue} in the legend`);
          }

          if (stacked.has(who) && stacked.get(who) !== hue) {
            wrong.push(`${name}: ${who} is ${stacked.get(who)} in the stack and ${hue} in the legend`);
          }
        }
      }

      return wrong.length === 0 ? null : wrong.slice(0, 3).join('; ');
    },
  ],
  [
    'the legend is in the order the bands stack',
    (found) => {
      for (const name of DRAWN) {
        const legend = statsLines(found, name)
          .filter((line) => line.startsWith('legend: '))
          .map((line) => line.slice(8, line.lastIndexOf(' | hue=')));

        for (const bar of statsBars(found, name)) {
          const order = bar.who.map((piece) => legend.indexOf(piece.name));

          if (order.some((at, i) => at < 0 || (i > 0 && at <= (order[i - 1] ?? -1)))) {
            return `${name}: a bar stacks ${bar.who.map((piece) => piece.name).join(', ')} from the bottom, and the legend reads ${legend.join(', ')}`;
          }
        }
      }

      return null;
    },
  ],
  [
    'someone who only merges is listed, with their merges and no colour of their own',
    (found) => {
      const mia = statsPeople(found, 'long').find((person) => person.name === 'Mia Merger');

      return mia !== undefined && mia.commits === '0' && mia.merges === '90 merges' && mia.hue === '-'
        ? null
        : `the row read ${JSON.stringify(mia ?? null)}`;
    },
  ],
  [
    'a name on the statistics tab is text, never markup',
    (found) => {
      const bold = statsSaid(found, 'a name that is markup', 'bold elements');
      const rows = statsSaid(found, 'a name that is markup', 'rows naming it');

      return bold === '0' && rows === '1' ? null : `${bold} bold elements, and ${rows} rows reading <b>not bold</b> as text`;
    },
  ],
  [
    'the statistics tab says what state it is in',
    (found) => {
      const notes = statsSaid(found, 'stopped', 'notes') ?? '';
      const wrong = [
        (statsSaid(found, 'no graph', 'message') ?? '').startsWith('No graph is open') &&
        statsSaid(found, 'no graph', 'button') === 'hidden=false text="Open the Graph"'
          ? null
          : `with no graph: ${statsLines(found, 'no graph').join(' / ')}`,
        (statsSaid(found, 'a first walk', 'message') ?? '').startsWith('Counting') && statsSaid(found, 'a first walk', 'button') === 'hidden=true'
          ? null
          : `on a first walk: ${statsLines(found, 'a first walk').join(' / ')}`,
        (statsSaid(found, 'failed', 'message') ?? '').includes("fatal: bad revision 'nope'")
          ? null
          : `when the walk failed: ${statsLines(found, 'failed').join(' / ')}`,
        (statsSaid(found, 'nothing', 'message') ?? '').startsWith('There are no commits') && statsSaid(found, 'nothing', 'charts') === 'hidden=true'
          ? null
          : `with nothing counted: ${statsLines(found, 'nothing').join(' / ')}`,
        notes.includes('weft.maxCommits') && notes.includes('committer dates') ? null : `cut short under a date filter: ${notes}`,
        statsSaid(found, 'while the next walk is counted', 'charts') === 'hidden=false class="stale"' &&
        statsSaid(found, 'when it has been', 'charts') === 'hidden=false class=""'
          ? null
          : `while walking: ${statsSaid(found, 'while the next walk is counted', 'charts')}, then ${statsSaid(found, 'when it has been', 'charts')}`,
        statsSaid(found, 'show all', 'listed before') === '50' &&
        statsSaid(found, 'show all', 'listed after') === statsSaid(found, 'show all', 'people')
          ? null
          : `Show all: ${statsLines(found, 'show all').join(' / ')}`,
      ].filter((problem) => problem !== null);

      return wrong.length === 0 ? null : wrong.join('; ');
    },
  ],
  [
    'Open the Graph on the statistics tab asks the host for one',
    (found) => {
      const sent = statsLines(found, 'opening the graph sends');
      return sent.length === 1 && sent[0] === '{"type":"openGraph"}' ? null : `it sent ${sent.join(', ') || 'nothing'}`;
    },
  ],
  [
    'the page threw nothing',
    (found) => ((found['=== thrown ==='] ?? '').trim() === '(nothing)' && found['=== probe failed ==='] === undefined
      ? null
      : `${(found['=== probe failed ==='] ?? found['=== thrown ==='] ?? '').trim().split('\n')[0]}`),
  ],
  [
    'the statistics page threw nothing',
    (found) =>
      (found['=== stats: thrown ==='] ?? '').trim() === '(nothing)' && found['=== stats: probe failed ==='] === undefined
        ? null
        : `${(found['=== stats: probe failed ==='] ?? found['=== stats: thrown ==='] ?? 'there is no recording of the statistics page').trim().split('\n')[0]}`,
  ],
];

function broken(text) {
  const found = sections(text);
  return INVARIANTS.flatMap(([what, check]) => {
    const why = check(found);
    return why === null ? [] : [`${what}: ${why}`];
  });
}

function storeFile(name) {
  if (!/^[\w.-]+$/.test(name ?? '')) {
    fail(2, 'a recording needs a name made of letters, digits, dots and dashes');
  }

  mkdirSync(STORE, { recursive: true });
  return join(STORE, `${name}.txt`);
}

async function needBuild() {
  const built = await build();

  if (!built.ok) {
    fail(2, built.why);
  }
}

/**
 * Put each bug back, one at a time, and require the check to notice.
 *
 * The spec is a module whose default export lists `{ what, check, args }` with one break, as
 * `{ file, from, to }`, or several in `edits` - for a bug that lived in more than one place. `check`
 * is `diff` (the recording differs from the healthy one), `assert` (an invariant breaks), or
 * `load-check`, `unit` or `node` (that run fails - `node` runs whatever script `args` names, for the
 * guards that are scripts of their own). The file is restored before anything is reported, the
 * bytes are compared, and a run whose file did not come back stops here rather than reporting.
 */
async function control(port, specPath) {
  if (specPath === undefined) {
    fail(2, 'control needs a spec: node scripts/ui-probe.mjs control <spec.mjs>');
  }

  const spec = (await import(pathToFileURL(resolve(specPath)).href)).default;

  await needBuild();
  const healthy = await record(port);
  const results = [];

  for (const item of spec) {
    // One break or several, in one file or more: a bug that lived in two places is put back in both.
    const edits = item.edits ?? [{ file: item.file, from: item.from, to: item.to }];
    const originals = new Map();
    const breaks = new Map();
    let invalid = null;

    for (const change of edits) {
      const file = resolve(ROOT, change.file);

      if (!originals.has(file)) {
        originals.set(file, readFileSync(file, 'utf8'));
      }

      const text = breaks.get(file) ?? originals.get(file);
      const anchors = text.split(change.from).length - 1;

      if (anchors !== 1) {
        invalid = `the anchor is in ${change.file} ${anchors} times, not once`;
        break;
      }

      breaks.set(file, text.replace(change.from, () => change.to));
    }

    if (invalid !== null) {
      results.push(['invalid', item.what, invalid]);
      continue;
    }

    let verdict = 'invalid';
    let detail = '';

    try {
      // Inside the try, so a failure halfway through writing still puts every file back.
      for (const [file, text] of breaks) {
        writeFileSync(file, text);
      }

      const built = await build();

      if (!built.ok) {
        detail = `the break does not build, so it proves nothing: ${built.why}`;
      } else if (item.check === 'diff') {
        const moved = differing(healthy, await record(port));
        verdict = moved.length > 0 ? 'caught' : 'MISSED';
        detail = moved.slice(0, 4).join(', ');
      } else if (item.check === 'assert') {
        const failures = broken(await record(port));
        verdict = failures.length > 0 ? 'caught' : 'MISSED';
        detail = failures.slice(0, 3).join('; ');
      } else if (item.check === 'load-check' || item.check === 'unit' || item.check === 'node') {
        const args =
          item.check === 'unit'
            ? ['--test', ...(item.args ?? [])]
            : item.check === 'load-check'
              ? ['scripts/load-check.mjs', ...(item.args ?? [])]
              : [...(item.args ?? [])];
        const ran = await run(process.execPath, args);
        verdict = ran.code !== 0 ? 'caught' : 'MISSED';
        detail = tail(ran.stderr || ran.stdout, 4);
      } else {
        detail = `unknown check "${item.check}"`;
      }
    } finally {
      for (const [file, text] of originals) {
        writeFileSync(file, text);
      }
    }

    for (const [file, text] of originals) {
      if (readFileSync(file, 'utf8') !== text) {
        fail(2, `${file} did not come back as it was - stopping rather than reporting`);
      }
    }

    results.push([verdict, item.what, detail]);
  }

  await needBuild();

  for (const [verdict, what, detail] of results) {
    console.log(`${verdict.padEnd(8)} ${what}`);

    if (detail) {
      console.log(`         ${detail}`);
    }
  }

  const unproven = results.filter(([verdict]) => verdict !== 'caught').length;
  console.log(unproven === 0 ? `\nall ${results.length} caught` : `\n${unproven} of ${results.length} not caught`);
  return unproven === 0 ? 0 : 1;
}

async function main(port) {
  switch (command) {
    case 'print': {
      await needBuild();
      process.stdout.write(await record(port));
      return 0;
    }

    case 'save': {
      const file = storeFile(subject);
      await needBuild();
      const text = await record(port);
      writeFileSync(file, text);
      console.log(`ui-probe: ${subject} - ${Object.keys(sections(text)).length} sections saved`);
      return 0;
    }

    case 'check': {
      const file = storeFile(subject);

      if (!existsSync(file)) {
        fail(2, `nothing saved as "${subject}" - run: node scripts/ui-probe.mjs save ${subject}`);
      }

      await needBuild();
      const text = await record(port);
      const stored = readFileSync(file, 'utf8');
      const moved = differing(stored, text);

      console.log(
        stored === text
          ? `ui-probe: identical to "${subject}", byte for byte, across ${Object.keys(sections(text)).length} sections`
          : `ui-probe: ${moved.length} section(s) differ from "${subject}": ${moved.join(', ') || '(outside any section)'}`,
      );
      return stored === text ? 0 : 1;
    }

    case 'stable': {
      const runs = Math.max(2, Number(subject ?? 3));
      await needBuild();
      const first = await record(port);
      let steady = true;

      for (let i = 1; i < runs; i++) {
        const again = await record(port);

        if (again !== first) {
          steady = false;
          console.log(`  run ${i + 1}: ${differing(first, again).join(', ') || '(outside any section)'}`);
        }
      }

      console.log(steady ? `ui-probe: stable across ${runs} runs` : `ui-probe: NOT reproducible across ${runs} runs`);
      return steady ? 0 : 1;
    }

    case 'assert': {
      await needBuild();
      const failures = broken(await record(port));

      console.log(
        'ui invariants  :',
        failures.length === 0 ? `${INVARIANTS.length} held` : `${failures.length} of ${INVARIANTS.length} BROKEN`,
      );

      for (const failure of failures) {
        console.error(`  ! ${failure}`);
      }

      return failures.length === 0 ? 0 : 1;
    }

    case 'control':
      return control(port, subject);

    default:
      console.error('usage: node scripts/ui-probe.mjs print | save <name> | check <name> | stable [n] | assert | control <spec.mjs>');
      return 2;
  }
}

let code = 0;
let server = null;

try {
  server = await serveDist(0);
  code = await main(server.address().port);
} catch (error) {
  if (error instanceof Stop) {
    console.error(`ui-probe: ${error.message}`);
    code = error.code;
  } else {
    console.error(error);
    code = 1;
  }
} finally {
  server?.close();
  rmSync(join(DIST, PAGE), { force: true });
  rmSync(join(DIST, STATS_PAGE), { force: true });
  rmSync(join(DIST, REBASE_PAGE), { force: true });
}

process.exit(code);
