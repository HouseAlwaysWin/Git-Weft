/**
 * The author filter, measured against git rather than reasoned about.
 *
 * Two controls narrow by author - the Authors sidebar's ticks and the search box's author mode -
 * and they both speak `--author`, which git reads as "any of these". So the two used to *widen*
 * each other: tick Ada, type Charles, and out came both. git cannot intersect two `--author`
 * patterns, so `filterArgs` intersects them itself, over the ticked spellings.
 *
 * Which means a query now has to be understood **here**, in git's dialect, and a basic regular
 * expression is not a JavaScript one: `\|` is alternation and a bare `|` is a literal pipe, and
 * JavaScript has it exactly the other way round. Reading one as the other picks the wrong people
 * and says nothing about it.
 *
 * Hence one invariant, run against a real repository:
 *
 * > **Ticking everybody must not change what a search finds.**
 *
 * Ticking everybody narrows nothing, so the answer has to be the one the search gives on its own.
 * The ticked path is decided in JavaScript and the unticked one is decided by git, so agreeing on
 * every query is what proves the two dialects were read the same way.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Search } from '../src/git/search.ts';
import { SearchMode, authorArgs, filterArgs, searchArgs } from '../src/git/search.ts';

/**
 * Names chosen for what they do to a regex, not for realism.
 *
 * Three spellings of one person differing only in case, because that is the pair the sidebar's two
 * levels let you tick apart and a walk-wide `-i` would fold back together. Then a plus, a dot, a
 * pair of brackets and a CJK name - every character that is an operator in one dialect and a letter
 * in the other.
 */
const PEOPLE: readonly (readonly [string, string])[] = [
  ['Alice', 'alice@x.com'],
  ['alice', 'alice@x.com'],
  ['ALICE', 'alice@work.com'],
  ['C++ Bot', 'bot@x.com'],
  ['A. Person', 'person@x.com'],
  ['Foo (Bar)', 'foo@x.com'],
  ['Sean Lin', 'sean@x.com'],
  ['sean_lin', 'sean@home.com'],
  ['台北 使用者', 'taipei@x.com'],
];

const dir = mkdtempSync(join(tmpdir(), 'weft-authors-')).split('\\').join('/');

function sh(...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

sh('init', '-q', '-b', 'main');
sh('config', 'commit.gpgsign', 'false');
sh('config', 'core.autocrlf', 'false');

for (const [index, [name, email]] of PEOPLE.entries()) {
  writeFileSync(`${dir}/f.txt`, `${index}\n`);
  sh('add', 'f.txt');
  sh('-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', `c${index}`);
}

test.after(() => rmSync(dir, { recursive: true, force: true }));

/** Every spelling, as the sidebar would hand them over with all of them ticked. */
const everyone = PEOPLE.map(([name, email]) => ({ name, emails: [email] }));

function search(query: string, over: Partial<Search> = {}): Search {
  return {
    query,
    mode: SearchMode.Author,
    regex: false,
    caseSensitive: false,
    allTerms: false,
    invert: false,
    follow: false,
    ...over,
  };
}

/** Who git returns for a set of `git log` arguments. */
function gitFinds(args: readonly string[]): string[] {
  return [
    ...new Set(
      sh('log', '--format=%an', ...args)
        .split('\n')
        .filter((line) => line.length > 0),
    ),
  ].sort();
}

/** Who the ticked path picks, read back out of the arguments it built. */
function weFind(query: Search): string[] {
  const args = filterArgs(query, everyone);

  return PEOPLE.map(([name]) => name)
    .filter((name) => args.includes(authorArgs([name])[0] as string))
    .sort();
}

test('ticking every author changes nothing about what a search finds', () => {
  const queries: Search[] = [
    // Text, which is the default and what almost every query is.
    search('alice'),
    search('Alice'),
    search('Alice', { caseSensitive: true }),
    search('C++'), // `+` is a letter in a BRE and an operator in JavaScript
    search('A. Person'), // and `.` the other way round
    search('(Bar)'),
    search('@x.com'), // --author matches `Name <email>`, so an address is fair game
    search('台北'),
    search('nobody at all'),

    // And the dialect proper.
    search('Ali.e', { regex: true }),
    search('^Alice', { regex: true }),
    search('Alice$', { regex: true }),
    search('Ali\\|Sean', { regex: true }), // alternation
    search('Ali|Sean', { regex: true }), // a literal pipe, which nobody is called
    search('C++', { regex: true }),
    search('C\\+', { regex: true }), // one-or-more, so every name with a C in it
    search('Foo (Bar)', { regex: true }),
    search('Foo \\(Bar\\)', { regex: true }), // a group, so it matches the text without brackets
    search('[Aa]lice', { regex: true }),
    search('l\\{2\\}', { regex: true }),
    search('lin$', { regex: true, caseSensitive: true }),
    search('.*', { regex: true }),
    search('[[:alpha:]]lice', { regex: true }),
  ];

  for (const query of queries) {
    assert.deepEqual(
      weFind(query),
      gitFinds(searchArgs(query)),
      `${query.regex ? 'regex' : 'text'} ${query.caseSensitive ? '(match case) ' : ''}${query.query}`,
    );
  }
});

test('a tick and a query narrow each other instead of widening', () => {
  const ada = { name: 'Alice', emails: ['alice@x.com'] };
  const sean = { name: 'Sean Lin', emails: ['sean@x.com'] };

  /*
   * The bug, stated as git states it: several --author are a union, whatever else is on the line.
   * So the old command line found four commits where each filter on its own found fewer.
   */
  assert.equal(gitFinds(['--author=Alice', '--author=Sean']).length, 2);
  assert.deepEqual(filterArgs(search('sean'), [ada, sean]), ['--author=Sean Lin']);

  // And the loud one: an empty list of --author is not "nobody" to git, it is "no author filter".
  assert.deepEqual(filterArgs(search('grace'), [ada, sean]), ['--author=^$']);
  assert.deepEqual(gitFinds(['--author=^$']), []);
});
