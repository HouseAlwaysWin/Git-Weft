/**
 * Turning a search box into `git log` arguments.
 *
 * The whole point is that git does the work. Loading 100k commits and then filtering the array in
 * JavaScript means paying for every commit the user did not ask for; `--grep` and friends let git
 * skip them during the walk, and `-G` in particular searches the *contents* of every diff, which
 * is not something a client-side filter could do at any price.
 *
 * Nothing here quotes or escapes: arguments reach git as an array, so a query of `--exec=rm -rf /`
 * is just a string that matches nothing.
 */

export const SearchMode = {
  /** Commit message, subject and body. */
  Message: 'message',
  Author: 'author',
  /** Who committed it, which a rebase, a squash or a web-UI merge makes different from the author. */
  Committer: 'committer',
  /** Diff content: commits where the number of matches for the pattern changed. */
  Content: 'content',
  /** Commits that touched a path. */
  Path: 'path',
} as const;

export type SearchMode = (typeof SearchMode)[keyof typeof SearchMode];

export type SearchToggle = 'caseSensitive' | 'regex' | 'allTerms' | 'invert' | 'follow';

export interface Search {
  readonly query: string;
  readonly mode: SearchMode;
  /** Off means the query matches as text; on means it matches as a pattern. */
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  /** Split the query on spaces and require every word, rather than any one of them. */
  readonly allTerms: boolean;
  /** Show the commits that do *not* match. */
  readonly invert: boolean;
  /** Follow a path through renames, so a file's history does not stop where it was moved. */
  readonly follow: boolean;
}

/**
 * Which switches actually change the answer in each mode, measured against git rather than guessed:
 *
 * - `--invert-grep` inverts `--grep` and nothing else, so it means something only in message mode.
 * - Multiple `-G` do not intersect and multiple pathspecs are a union, so `allTerms` has no
 *   `--all-match` to reach for there.
 * - `--all-match` governs `--grep` and nothing else, which takes `allTerms` out of author and
 *   committer mode too. Measured: `--all-match --committer=Ali --committer=zz` still returns Ali's
 *   commits, though nobody in that repository is called `zz`. Several `--author` are "any of
 *   these" whatever else is on the command line - so the button widened the search while its label
 *   said it narrowed it, which is worse than not offering it.
 * - A pathspec is not a regex; it is a glob with its own magic prefixes, so `regex` is meaningless.
 *
 * The webview reads this table to decide which buttons to show, and `searchArgs` reads it to decide
 * what to honour - one table, so a button can never be offered for something that does nothing.
 */
export const TOGGLES: Readonly<Record<SearchMode, readonly SearchToggle[]>> = {
  [SearchMode.Message]: ['caseSensitive', 'regex', 'allTerms', 'invert'],
  [SearchMode.Author]: ['caseSensitive', 'regex'],
  [SearchMode.Committer]: ['caseSensitive', 'regex'],
  [SearchMode.Content]: ['caseSensitive', 'regex'],
  [SearchMode.Path]: ['caseSensitive', 'follow'],
};

/**
 * Escape a string so git matches it as text.
 *
 * git's `--grep`, `--author`, `--committer` and `-G` are POSIX **basic** regular expressions, and
 * BRE is not the dialect a JavaScript instinct reaches for. `.` `*` `[` `^` `$` are operators and
 * have to be escaped - but `+` `?` `(` `)` `{` `}` `|` are *literal until you escape them*, so the
 * usual "backslash every punctuation mark" turns a name like `C++` into a pattern meaning something
 * else entirely, and `A|B` into a pattern that matches two different people.
 *
 * `--fixed-strings` would do all of this for us, and it is deliberately not used: it is a global
 * flag, so it would also reach the `--author` arguments the Authors sidebar contributes and the
 * escaping they already carry.
 */
export function escapeBasicRegex(text: string): string {
  return text.replace(/[\\^$.*\[]/g, '\\$&');
}

/**
 * Carry case-insensitivity inside the pattern instead of in a flag.
 *
 * `--regexp-ignore-case` is walk-wide. It reaches every pattern on the command line, the `--author`
 * arguments the Authors sidebar contributes included - and those are exact spellings out of
 * `shortlog`, ticked one at a time precisely because `SEAN_LIN` and `sean_lin` are two rows in the
 * list. A search box whose case switch is off by default would quietly fold them back together, so
 * typing anything at all into the box widens a filter set somewhere else entirely. That is the same
 * mistake `--fixed-strings` would make, and it is avoided the same way: per pattern, not per walk.
 *
 * A bracket expression is the only per-pattern case a BRE has, so every letter becomes one.
 * Characters with no case - digits, punctuation, CJK - and the few whose mapping changes length
 * (`ß` uppercases to `SS`) are left as they are, which is what `-i` does with them too.
 *
 * Only for a pattern we wrote. A pattern the reader wrote is theirs, and rewriting it is not on -
 * so a regex search still needs the flag, and still reaches further than it should.
 */
export function foldCase(pattern: string): string {
  let out = '';

  for (const ch of pattern) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    const cased = lower !== upper && [...lower].length === 1 && [...upper].length === 1;

    out += cased ? `[${lower}${upper}]` : ch;
  }

  return out;
}

/**
 * `--author` arguments for exact spellings, which is what a tick in the Authors sidebar is.
 *
 * Escaping rather than passing `--fixed-strings` is deliberate: that flag is global, so it would
 * also apply to the reader's own query and quietly change what it means.
 */
export function authorArgs(names: readonly string[]): string[] {
  return names.map((name) => `--author=${escapeBasicRegex(name)}`);
}

/**
 * Just enough of an author to decide whether a query picks them out.
 *
 * `--author` matches against `Name <email>` - the pair, as one line, which is measurably why
 * `b@x.com` finds Bob without his name being typed, and why `e <a@` finds Alice across the gap.
 * Anything answering the same question here has to be shown the same string.
 */
export interface AuthorPick {
  readonly name: string;
  readonly emails: readonly string[];
}

/**
 * `git log` arguments for a search, or an empty list when there is nothing to search for.
 *
 * A path filter has to come last and behind `--`, or git tries to resolve it as a revision and
 * fails on anything that is not also a branch name. Whatever else is on the command line - the
 * Authors sidebar's `--author`, above all - has to be placed before this.
 */
export function searchArgs(search: Search | null): string[] {
  if (search === null) {
    return [];
  }

  const query = search.query.trim();

  if (query.length === 0) {
    return [];
  }

  const supported = TOGGLES[search.mode];
  const on = (toggle: SearchToggle): boolean => supported.includes(toggle) && search[toggle];
  const fold = !on('caseSensitive');

  /*
   * Ours to write, so the case goes in it; theirs to write, so the flag has to do it.
   *
   * The flag is a last resort rather than the default because of how far it reaches - see
   * `foldCase`. A regex search is the one case with no alternative, and also the one case where
   * the reader has said something specific enough to be worth honouring exactly as written.
   */
  const pattern = (text: string): string =>
    on('regex') ? text : fold ? foldCase(escapeBasicRegex(text)) : escapeBasicRegex(text);

  const ignoreCase = on('regex') && fold ? ['--regexp-ignore-case'] : [];

  if (search.mode === SearchMode.Path) {
    /*
     * A pathspec takes its switches inside itself rather than as flags: everything after `--` is a
     * path, so there is nowhere else for them to go.
     *
     * Except that `--follow` will not have them. `git log --follow -- ':(icase)src/x.ts'` is not a
     * quieter answer but a fatal error - "pathspec magic not supported by --follow" - which would
     * take the whole walk with it. Following renames therefore means matching the path exactly,
     * and the view says so by showing the case switch as locked on rather than letting someone
     * turn off something that was never going to happen.
     */
    const follow = on('follow');
    const icase = !follow && !on('caseSensitive') ? ':(icase)' : '';

    return [...(follow ? ['--follow'] : []), '--', `${icase}${query}`];
  }

  if (search.mode === SearchMode.Content) {
    // The one pattern `--fixed-strings` does not reach - measured - so text mode escapes it here.
    return [...ignoreCase, `-G${pattern(query)}`];
  }

  const flag =
    search.mode === SearchMode.Author
      ? '--author='
      : search.mode === SearchMode.Committer
        ? '--committer='
        : '--grep=';

  const terms = on('allTerms') ? query.split(/\s+/).filter((term) => term.length > 0) : [query];

  return [
    ...ignoreCase,
    // Only with something to intersect: on a single pattern it is noise, and it is a global flag.
    ...(terms.length > 1 ? ['--all-match'] : []),
    ...(on('invert') ? ['--invert-grep'] : []),
    ...terms.map((term) => `${flag}${pattern(term)}`),
  ];
}

/**
 * Everything that narrows the walk, in the one order git accepts.
 *
 * A path search ends in `-- <path>`, and everything after `--` is a pathspec - so anything placed
 * behind it stops being a filter and becomes a filename that matches nothing. The bug is silent:
 * the search still returns commits, just not the ones that were asked for.
 */
export function filterArgs(
  search: Search | null,
  authors: readonly AuthorPick[],
  dates: readonly string[] = [],
): string[] {
  const query = search === null ? '' : search.query.trim();

  /*
   * Both halves are about to say `--author`, and git reads several of those as "any of these".
   *
   * So the query is spent narrowing the ticks instead of being sent alongside them - see
   * `narrowAuthors`. With nobody ticked there is nothing to narrow and the query goes to git as it
   * always did, regex and all.
   */
  const narrowing =
    search !== null && search.mode === SearchMode.Author && query.length > 0 && authors.length > 0;

  const picked = narrowing ? narrowAuthors(search as Search, authors) : authors;

  return [
    ...(narrowing && picked.length === 0 ? [NOBODY] : authorArgs(picked.map((one) => one.name))),
    ...dates,
    ...(narrowing ? [] : searchArgs(search)),
  ];
}

/**
 * An `--author` that cannot match: `^` and `$` are anchors at the ends of a BRE, and no author line
 * is empty. Measured against git rather than assumed.
 *
 * Needed because an intersection can come out empty, and an empty list of `--author` arguments does
 * not mean "nobody" to git - it means "no author filter". Ticking Alice and then searching for a
 * name she has never spelled would otherwise have opened the whole history instead of closing it,
 * which is the loudest possible way to get a filter wrong.
 */
const NOBODY = '--author=^$';

/** What git compares a query against: one line per address, `Name <email>`. */
function authorLines(author: AuthorPick): string[] {
  return author.emails.length === 0
    ? [`${author.name} <>`]
    : author.emails.map((email) => `${author.name} <${email}>`);
}

/**
 * The ticked authors that a query in author mode also picks out.
 *
 * Two controls speaking one `git log` flag, and git reads several `--author` as "any of these" - so
 * a tick in the sidebar and a name in the box used to *widen* each other. Tick Alice, type Bob, and
 * out come both, which is more rows than either filter alone and the opposite of what two filters
 * are for.
 *
 * git has no way to intersect two `--author` patterns - `--all-match` governs `--grep` and was
 * measured not to help - so the intersection is made here. Which is possible only because a tick is
 * an exact spelling out of `shortlog` and there are never many ticked at once.
 */
function narrowAuthors(search: Search, authors: readonly AuthorPick[]): AuthorPick[] {
  const query = search.query.trim();
  const fold = !search.caseSensitive;
  const expression = search.regex ? basicRegexToJs(query, fold) : null;

  if (expression !== null) {
    return authors.filter((author) => authorLines(author).some((line) => expression.test(line)));
  }

  // Text, or a pattern that could not be read in git's dialect - see `basicRegexToJs`.
  const needle = fold ? query.toLowerCase() : query;

  return authors.filter((author) =>
    authorLines(author).some((line) => (fold ? line.toLowerCase() : line).includes(needle)),
  );
}

/**
 * POSIX character classes as JavaScript spells them, for the inside of a bracket expression.
 *
 * ASCII, which is what git's own compiled-in regex uses for these unless a locale says otherwise -
 * so `[[:alpha:]]` finding no Chinese name here is the same answer git gives, not a shortcut.
 */
const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alpha: 'a-zA-Z',
  digit: '0-9',
  alnum: 'a-zA-Z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\v\\f\\r',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9A-Fa-f',
  cntrl: '\\x00-\\x1f\\x7f',
  print: '\\x20-\\x7e',
  graph: '\\x21-\\x7e',
  // GNU's own, which git inherits along with the rest of its dialect.
  word: 'a-zA-Z0-9_',
};

/** The seven characters where a BRE and a JavaScript regex disagree about which form is the operator. */
const SWAPPED = '(){}|+?';

/**
 * git's basic regex read as a JavaScript one, or `null` when it cannot be said for certain.
 *
 * Wanted in exactly one place: an author query has to be intersected with the ticked spellings, git
 * cannot intersect two `--author` patterns, so the match has to be made here - and it has to be
 * made in git's dialect rather than JavaScript's, or the answer is wrong in a way nobody can see.
 *
 * The whole of the difference is seven characters. In a BRE `( ) { } | + ?` are literal and their
 * backslashed forms are the operators; JavaScript has it exactly the other way round. Everything
 * else - `. * [ ] ^ $`, back-references, `\w` and friends - is spelled the same in both, and GNU's
 * `\<` and `\>` are word boundaries with no JavaScript spelling of their own, so they become `\b`.
 *
 * The one thing a BRE has that JavaScript does not is `[[:alpha:]]`, and JavaScript would not
 * complain about it - it would read a bracket full of punctuation and quietly match the wrong
 * names. So the classes are spelled out first, and a name that is not one of them gives up rather
 * than guessing; git refuses those too, so nothing is lost that would have worked.
 */
function basicRegexToJs(pattern: string, fold: boolean): RegExp | null {
  const expanded = pattern.replace(
    /\[:([a-z]+):\]/g,
    (whole, name: string) => POSIX_CLASSES[name] ?? whole,
  );

  if (expanded.includes('[:')) {
    return null;
  }

  let out = '';

  for (let i = 0; i < expanded.length; i++) {
    const ch = expanded[i] as string;

    if (ch !== '\\') {
      out += SWAPPED.includes(ch) ? `\\${ch}` : ch;
      continue;
    }

    const next = expanded[i + 1];

    if (next === undefined) {
      // A pattern ending in a backslash is not one; git would refuse it too.
      return null;
    }

    i++;
    out += next === '<' || next === '>' ? '\\b' : SWAPPED.includes(next) ? next : `\\${next}`;
  }

  try {
    /*
     * Deliberately not the `u` flag: without it an unknown escape is the character itself, which is
     * how a BRE reads one, and with it the whole pattern would throw instead.
     */
    return new RegExp(out, fold ? 'i' : '');
  } catch {
    return null;
  }
}

/**
 * Whether a query is a commit id rather than something to grep for.
 *
 * Typing a hash into a search box should jump to that commit, not run a substring match over every
 * message. Seven hex characters is git's own default abbreviation length.
 */
export function looksLikeCommitId(query: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(query.trim());
}
