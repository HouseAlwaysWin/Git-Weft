import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLog } from '../src/git/logParser.ts';
import { parseRawDiff } from '../src/git/details.ts';
import type { Search } from '../src/git/search.ts';
import {
  SearchMode,
  TOGGLES,
  authorArgs,
  escapeBasicRegex,
  fileHistorySearch,
  filterArgs,
  foldCase,
  looksLikeCommitId,
  searchArgs,
} from '../src/git/search.ts';
import { dateArgs, isDay } from '../src/git/dates.ts';
import { parseBranchName } from '../src/git/repoState.ts';
import { describeAge, parseBlame } from '../src/git/blame.ts';

const RS = '\x1e';
const NUL = '\x00';

function record(fields: string[]): string {
  return RS + fields.join(NUL);
}

test('a commit record round-trips through the parser', () => {
  const output = record([
    'a'.repeat(40),
    `${'b'.repeat(40)} ${'c'.repeat(40)}`,
    'Martin Wang',
    'martin@example.com',
    '2026-07-30T10:00:00+08:00',
    '2026-07-30T10:01:00+08:00',
    'HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1.0',
    'feat: something',
  ]);

  const [commit] = parseLog(output);

  assert.equal(commit?.sha, 'a'.repeat(40));
  assert.equal(commit?.parents.length, 2);
  assert.equal(commit?.author, 'Martin Wang');
  assert.equal(commit?.subject, 'feat: something');
  assert.equal(commit?.isHead, true);
  assert.deepEqual(commit?.refs, [
    { name: 'main', kind: 'local' },
    { name: 'origin/main', kind: 'remote' },
    { name: 'v1.0', kind: 'tag' },
  ]);
});

test('a subject containing the field separator cannot split a record', () => {
  // git folds %s to one line, but a subject can still contain almost anything else.
  const output = record([
    'a'.repeat(40),
    '',
    'A',
    'a@b',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    '',
    'fix: handle a, b, and "c" -> d',
  ]);

  const [commit] = parseLog(output);

  assert.equal(commit?.subject, 'fix: handle a, b, and "c" -> d');
  assert.deepEqual(commit?.parents, []);
});

test('origin/HEAD is skipped - it is an alias, not a branch', () => {
  const output = record([
    'a'.repeat(40),
    '',
    'A',
    'a@b',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    'refs/remotes/origin/HEAD, refs/remotes/origin/main',
    'x',
  ]);

  assert.deepEqual(parseLog(output)[0]?.refs, [{ name: 'origin/main', kind: 'remote' }]);
});

test('a detached HEAD marks the commit without inventing a branch', () => {
  const output = record([
    'a'.repeat(40),
    '',
    'A',
    'a@b',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    'HEAD',
    'x',
  ]);

  const [commit] = parseLog(output);

  assert.equal(commit?.isHead, true);
  assert.deepEqual(commit?.refs, []);
});

test('raw diff records give both blob sides', () => {
  const raw =
    ':100644 100644 aaaaaaa bbbbbbb M\x00src/app.ts\x00' +
    ':000000 100644 0000000 ccccccc A\x00src/new.ts\x00' +
    ':100644 000000 ddddddd 0000000 D\x00src/gone.ts\x00';

  const files = parseRawDiff(raw);

  assert.equal(files.length, 3);
  assert.equal(files[0]?.status, 'M');
  assert.equal(files[0]?.oldBlob, 'aaaaaaa');
  assert.equal(files[0]?.newBlob, 'bbbbbbb');

  assert.equal(files[1]?.status, 'A');
  assert.equal(files[1]?.oldBlob, null, 'an added file has no previous blob');

  assert.equal(files[2]?.status, 'D');
  assert.equal(files[2]?.newBlob, null, 'a deleted file has no new blob');
});

test('a rename record consumes two paths, not one', () => {
  // Getting this wrong shifts every subsequent record by one field.
  const raw =
    ':100644 100644 aaaaaaa bbbbbbb R096\x00old/name.ts\x00new/name.ts\x00' +
    ':100644 100644 ccccccc ddddddd M\x00after.ts\x00';

  const files = parseRawDiff(raw);

  assert.equal(files.length, 2);
  assert.equal(files[0]?.status, 'R');
  assert.equal(files[0]?.oldPath, 'old/name.ts');
  assert.equal(files[0]?.path, 'new/name.ts');
  assert.equal(files[0]?.similarity, 96);
  assert.equal(files[1]?.path, 'after.ts', 'the record after a rename must not be misaligned');
});

test('paths with spaces and non-ASCII survive -z', () => {
  const raw = ':100644 100644 aaaaaaa bbbbbbb M\x00docs/使用說明 v2.md\x00';

  assert.equal(parseRawDiff(raw)[0]?.path, 'docs/使用說明 v2.md');
});

/** A search with every switch off - what the box sends before anyone touches it. */
function plain(query: string, mode: SearchMode): Search {
  return {
    query,
    mode,
    regex: false,
    caseSensitive: false,
    allTerms: false,
    invert: false,
    follow: false,
  };
}

test('a plain query matches as text, not as a pattern', () => {
  // The dots are escaped, so `v0.4.1` cannot also match `v0X4Y1`. Escaping rather than passing
  // --fixed-strings is deliberate: that flag is global and would reach the Authors sidebar too.
  assert.deepEqual(searchArgs(plain('v0.4.1', SearchMode.Message)), ['--grep=[vV]0\\.4\\.1']);

  assert.deepEqual(searchArgs(plain('martin', SearchMode.Author)), [
    '--author=[mM][aA][rR][tT][iI][nN]',
  ]);

  assert.deepEqual(searchArgs(plain('TODO', SearchMode.Content)), ['-G[tT][oO][dD][oO]']);
});

test('the regex switch hands the query to git as written', () => {
  assert.deepEqual(searchArgs({ ...plain('v0.4..', SearchMode.Message), regex: true }), [
    '--regexp-ignore-case',
    '--grep=v0.4..',
  ]);
});

test('escaping follows git basic regex, not the JavaScript reflex', () => {
  /*
   * The trap: in a BRE, `+ ? ( ) { } |` are literal *until* you escape them - `\+` is the
   * one-or-more operator, so backslashing a plus is what breaks it. Only `\ . * [ ^ $` are
   * operators to begin with.
   */
  assert.equal(escapeBasicRegex('C++'), 'C++');
  assert.equal(escapeBasicRegex('A|B'), 'A|B');
  assert.equal(escapeBasicRegex('Foo (Bar)'), 'Foo (Bar)');
  assert.equal(escapeBasicRegex('a{2}'), 'a{2}');
  assert.equal(escapeBasicRegex('A. Person'), 'A\\. Person');
  assert.equal(escapeBasicRegex('a*b'), 'a\\*b');
  assert.equal(escapeBasicRegex('[x]'), '\\[x]');
  assert.equal(escapeBasicRegex('^start'), '\\^start');
});

test('match case drops the flag rather than adding one', () => {
  assert.deepEqual(searchArgs({ ...plain('Fix', SearchMode.Message), caseSensitive: true }), [
    '--grep=Fix',
  ]);
});

test('all terms intersects; one term has nothing to intersect', () => {
  assert.deepEqual(searchArgs({ ...plain('feat filter', SearchMode.Message), allTerms: true }), [
    '--all-match',
    '--grep=[fF][eE][aA][tT]',
    '--grep=[fF][iI][lL][tT][eE][rR]',
  ]);

  // --all-match is a global flag, so it is not sent when there is a single pattern to match.
  assert.deepEqual(searchArgs({ ...plain('feat', SearchMode.Message), allTerms: true }), [
    '--grep=[fF][eE][aA][tT]',
  ]);
});

test('invert asks for the commits that did not match', () => {
  assert.deepEqual(searchArgs({ ...plain('wip', SearchMode.Message), invert: true }), [
    '--invert-grep',
    '--grep=[wW][iI][pP]',
  ]);
});

test('committer is its own field, not a synonym for author', () => {
  assert.deepEqual(searchArgs(plain('martin', SearchMode.Committer)), [
    '--committer=[mM][aA][rR][tT][iI][nN]',
  ]);
});

test('a mode ignores the switches it cannot honour', () => {
  /*
   * --invert-grep inverts --grep and nothing else, and multiple -G do not intersect: a switch left
   * on from another mode has to be dropped rather than sent somewhere it means something else.
   */
  assert.deepEqual(TOGGLES[SearchMode.Content], ['caseSensitive', 'regex']);

  assert.deepEqual(
    searchArgs({ ...plain('TODO', SearchMode.Content), invert: true, allTerms: true }),
    ['-G[tT][oO][dD][oO]'],
  );

  // A pathspec is a glob with its own magic, so case travels inside it and regex is not offered.
  assert.deepEqual(searchArgs({ ...plain('src/app.ts', SearchMode.Path), regex: true }), [
    '--',
    ':(icase)src/app.ts',
  ]);
});

test('following renames and a case-insensitive path cannot both be asked for', () => {
  /*
   * Measured, not assumed: `git log --follow -- ':(icase)src/x.ts'` is not a quieter answer, it is
   * `fatal: pathspec magic not supported by --follow`, which takes the whole walk with it. So the
   * magic is dropped when following, and the view shows the case switch locked on rather than
   * offering something git will refuse.
   */
  const following = { ...plain('src/app.ts', SearchMode.Path), follow: true };

  assert.deepEqual(searchArgs(following), ['--follow', '--', 'src/app.ts']);

  // Even when the query explicitly asked for case-insensitivity, which is the default.
  assert.deepEqual(searchArgs({ ...following, caseSensitive: false }), [
    '--follow',
    '--',
    'src/app.ts',
  ]);

  // And without following, the magic is how case-insensitivity gets there at all.
  assert.deepEqual(searchArgs(plain('src/app.ts', SearchMode.Path)), [
    '--',
    ':(icase)src/app.ts',
  ]);
});

test('following renames is a path idea, and no other mode is offered it', () => {
  assert.deepEqual(TOGGLES[SearchMode.Path], ['caseSensitive', 'follow']);

  assert.ok(!TOGGLES[SearchMode.Message].includes('follow'));
  assert.deepEqual(searchArgs({ ...plain('fix', SearchMode.Message), follow: true }), [
    '--grep=[fF][iI][xX]',
  ]);
});

test('a path filter goes last, behind --', () => {
  const args = searchArgs({ ...plain('src/app.ts', SearchMode.Path), caseSensitive: true });

  assert.deepEqual(args, ['--', 'src/app.ts']);
  assert.equal(args[args.length - 2], '--', 'git reads anything before -- as a revision');
});

test("a file's history is the file, not whatever it was copied from", () => {
  /*
   * `--follow` is not only about renames. git turns copy detection on for it, so it looks for a
   * source among every file in the commit that added the path rather than only among the ones that
   * went away - and a file made by copying its neighbour is followed onto the neighbour, which is
   * still sitting there.
   *
   * Measured on a service file scaffolded from the module next door: 69 commits with `--follow`
   * where the path itself had 61, and the eight extra belonged to two other modules, back to a
   * file with a different name in a different folder. Nothing on screen said so.
   */
  const search = fileHistorySearch('src/app.ts');

  assert.equal(search.follow, false, 'a history of the wrong file still looks like a history');
  assert.equal(search.mode, SearchMode.Path);
  assert.deepEqual(searchArgs(search), ['--', ':(icase)src/app.ts']);

  // The switch stays for somebody who knows their file was moved, and still means what it meant.
  assert.deepEqual(searchArgs({ ...search, follow: true }), ['--follow', '--', 'src/app.ts']);
});

test('a query that looks like a flag stays one argument', () => {
  // No shell is involved, so this is inert - but it must not be split or dropped either. Match
  // case is on only to keep this expectation about the argument rather than about the folding,
  // which is somebody else's test.
  assert.deepEqual(
    searchArgs({ ...plain('--upload-pack=evil', SearchMode.Message), caseSensitive: true }),
    ['--grep=--upload-pack=evil'],
  );
});

test('an empty or absent search filters nothing', () => {
  assert.deepEqual(searchArgs(null), []);
  assert.deepEqual(searchArgs(plain('   ', SearchMode.Message)), []);
});

test('every date bound carries an explicit time', () => {
  /*
   * The measured trap: git's approxidate fills a bare `YYYY-MM-DD` from the *current clock*, so
   * `--since=2026-07-24` run at 20:08 means 20:08 that day. On a 99-commit repository it returned
   * one commit where the day held twelve, and it would have answered differently an hour later.
   */
  assert.deepEqual(dateArgs({ since: '2026-07-24', until: null }, false), [
    '--since=2026-07-24 00:00:00',
  ]);

  // And `--until=<day>` means "before midnight", so an inclusive end has to spell out the day's end.
  assert.deepEqual(dateArgs({ since: null, until: '2026-07-26' }, false), [
    '--until=2026-07-26 23:59:59',
  ]);
});

test('a lower bound filters rather than stopping the walk, where git can', () => {
  /*
   * `--since` prunes a line of history at the first commit older than the cutoff, which hides newer
   * commits behind an older one. `--since-as-filter` visits everything instead - measured on a
   * two-commit repository with the dates crossed over, where `--since` found neither.
   */
  assert.deepEqual(dateArgs({ since: '2026-07-24', until: '2026-07-26' }, true), [
    '--since-as-filter=2026-07-24 00:00:00',
    '--until=2026-07-26 23:59:59',
  ]);
});

test('a bound git would guess at is not sent at all', () => {
  // `<input type="date">` yields a day or nothing, and anything else reaching here is a bug
  // somewhere - approxidate would accept `yesterday` and quietly mean something else tomorrow.
  assert.deepEqual(dateArgs({ since: 'yesterday', until: null }, true), []);
  assert.deepEqual(dateArgs({ since: '2026-7-4', until: null }, true), []);
  assert.deepEqual(dateArgs(null, true), []);

  assert.equal(isDay('2026-07-24'), true);
  assert.equal(isDay('last tuesday'), false);
});

test('an author filter cannot end up behind a path search', () => {
  /*
   * The one ordering git will not forgive. Behind `--` an `--author` is read as a filename, so the
   * author filter silently stops applying - the search still returns commits, just the wrong ones.
   */
  const args = filterArgs(
    plain('src/app.ts', SearchMode.Path),
    [{ name: 'Ada Lovelace', emails: [] }],
    dateArgs({ since: '2026-01-01', until: null }, true),
  );

  assert.deepEqual(args, [
    '--author=Ada Lovelace',
    '--since-as-filter=2026-01-01 00:00:00',
    '--',
    ':(icase)src/app.ts',
  ]);

  assert.ok(args.indexOf('--') === args.length - 2, 'nothing may follow the pathspec but the path');
});

/** The Authors sidebar's ticks, as they reach `filterArgs`. */
const ADA = { name: 'Ada Lovelace', emails: ['ada@example.com'] };
const CHARLES = { name: 'Charles Babbage', emails: ['charles@example.com'] };

test('case travels in the pattern, because the flag for it is walk-wide', () => {
  /*
   * --regexp-ignore-case reaches every pattern on the command line, the Authors sidebar's --author
   * arguments included - so typing anything at all into the search box used to quietly fold
   * SEAN_LIN and sean_lin back together, two rows the reader had ticked apart on purpose.
   *
   * A bracket expression is the only per-pattern case a BRE has, and it is exactly as
   * case-insensitive as the flag was - measured against git, not assumed.
   */
  assert.equal(foldCase('Fix'), '[fF][iI][xX]');
  assert.equal(foldCase('v1.2'), '[vV]1.2', 'digits and dots have no case to fold');
  assert.equal(foldCase('台北'), '台北', 'nor has anything outside a cased script');

  const args = filterArgs(plain('fix', SearchMode.Message), [{ name: 'SEAN_LIN', emails: [] }]);

  assert.deepEqual(args, ['--author=SEAN_LIN', '--grep=[fF][iI][xX]']);
  assert.ok(!args.includes('--regexp-ignore-case'), 'the ticked spelling has to stay exact');
});

test('a pattern the reader wrote is not rewritten, so the flag comes back', () => {
  // Folding a regex by hand would change what it means. The flag is the only way, and it is the
  // one case where the sidebar's spellings are still folded with it - said out loud rather than
  // pretended away.
  assert.deepEqual(searchArgs({ ...plain('v0.4..', SearchMode.Message), regex: true }), [
    '--regexp-ignore-case',
    '--grep=v0.4..',
  ]);
});

test('two author filters intersect, where git would have unioned them', () => {
  /*
   * git reads several --author as "any of these", whatever else is on the line - measured, and
   * --all-match does not change it. So a tick in the sidebar and a name in the box used to widen
   * each other: tick Ada, type Charles, and out came both. More rows than either filter alone.
   *
   * There is no way to intersect two --author patterns in git, so the query is spent narrowing the
   * ticks instead of being sent beside them.
   */
  assert.deepEqual(filterArgs(plain('ada', SearchMode.Author), [ADA, CHARLES]), [
    '--author=Ada Lovelace',
  ]);

  // By address as well, because that is what --author matches: the whole `Name <email>` line.
  assert.deepEqual(filterArgs(plain('charles@example', SearchMode.Author), [ADA, CHARLES]), [
    '--author=Charles Babbage',
  ]);

  // With nobody ticked there is nothing to narrow, and the query goes to git as it always did.
  assert.deepEqual(filterArgs(plain('ada', SearchMode.Author), []), [
    '--author=[aA][dD][aA]',
  ]);

  // A different field is a different filter, and git intersects those by itself.
  assert.deepEqual(filterArgs(plain('ada', SearchMode.Committer), [ADA]), [
    '--author=Ada Lovelace',
    '--committer=[aA][dD][aA]',
  ]);
});

test('an author filter that matches nobody means nobody, not everybody', () => {
  /*
   * The loud one. An empty list of --author arguments does not mean "nobody" to git, it means "no
   * author filter" - so ticking Ada and searching for a name she has never spelled would have
   * opened the entire history instead of closing it.
   */
  const args = filterArgs(plain('grace', SearchMode.Author), [ADA, CHARLES]);

  assert.deepEqual(args, ['--author=^$']);
});

test('an author query in regex mode is read in git\'s dialect, not JavaScript\'s', () => {
  /*
   * The intersection has to be decided here, so the pattern has to be understood here - and a BRE
   * is not a JavaScript regex. `\\|` is alternation and a bare `|` is a literal pipe; JavaScript has
   * it exactly the other way round, so reading one as the other silently picks the wrong people.
   */
  const alternation = { ...plain('Ada\\|Grace', SearchMode.Author), regex: true };

  assert.deepEqual(filterArgs(alternation, [ADA, CHARLES]), ['--author=Ada Lovelace']);

  // And a bare pipe is a character nobody is called, not an alternation.
  const literal = { ...plain('Ada|Grace', SearchMode.Author), regex: true };

  assert.deepEqual(filterArgs(literal, [ADA, CHARLES]), ['--author=^$']);
});

test('all terms is not offered where it would only widen the search', () => {
  /*
   * --all-match governs --grep and nothing else. Measured: `--all-match --committer=Ali
   * --committer=zz` still returns Ali's commits though nobody in that repository is called zz - so
   * in author and committer mode the button was widening the search while its label said narrow.
   */
  assert.deepEqual(TOGGLES[SearchMode.Author], ['caseSensitive', 'regex']);
  assert.deepEqual(TOGGLES[SearchMode.Committer], ['caseSensitive', 'regex']);

  assert.deepEqual(searchArgs({ ...plain('ada grace', SearchMode.Author), allTerms: true }), [
    '--author=[aA][dD][aA] [gG][rR][aA][cC][eE]',
  ]);
});

test('the branch header names the branch, and a detached HEAD is not a branch called HEAD', () => {
  // git spells a detached HEAD `## HEAD (no branch)`. A real branch cannot contain a space, which
  // is the only thing telling the sentinel apart from a branch that happens to be called HEAD.
  assert.equal(parseBranchName('## main...origin/main [ahead 1]\x00'), 'main');
  assert.equal(parseBranchName('## main\x00 M file.txt\x00'), 'main');
  assert.equal(parseBranchName('## HEAD (no branch)\x00'), null);
  assert.equal(parseBranchName('## feature/a-b...origin/feature/a-b\x00'), 'feature/a-b');
  assert.equal(parseBranchName(' M file.txt\x00'), null);
});

test('commit ids are told apart from search text', () => {
  assert.equal(looksLikeCommitId('1883db13'), true);
  assert.equal(looksLikeCommitId('a'.repeat(40)), true);
  assert.equal(looksLikeCommitId('abc'), false, 'too short to be an abbreviation');
  assert.equal(looksLikeCommitId('deadbeeg'), false, 'g is not hex');
  assert.equal(looksLikeCommitId('fix: cafebabe'), false);
});

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);

/*
 * Blame output is a sequence of hunks in the order git found them, not in file order, and a
 * commit's details appear only the first time that commit does. Both are the whole reason this is
 * parsed rather than read.
 */
test('blame lands each hunk on the line it is about, whatever order they arrive in', () => {
  const out = [
    `${B} 1 3 1`,
    'author Second',
    'author-time 200',
    'summary the later one',
    '\tthird line',
    `${A} 1 1 2`,
    'author First',
    'author-time 100',
    'summary the first one',
    '\tfirst line',
    `${A} 2 2`,
    '\tsecond line',
    '',
  ].join('\n');

  const blame = parseBlame(out);

  assert.equal(blame.length, 3);
  assert.equal(blame[0]?.author, 'First');
  assert.equal(blame[1]?.author, 'First', 'a repeated sha says nothing, so it has to be remembered');
  assert.equal(blame[1]?.summary, 'the first one');
  assert.equal(blame[2]?.author, 'Second');
  assert.equal(blame[0]?.authorTime, 100_000, 'seconds from git, milliseconds here');
});

test('blame tells the fields that only look alike apart', () => {
  const out = [
    `${A} 1 1 1`,
    'author Ada Lovelace',
    'author-mail <ada@example.invalid>',
    'author-time 1700000000',
    'author-tz +0000',
    'committer Somebody Else',
    'committer-time 1800000000',
    'summary the subject',
    '\tthe line',
    '',
  ].join('\n');

  const line = parseBlame(out)[0];

  assert.equal(line?.author, 'Ada Lovelace', 'not the mail, the time or the committer');
  assert.equal(line?.authorTime, 1_700_000_000_000);
  assert.equal(line?.summary, 'the subject');
});

test('a line that is not committed yet is marked as such', () => {
  const out = [`${ZERO} 1 1 1`, 'author Not Committed Yet', 'author-time 0', 'summary x', '\tnew', ''].join('\n');

  assert.equal(parseBlame(out)[0]?.uncommitted, true);
  assert.equal(parseBlame(`${A} 1 1 1\nauthor A\nauthor-time 1\nsummary s\n\tx\n`)[0]?.uncommitted, false);
});

test('blame of nothing is nothing, not a crash', () => {
  assert.deepEqual(parseBlame(''), []);
  assert.deepEqual(parseBlame('fatal: no such path\n'), []);
});

test('an age is said the way a person would say it', () => {
  const now = Date.UTC(2026, 0, 1);
  const ago = (ms: number): string => describeAge(now - ms, now);

  assert.equal(ago(5_000), 'just now');
  assert.equal(ago(60_000), '1 minute ago');
  assert.equal(ago(5 * 60_000), '5 minutes ago');
  assert.equal(ago(3 * 3_600_000), '3 hours ago');
  assert.equal(ago(2 * 86_400_000), '2 days ago');
  assert.equal(ago(6 * 30 * 86_400_000), '6 months ago');
  assert.equal(ago(3 * 365 * 86_400_000), '3 years ago');
  assert.equal(ago(-1000), 'just now', 'a clock ahead of ours is not "in -1 minutes"');
});
