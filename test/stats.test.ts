/**
 * The statistics' arithmetic: which day a commit is on, which bar a day is in, who a spelling is, and
 * whether the bars add up to the commits they were cut from.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOG_ARGS, parseLog } from '../src/git/logParser.ts';
import { authorHue } from '../src/webview/authorColor.ts';
import {
  MOST_WEEKS,
  bucketIndex,
  bucketStarts,
  dayFromSerial,
  describeBucket,
  serialOf,
  tickLabel,
  unitFor,
  weekStart,
  weekdayOf,
} from '../src/stats/calendar.ts';
import type { Scope } from '../src/stats/scope.ts';
import { describeScope } from '../src/stats/scope.ts';
import type { StatsSummary } from '../src/stats/summary.ts';
import { STACKED, assignHues, summarize } from '../src/stats/summary.ts';
import { CommitTally, dayOf } from '../src/stats/tally.ts';

const FACTS = { truncated: false, limit: 250_000, scope: 'every branch and tag', dated: false };

interface Dated {
  readonly author: string;
  readonly authorDate: string;
}

/** A commit by a spelling at noon UTC on a day: everything a tally reads of one. */
function on(author: string, day: string): Dated {
  return { author, authorDate: `${day}T12:00:00+00:00` };
}

function tallied(commits: readonly Dated[]): CommitTally {
  const tally = new CommitTally();
  tally.add(commits);
  return tally;
}

/** The two sums a summary has to keep, whatever went into it. */
function assertAddsUp(summary: StatsSummary): void {
  for (const [bar, count] of summary.perBucket.entries()) {
    const banded = summary.series.reduce((sum, band) => sum + (band.counts[bar] ?? 0), 0);
    assert.equal(banded + (summary.others[bar] ?? 0), count, `bar ${bar}: the bands and the grey band make the bar`);
  }

  assert.equal(
    summary.perBucket.reduce((sum, count) => sum + count, 0) + summary.undated,
    summary.total,
    'every commit is on one bar, or undated',
  );
}

test("a commit's day is the one on its author's calendar, not UTC's", () => {
  const dir = mkdtempSync(join(tmpdir(), 'weft-stats-'));
  const git = (env: Record<string, string>, ...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });

  try {
    git({}, 'init', '-q', '-b', 'main');
    git({}, 'config', 'commit.gpgsign', 'false');
    git({}, 'config', 'core.autocrlf', 'false');

    // Just after midnight in Taipei is the evening before in UTC; just before midnight in New York is the
    // morning after.
    for (const [subject, when] of [
      ['taipei', '2026-01-16T00:30:00+08:00'],
      ['new york', '2026-01-15T23:30:00-05:00'],
    ] as const) {
      writeFileSync(join(dir, 'f.txt'), `${subject}\n`);
      git({}, 'add', 'f.txt');
      git(
        { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
        ...['-c', 'user.name=Weft Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', subject],
      );
    }

    const commits = parseLog(git({}, 'log', ...LOG_ARGS));
    const days = Object.fromEntries(commits.map((commit) => [commit.subject, dayOf(commit.authorDate)]));

    assert.deepEqual(days, { taipei: 20260116, 'new york': 20260115 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('text that is not a date is day 0', () => {
  assert.equal(dayOf('2024-02-29T10:00:00+00:00'), 20240229);

  for (const text of ['', 'garbage', '2026-02-29T10:00:00+00:00', '2026-13-01T10:00:00Z', '2026-00-10T10:00:00Z', '2026/01/15']) {
    assert.equal(dayOf(text), 0, JSON.stringify(text));
  }
});

test('the calendar agrees with Date.UTC every day for thirty years', () => {
  const from = Date.UTC(1995, 0, 1) / 86_400_000;
  const to = Date.UTC(2025, 11, 31) / 86_400_000;

  for (let serial = from; serial <= to; serial++) {
    const date = new Date(serial * 86_400_000);
    const day = date.getUTCFullYear() * 10_000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();

    assert.equal(dayFromSerial(serial), day);
    assert.equal(serialOf(day), serial);
    assert.equal(weekdayOf(serial), (date.getUTCDay() + 6) % 7, `${day}: Monday is 0`);
  }
});

test('a week starts on its Monday, across a new year and a leap day', () => {
  assert.equal(weekStart(20260101), 20251229, 'a Thursday, in a week that began the year before');
  assert.equal(weekStart(20260104), 20251229, 'the Sunday ends that week');
  assert.equal(weekStart(20260105), 20260105, 'a Monday starts its own');
  assert.equal(weekStart(20240229), 20240226);
});

test('weeks while there are at most sixty of them, months after that', () => {
  const monday = 20250106;
  const plus = (days: number): number => dayFromSerial(serialOf(monday) + days);
  const sundayOfSixty = plus((MOST_WEEKS - 1) * 7 + 6);

  assert.equal(unitFor(monday, sundayOfSixty), 'week');
  assert.equal(bucketStarts(monday, sundayOfSixty, 'week').length, MOST_WEEKS);
  assert.equal(unitFor(monday, plus(MOST_WEEKS * 7)), 'month', 'the Monday of week sixty-one');
});

test('bars are counted from the first, a week or a calendar month at a time', () => {
  assert.equal(bucketIndex(20250112, 20250106, 'week'), 0, 'the Sunday is still in the first week');
  assert.equal(bucketIndex(20250113, 20250106, 'week'), 1);
  assert.deepEqual(bucketStarts(20251115, 20260203, 'month'), [20251101, 20251201, 20260101, 20260201]);
  assert.equal(bucketIndex(20260131, 20251201, 'month'), 1);
  assert.equal(bucketIndex(20260201, 20251201, 'month'), 2);

  assert.equal(describeBucket(20251101, 'month'), 'November 2025');
  assert.equal(describeBucket(20251103, 'week'), 'the week of 3 November 2025');
  assert.equal(tickLabel(20260101, 'month', true), 'Jan 2026');
  assert.equal(tickLabel(20251103, 'week', false), '3 Nov');
});

test('a walk folds into people as Authors folds it, hand-made groups and kept-apart spellings included', () => {
  const tally = tallied([
    on('Sean Lin', '2026-01-05'),
    on('Sean Lin', '2026-01-06'),
    on('sean_lin', '2026-01-07'),
    on('Lineric', '2026-01-05'),
    on('lineric_lin', '2026-01-08'),
    on('Max_Chiue', '2026-01-05'),
    on('max_chiue', '2026-01-06'),
    on('Ada Fischer', '2026-01-09'),
  ]);
  const custom = new Map([
    ['Lineric', ['Eric']],
    ['lineric_lin', ['Eric']],
    ['Max_Chiue', []],
  ]);
  const summary = summarize(tally, custom, FACTS);

  assert.deepEqual(
    summary.people.map((person) => [person.name, person.commits, person.spellings, person.custom]),
    [
      ['Sean Lin', 3, ['Sean Lin', 'sean_lin'], false],
      ['Eric', 2, ['Lineric', 'lineric_lin'], true],
      ['Ada Fischer', 1, ['Ada Fischer'], false],
      ['Max_Chiue', 1, ['Max_Chiue'], false],
      ['max_chiue', 1, ['max_chiue'], false],
    ],
  );
  assert.equal(summary.overlapping, false);
  assertAddsUp(summary);
});

test('someone in two groups counts in both rows, and is drawn once, in the busier band', () => {
  const tally = tallied([
    on('Ada', '2026-01-05'),
    on('Ada', '2026-01-12'),
    on('Bo', '2026-01-05'),
    on('Bo', '2026-01-06'),
    on('Bo', '2026-01-13'),
    on('Cy', '2026-01-14'),
  ]);
  const custom = new Map([
    ['Ada', ['Backend', 'Release']],
    ['Bo', ['Backend']],
    ['Cy', ['Release']],
  ]);
  const summary = summarize(tally, custom, FACTS);

  assert.deepEqual(
    summary.people.map((person) => [person.name, person.commits]),
    [
      ['Backend', 5],
      ['Release', 3],
    ],
  );
  assert.equal(summary.overlapping, true, 'the rows add up to more than the six commits');
  assert.deepEqual(
    summary.series.map((band) => band.counts),
    [
      [3, 2],
      [0, 1],
    ],
  );
  assertAddsUp(summary);
});

test('eight people get a band of their own and the rest share one, unless the ninth is the last', () => {
  const commits = Array.from({ length: 10 }, (_, person) =>
    Array.from({ length: 20 - person }, (_, n) => on(`Person ${person}`, n % 2 === 0 ? '2026-01-05' : '2026-01-13')),
  ).flat();

  const ten = summarize(tallied(commits), new Map(), FACTS);
  assert.equal(ten.series.length, STACKED);
  assert.deepEqual(
    ten.people.map((person) => person.series),
    [0, 1, 2, 3, 4, 5, 6, 7, -1, -1],
  );
  assert.ok(ten.others.every((count) => count > 0), 'the two without a band are in the grey one');
  assertAddsUp(ten);

  const nine = summarize(tallied(commits.filter((commit) => commit.author !== 'Person 9')), new Map(), FACTS);
  assert.equal(nine.series.length, 9);
  assert.deepEqual(nine.others, [0, 0]);
  assertAddsUp(nine);
});

test('two people the graph colours alike get two colours, and the busier keeps the graph’s', () => {
  const pool = Array.from({ length: 40 }, (_, i) => `Author ${i}`);
  const busier = pool.find((name) => pool.some((other) => other !== name && authorHue(other) === authorHue(name)));
  const quieter = pool.find((name) => name !== busier && authorHue(name) === authorHue(busier ?? ''));

  assert.ok(busier !== undefined && quieter !== undefined, 'forty names over twelve hues share one');

  const summary = summarize(
    tallied([on(busier, '2026-01-05'), on(busier, '2026-01-06'), on(quieter, '2026-01-07')]),
    new Map(),
    FACTS,
  );

  assert.equal(summary.series[0]?.hue, authorHue(busier));
  assert.equal(summary.series[1]?.hue, (authorHue(quieter) + 30) % 360, 'the nearest free hue');

  const crowd = Array.from({ length: 400 }, (_, i) => `Crowd ${i}`)
    .filter((name) => authorHue(name) === authorHue('Crowd 0'))
    .slice(0, 9);

  assert.equal(crowd.length, 9);
  assert.equal(new Set(assignHues(crowd)).size, 9, 'nine names on one hue get nine hues');
});

test('the same commits make the same summary in any order, a page at a time or all at once', () => {
  const commits = [
    on('Sean Lin', '2025-03-03'),
    on('sean_lin', '2025-03-04'),
    on('Sean Lin', '2025-07-01'),
    on('sean_lin', '2025-07-02'),
    on('Ada', '2025-05-05'),
    on('Bo', '2025-05-06'),
    on('Lineric', '2026-01-01'),
    on('lineric_lin', '2026-01-02'),
    { author: 'Ada', authorDate: 'not a date' },
  ];
  const custom = new Map([
    ['Lineric', ['Eric']],
    ['lineric_lin', ['Eric', 'Platform']],
    ['Bo', ['Platform']],
  ]);
  const forwards = summarize(tallied(commits), custom, FACTS);

  const paged = new CommitTally();

  for (let i = commits.length - 1; i >= 0; i -= 2) {
    paged.add(commits.slice(Math.max(0, i - 1), i + 1).reverse());
  }

  assert.deepEqual(summarize(paged, custom, FACTS), forwards);
  assert.equal(forwards.people[0]?.name, 'Sean Lin', 'two spellings equally busy: the first in code-unit order names the row');
  assertAddsUp(forwards);
});

test('no commits, one commit, and one whose date cannot be read', () => {
  const none = summarize(new CommitTally(), new Map(), FACTS);
  assert.deepEqual(
    [none.total, none.buckets, none.people, none.series, none.others, none.undated],
    [0, [], [], [], [], 0],
  );
  assert.deepEqual([none.truncated, none.limit, none.scope, none.dated], [false, 250_000, 'every branch and tag', false]);

  const one = summarize(tallied([on('Ada', '2026-03-04')]), new Map(), FACTS);
  assert.deepEqual([one.unit, one.buckets, one.perBucket], ['week', [20260302], [1]]);
  assertAddsUp(one);

  const undated = summarize(tallied([on('Ada', '2026-03-04'), { author: 'Ada', authorDate: 'garbage' }]), new Map(), FACTS);
  assert.deepEqual([undated.total, undated.undated, undated.people[0]?.commits], [2, 1, 2]);
  assertAddsUp(undated);
});

test('the scope says what narrowed the walk, in the graph’s own words, and nothing else', () => {
  const nothing: Scope = { refs: null, search: null, authors: 0, dates: null, firstParent: false, onlyHere: false };

  assert.equal(describeScope(nothing), 'every branch and tag');
  assert.equal(describeScope({ ...nothing, onlyHere: true }), 'every branch and tag', 'only here, with everything drawn');
  assert.equal(describeScope({ ...nothing, refs: [] }), 'no branch ticked');
  assert.equal(
    describeScope({ ...nothing, refs: ['refs/heads/a', 'refs/heads/b', 'refs/tags/v1', 'refs/heads/c', 'refs/heads/d'] }),
    'a, b, v1 and 2 more',
  );
  assert.equal(
    describeScope({
      refs: ['refs/heads/main', 'refs/remotes/origin/uat'],
      search: {
        query: ' fix ',
        mode: 'message',
        regex: false,
        caseSensitive: false,
        allTerms: false,
        invert: false,
        follow: false,
      },
      authors: 2,
      dates: { since: '2026-01-01', until: null },
      firstParent: true,
      onlyHere: true,
    }),
    'main and origin/uat · only here · messages matching "fix" · 2 authors ticked · from 2026-01-01 · first parent',
  );
});
