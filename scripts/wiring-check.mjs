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

for (const problem of problems) {
  console.error(`  ! ${problem}`);
}

console.log(problems.length === 0 ? 'OK - every split-out module is connected.' : 'FAILED');
process.exit(problems.length === 0 ? 0 : 1);
