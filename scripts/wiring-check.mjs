/**
 * Is every webview module the view was split into actually connected to it?
 *
 * The pieces taken out of `main.ts` own their own elements and their own listeners, so they load
 * and register whether or not anybody hands them the view's half - a `remember` that saves nothing,
 * a `laneRoom` that answers zero. Nothing throws. The module works, quietly, on defaults.
 *
 * That failure was made twice while the view was being split up: once where the right-click menu's
 * own items silently stopped appearing, and once where the lanes' grip vanished because `laneRoom`
 * was still the stub returning zero. Both were caught by looking rather than by anything failing,
 * which is not a way to catch the third one.
 *
 * So: a module that exports `connect` has to be connected from `main.ts`, and every seam its
 * options declare has to be stored - because an option accepted and dropped on the floor leaves
 * exactly the same working-looking module running on its defaults.
 *
 * And: does every page ask for elements its own markup has? The loop above only ever sees modules
 * that export `connect`, which no page does - so `stats.ts` and `rebase.ts` went past it without a
 * word. See PAGES, below.
 *
 *   node scripts/wiring-check.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../src/webview/', import.meta.url);
const main = readFileSync(new URL('main.ts', dir), 'utf8');
const problems = [];
const connected = [];

for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts') && name !== 'main.ts')) {
  const source = readFileSync(new URL(file, dir), 'utf8');
  const declaration = /export function connect\(options: \{([\s\S]*?)\n\}\): void \{([\s\S]*?)\n\}/.exec(source);

  if (declaration === null) {
    continue;
  }

  const [, options = '', body = ''] = declaration;

  /*
   * How `main.ts` refers to it, read from the import rather than guessed from the filename: the
   * modules are imported under names that read at the call site - `branchMenu.ts` as `branches` -
   * and a check that assumed the filename would be looking for a call nobody would ever write.
   */
  const imported = new RegExp(`import \\* as (\\w+) from '\\./${file.replace('.ts', '')}\\.ts'`).exec(main);
  const named = new RegExp(`import \\{[^}]*\\bconnect\\b[^}]*\\} from '\\./${file.replace('.ts', '')}\\.ts'`).test(main);

  if (imported === null && !named) {
    problems.push(`${file} exports connect, but main.ts never imports it`);
    continue;
  }

  const alias = imported?.[1];
  const call = alias === undefined ? 'connect(' : `${alias}.connect(`;

  if (!main.includes(call)) {
    problems.push(
      `${file} exports connect and main.ts never calls ${call}) - it will run on its defaults, silently`,
    );
    continue;
  }

  // Every option the signature offers has to be stored, or it is a seam that quietly stays a stub.
  const fields = [...options.matchAll(/^\s{2}(\w+):/gm)].map(([, name]) => name);
  const dropped = fields.filter((name) => !new RegExp(`\\b${name} = options\\.${name}\\b`).test(body));

  if (dropped.length > 0) {
    problems.push(`${file} accepts ${dropped.join(', ')} in connect and never stores it`);
  }

  connected.push(`${alias ?? file.replace('.ts', '')} (${fields.length})`);
}

if (connected.length === 0) {
  problems.push('found no connected modules at all - has the import or the connect shape changed?');
}

console.log(`webview wiring : ${connected.join(', ')}`);

/*
 * The second question, which nothing here used to ask.
 *
 * `main.ts` is not the only page: `stats.ts` and `rebase.ts` are pages too, neither exports `connect`,
 * and so the loop above skipped both without saying so - which is how the rebase editor's page came to
 * have no check of any kind anywhere. A page that asks for an id its markup does not carry either
 * throws as it loads, leaving a list nobody can work and buttons that do nothing, or - the older idiom
 * here, `getElementById('x') as HTMLElement` - carries a null that passes for an element until
 * something touches it. Neither names the id, and neither happens until somebody opens that page.
 *
 * So: every page esbuild builds has to be named below with the markup it is drawn into, and every id
 * the page or the modules loaded with it look up has to be in that markup.
 */
const PAGES = {
  'main.ts': 'BODY_MARKUP',
  'stats.ts': 'STATS_MARKUP',
  'rebase.ts': 'REBASE_MARKUP',
};

const markup = readFileSync(new URL('markup.ts', dir), 'utf8');

/** What a markup constant holds, from its name to the backtick that ends it. */
function drawnBy(name) {
  const at = markup.indexOf(`export const ${name} = \``);
  const end = at < 0 ? -1 : markup.indexOf('`;', at);

  return at < 0 || end < 0 ? null : markup.slice(at, end);
}

/** A page's own module and everything it imports from beside it, which is what loads with it. */
function loadedWith(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) {
      return;
    }

    seen.add(file);

    for (const [, next] of readFileSync(new URL(file, dir), 'utf8').matchAll(/from '\.\/([\w.-]+)\.ts'/g)) {
      walk(`${next}.ts`);
    }
  };

  walk(entry);
  return seen;
}

/*
 * Ids as this codebase asks for them: `getElementById('x')`, the `element('x')` helper that throws
 * instead of lying about what it found, and a literal `querySelector('#x')`. Anything computed is
 * nobody's business here - a check that guessed at expressions would be a check that cried wolf.
 */
function idsIn(source) {
  const patterns = [
    /getElementById\('([\w-]+)'\)/g,
    /\belement(?:<[^>]*>)?\('([\w-]+)'\)/g,
    /querySelector(?:<[^>]*>)?\('#([\w-]+)'\)/g,
  ];

  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map(([, id]) => id));
}

// Read from the build rather than listed here as well: a page added there and not below is the blindness.
const built = [
  ...readFileSync(new URL('../../esbuild.mjs', dir), 'utf8').matchAll(/'src\/webview\/([\w.-]+)\.ts'/g),
].map(([, name]) => `${name}.ts`);

for (const entry of built) {
  if (!(entry in PAGES)) {
    problems.push(`esbuild builds src/webview/${entry} as a page of its own, and PAGES here has never heard of it`);
  }
}

const pages = [];

for (const [entry, constant] of Object.entries(PAGES)) {
  const html = drawnBy(constant);

  if (html === null) {
    problems.push(`${entry} is drawn into ${constant}, which markup.ts does not export`);
    continue;
  }

  let asked = 0;

  for (const file of loadedWith(entry)) {
    for (const id of idsIn(readFileSync(new URL(file, dir), 'utf8'))) {
      asked += 1;

      if (!html.includes(`id="${id}"`)) {
        problems.push(`${file} looks up #${id}, which ${constant} - the markup ${entry} is drawn into - does not have`);
      }
    }
  }

  pages.push(`${entry.replace('.ts', '')} (${asked})`);
}

console.log(`webview pages  : ${pages.join(', ')}`);

for (const problem of problems) {
  console.error(`  ! ${problem}`);
}

console.log(
  problems.length === 0
    ? 'OK - every split-out module is connected, and every page has the elements it asks for.'
    : 'FAILED',
);
process.exit(problems.length === 0 ? 0 : 1);
