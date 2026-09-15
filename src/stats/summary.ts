/**
 * A walk's tally folded into people and cut into bars: everything the statistics tab draws, worked out
 * before it gets there.
 *
 * On the host rather than in the page, because a person is who the Authors view says they are - the
 * spelling rule and the hand-made groups both live on this side - and because what crosses to the page is
 * then a few kilobytes whose size does not depend on how long the history is.
 */

import type { AuthorIdentity } from '../git/authors.ts';
import { groupAuthors } from '../git/authors.ts';
import { authorHue } from '../webview/authorColor.ts';
import type { Unit } from './calendar.ts';
import { bucketIndex, bucketStarts, unitFor } from './calendar.ts';
import type { CommitTally, SpellingDays, WalkFacts } from './tally.ts';

/**
 * How many people the stacked chart gives a colour of their own. Everyone after them shares one grey band.
 *
 * Eight rather than twelve, though there are twelve hues (`AUTHOR_HUES`): a legend of twelve colours thirty
 * degrees apart is read by matching colours back and forth, not at a glance. A ninth person gets a colour
 * when they are the last one, because a grey band holding a single person withholds a colour for nothing.
 */
export const STACKED = 8;

/** One row of the people chart. */
export interface StatsPerson {
  /**
   * The spelling with the most commits, merges included, or the name a hand-made group was given: what
   * Authors calls the row, and the same whichever way the summary counts merges.
   */
  readonly name: string;
  /**
   * Commits under any spelling in it, merges left out unless the summary counts them. A spelling in two
   * groups counts in both, as it does in Authors.
   */
  readonly commits: number;
  /** Merges under any spelling in it, whether or not the summary counts them. */
  readonly merges: number;
  /** The spellings folded into it, the one with the most commits, merges included, first. */
  readonly spellings: readonly string[];
  /** Put together by hand rather than by the spelling rule. */
  readonly custom: boolean;
  /** Which of `series` is this person's band, or -1 for someone in the grey band. */
  readonly series: number;
}

/** One coloured band of the stacked chart. */
export interface StatsSeries {
  /** Which of `people`. */
  readonly person: number;
  /** Degrees, for `oklch()`. */
  readonly hue: number;
  /** Commits per bar, under the spellings nobody busier in the stack also has. */
  readonly counts: readonly number[];
}

/** Everything the statistics tab draws for one walk. */
export interface StatsSummary {
  /** Commits the charts count, each once: the graph's own count, less its merges unless `includeMerges`. */
  readonly total: number;
  /** Merge commits in the walk, whether or not the charts count them. */
  readonly merges: number;
  /** Whether the charts count merges, or only count them apart. */
  readonly includeMerges: boolean;
  readonly truncated: boolean;
  readonly limit: number;
  readonly scope: string;
  readonly dated: boolean;
  readonly unit: Unit;
  /** The first day of every bar, oldest first: every bar from the first dated commit to the last, empty ones too. */
  readonly buckets: readonly number[];
  /** Commits per bar: every dated commit, once. */
  readonly perBucket: readonly number[];
  /** Everybody, busiest first. */
  readonly people: readonly StatsPerson[];
  /** The coloured bands, busiest first. */
  readonly series: readonly StatsSeries[];
  /** Per bar, the commits of everyone without a band of their own. */
  readonly others: readonly number[];
  /** Commits whose date could not be read: in `total` and in `people`, and on no bar. */
  readonly undated: number;
  /** Some spelling is in more than one group, so the people chart adds up to more than `total`. */
  readonly overlapping: boolean;
}

/**
 * Busiest first, then by name in code-unit order - the same order whichever order the walk met people in,
 * and on whichever machine, which `localeCompare` is not.
 */
function busiestFirst(
  a: { readonly commits: number; readonly name: string },
  b: { readonly commits: number; readonly name: string },
): number {
  return b.commits - a.commits || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Where to look for a free hue, nearest first: the graph's own, then a step to either side, and so on. */
const STEPS = [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180] as const;

/**
 * A hue for each name, in order, no two the same.
 *
 * Each starts from `authorHue`, the colour the graph gives that spelling's rows, and takes the nearest hue
 * nobody earlier in the list has. Earlier is busier, so the people most of the chart is about keep the
 * colour they have in the graph, and a clash costs the quieter of two people their match rather than
 * costing the chart two bands of one colour.
 */
export function assignHues(names: readonly string[]): number[] {
  const taken = new Set<number>();

  return names.map((name) => {
    const own = authorHue(name);

    for (const step of STEPS) {
      const hue = (own + step + 360) % 360;

      if (!taken.has(hue)) {
        taken.add(hue);
        return hue;
      }
    }

    // Past twelve names every hue is taken, and the stack never holds that many.
    return own;
  });
}

/**
 * Fold a tally into people with the Authors view's rule and `custom`'s hand-made groups, and cut it into
 * bars of a week or a month.
 *
 * Merges are left out of everything the charts draw unless `includeMerges`, and counted apart either way.
 * Where changes arrive through merge requests every change is two commits - the work, and a merge credited
 * to whoever pressed the button - and counting both says the people who merge did everyone's work twice.
 */
export function summarize(
  tally: CommitTally,
  custom: ReadonlyMap<string, readonly string[]>,
  facts: WalkFacts,
  includeMerges = false,
): StatsSummary {
  /** A spelling's commits on a day, as the charts count them. */
  const counted = (spelling: SpellingDays, day: number, all: number): number =>
    includeMerges ? all : all - (spelling.merges.get(day) ?? 0);

  const identities: AuthorIdentity[] = [];
  const mergesOf = new Map<string, number>();
  const everyCommitOf = new Map<string, number>();
  let first = 0;
  let last = 0;
  let undated = 0;

  for (const spelling of tally.spellings()) {
    let commits = 0;
    let merges = 0;
    let everyCommit = 0;

    for (const [day, all] of spelling.days) {
      const count = counted(spelling, day, all);
      commits += count;
      everyCommit += all;

      if (count === 0) {
        continue;
      }

      if (day === 0) {
        undated += count;
      } else {
        first = first === 0 ? day : Math.min(first, day);
        last = Math.max(last, day);
      }
    }

    for (const count of spelling.merges.values()) {
      merges += count;
    }

    mergesOf.set(spelling.name, merges);
    everyCommitOf.set(spelling.name, everyCommit);
    identities.push({ name: spelling.name, emails: [], commits });
  }

  // Sorted before folding too: which spelling names a folded row, when two are equally busy, is decided by
  // the order they arrive in.
  const people = groupAuthors(identities.sort(busiestFirst), custom).sort(busiestFirst);

  /*
   * A person's spellings by all their commits, merges included - the order Authors names a person by - so
   * nobody changes name or colour when merges are counted the other way. Ranked by what the charts count,
   * but named by this.
   */
  const byEveryCommit = (a: AuthorIdentity, b: AuthorIdentity): number =>
    busiestFirst(
      { commits: everyCommitOf.get(a.name) ?? 0, name: a.name },
      { commits: everyCommitOf.get(b.name) ?? 0, name: b.name },
    );
  const membersOf = people.map((person) => [...person.members].sort(byEveryCommit));

  const unit: Unit = first === 0 ? 'week' : unitFor(first, last);
  const buckets: number[] = first === 0 ? [] : bucketStarts(first, last, unit);
  const start = buckets[0] ?? 0;
  const bars = (): number[] => new Array<number>(buckets.length).fill(0);

  const addInto = (into: number[], spelling: SpellingDays): void => {
    for (const [day, all] of spelling.days) {
      const count = counted(spelling, day, all);

      if (day !== 0 && count > 0) {
        const index = bucketIndex(day, start, unit);
        into[index] = (into[index] ?? 0) + count;
      }
    }
  };

  /*
   * Who gets a band: people in order, each with commits to draw and a spelling nobody before them has. A
   * group whose every spelling is already drawn by a busier group would be a band with nothing in it, and
   * so would someone whose every commit is a merge while merges are left out.
   */
  const bringing: number[] = [];
  const brought = new Set<string>();

  for (const [index, person] of people.entries()) {
    if (person.commits > 0 && person.members.some((member) => !brought.has(member.name))) {
      bringing.push(index);
      person.members.forEach((member) => brought.add(member.name));

      if (bringing.length > STACKED + 1) {
        break;
      }
    }
  }

  const stacked = bringing.length > STACKED + 1 ? bringing.slice(0, STACKED) : bringing;
  const hues = assignHues(stacked.map((index) => membersOf[index]?.[0]?.name ?? ''));
  const drawn = new Set<string>();

  const series = stacked.map((index, band) => {
    const counts = bars();

    for (const member of people[index]?.members ?? []) {
      // Once, in the busiest band that has it: a spelling in two groups is in two rows of the people chart,
      // but its commits are each one commit's height of bar.
      if (drawn.has(member.name)) {
        continue;
      }

      drawn.add(member.name);

      const spelling = tally.spelling(member.name);

      if (spelling !== undefined) {
        addInto(counts, spelling);
      }
    }

    return { person: index, hue: hues[band] ?? 0, counts };
  });

  const perBucket = bars();
  const others = bars();

  for (const spelling of tally.spellings()) {
    addInto(perBucket, spelling);

    if (!drawn.has(spelling.name)) {
      addInto(others, spelling);
    }
  }

  const bandOf = new Map(stacked.map((index, band) => [index, band]));
  const total = includeMerges ? tally.total : tally.total - tally.merges;

  return {
    total,
    merges: tally.merges,
    includeMerges,
    truncated: facts.truncated,
    limit: facts.limit,
    scope: facts.scope,
    dated: facts.dated,
    unit,
    buckets,
    perBucket,
    people: people.map((person, index) => ({
      name: person.custom ? person.name : (membersOf[index]?.[0]?.name ?? person.name),
      commits: person.commits,
      merges: person.members.reduce((sum, member) => sum + (mergesOf.get(member.name) ?? 0), 0),
      spellings: (membersOf[index] ?? person.members).map((member) => member.name),
      custom: person.custom,
      series: bandOf.get(index) ?? -1,
    })),
    series,
    others,
    undated,
    overlapping: people.reduce((sum, person) => sum + person.commits, 0) !== total,
  };
}
