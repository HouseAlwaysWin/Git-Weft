/**
 * Every setting the manifest offers is read, and every setting the code reads is offered.
 *
 * Both halves failed when this was written, in opposite directions:
 *
 * - `weft.pageSize` was declared with a range, a default of 2000 and a description saying it was
 *   how much you wait for on open. Nothing read it, and the number actually in use was 500 written
 *   into `panel.ts`. A setting in the Settings UI that does nothing is worse than an absent one:
 *   somebody turns it down to make the graph appear sooner, sees no difference, and concludes the
 *   extension is slow.
 * - `weft.maxCommits` was read with a default of 250,000 and declared nowhere, so it did not
 *   appear in the Settings UI or in autocomplete, and writing it into `settings.json` by hand
 *   earned an "Unknown Configuration Setting" squiggle for a setting that worked.
 *
 * Neither is the kind of thing a test notices, because neither of them fails anything. It is the
 * same shape as a field crossing the wire with no reader - which is why that has a guard too.
 *
 *   node scripts/settings-check.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const declared = new Set(
  Object.keys(manifest.contributes?.configuration?.properties ?? {})
    .filter((key) => key.startsWith('weft.'))
    .map((key) => key.slice('weft.'.length)),
);

/** Every `.ts` under `src/`, because a setting can be read from anywhere. */
function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? sources(path)
      : path.endsWith('.ts')
        ? [readFileSync(path, 'utf8')]
        : [];
  });
}

/*
 * `getConfiguration('weft')` then `get<T>('name', fallback)`. Matching the read rather than the
 * string means a name that is only ever mentioned in a comment does not count as read.
 */
const READ = /\.get<[^>]*>\(\s*'([A-Za-z][\w.]*)'/g;
const used = new Set();

for (const source of sources('src')) {
  for (const match of source.matchAll(READ)) {
    used.add(match[1]);
  }
}

const problems = [];

for (const name of used) {
  if (!declared.has(name)) {
    problems.push(`weft.${name} is read by the code and declared nowhere, so nobody can set it`);
  }
}

for (const name of declared) {
  if (!used.has(name)) {
    problems.push(`weft.${name} is offered in the Settings UI and read by nothing`);
  }
}

console.log(`settings       : ${declared.size} declared, ${used.size} read`);

/*
 * The default in the manifest is what the Settings UI shows and what a reader believes is in force.
 * The fallback in `config.get(name, fallback)` is what actually happens when nobody has set it. Two
 * numbers for one thing is two chances to be wrong about it.
 */
const FALLBACK = /\.get<[^>]*>\(\s*'([A-Za-z][\w.]*)'\s*,\s*([^)]+?)\s*\)/g;

for (const source of sources('src')) {
  for (const [, name, raw] of source.matchAll(FALLBACK)) {
    const property = manifest.contributes?.configuration?.properties?.[`weft.${name}`];

    if (property === undefined) {
      continue;
    }

    // A string in single quotes is a literal too - an enum's default is one - and it is compared as it
    // is written, before the digit separators are taken out of anything that might be a number.
    const quoted = /^'([^']*)'$/.exec(raw);
    const literal = raw.replace(/_/g, '');
    const fallback =
      quoted !== null
        ? quoted[1]
        : literal === 'true'
          ? true
          : literal === 'false'
            ? false
            : Number(literal);

    if (typeof fallback === 'number' && Number.isNaN(fallback)) {
      continue; // Not a literal - nothing to compare against.
    }

    if (fallback !== property.default) {
      problems.push(
        `weft.${name} defaults to ${JSON.stringify(property.default)} in the manifest and to ${JSON.stringify(fallback)} in the code`,
      );
    }
  }
}

if (problems.length > 0) {
  console.log('');
  console.log('FAILED:');

  for (const problem of problems) {
    console.log(`  - ${problem}`);
  }

  process.exit(1);
}

console.log('OK - every setting is both offered and read, and agrees with itself about its default.');
