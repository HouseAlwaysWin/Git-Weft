/**
 * The UI probe: drive the webview in headless Chrome, and record what it builds and what it sends.
 *
 * The view's HTML is generated, and generated HTML is exactly what a refactor of the code that
 * generates it can quietly change. So is what a click asks the host to do, which no amount of
 * looking at the page shows: the host owns most of the state, and in this harness nothing on screen
 * moves when a filter is asked for. The probe records both, as sections of text two builds can be
 * compared by.
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

/** One recording of the page as it is served now. */
async function record(port) {
  await writePage();

  const result = await run(chromePath(), [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${join(tmpdir(), 'weft-ui-probe-chrome')}`,
    '--virtual-time-budget=60000',
    '--window-size=1400,800',
    '--dump-dom',
    `http://127.0.0.1:${port}/${PAGE}`,
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
    fail(1, `the page never wrote its recording${result.stderr ? `: ${tail(result.stderr, 2)}` : ''}`);
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
    'the page threw nothing',
    (found) => ((found['=== thrown ==='] ?? '').trim() === '(nothing)' && found['=== probe failed ==='] === undefined
      ? null
      : `${(found['=== probe failed ==='] ?? found['=== thrown ==='] ?? '').trim().split('\n')[0]}`),
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
}

process.exit(code);
