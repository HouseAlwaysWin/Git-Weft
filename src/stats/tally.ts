/**
 * A walk's commits, counted by who wrote them and on which day.
 *
 * Counted from the pages the graph is drawing anyway, rather than by asking git a second time: that walk
 * already holds exactly the commits the charts are about, filtered exactly as the graph is, and a second
 * one would cost as long as the first while being free to disagree with it. What stays is a count per
 * spelling per day - thousands of numbers for a history of any length, and nothing per commit.
 */

import type { Commit } from '../git/logParser.ts';
import { monthLength } from './calendar.ts';

/** `0` and `-`, as `charCodeAt` has them. */
const ZERO = 48;
const DASH = 45;

/**
 * The day a commit was made on its author's calendar, as `YYYYMMDD`, or 0 when the text is not a date.
 *
 * Read off the front of `%aI` rather than parsed. `2026-01-16T00:30:00+08:00` was the 16th where it was
 * written and the 15th in UTC, and the graph's row says the 16th - so going through `Date` would put a
 * commit on a different day from the row it came from, for every author a time zone away from UTC.
 *
 * Called for every commit a walk produces, which is why it is ten `charCodeAt`s and no strings.
 */
export function dayOf(iso: string): number {
  if (iso.length < 10 || iso.charCodeAt(4) !== DASH || iso.charCodeAt(7) !== DASH) {
    return 0;
  }

  let day = 0;

  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) {
      continue;
    }

    const digit = iso.charCodeAt(i) - ZERO;

    if (digit < 0 || digit > 9) {
      return 0;
    }

    day = day * 10 + digit;
  }

  const month = Math.floor(day / 100) % 100;
  const date = day % 100;

  return month >= 1 && month <= 12 && date >= 1 && date <= monthLength(Math.floor(day / 10_000), month)
    ? day
    : 0;
}

/** What a walk covered besides its commits, for the sentence that says what the charts count. */
export interface WalkFacts {
  /** The walk stopped at `limit` commits, so the oldest history is not in it. */
  readonly truncated: boolean;
  /** `weft.maxCommits`, as the walk read it. */
  readonly limit: number;
  /** What the graph was narrowed to, in words: see `describeScope`. */
  readonly scope: string;
  /** A date range narrowed the walk. git compares it with committer dates; the charts count author dates. */
  readonly dated: boolean;
}

/** A graph's latest walk, as the statistics see it. */
export type Walk =
  | { readonly state: 'walking' }
  | { readonly state: 'failed'; readonly message: string }
  | { readonly state: 'done'; readonly tally: CommitTally; readonly facts: WalkFacts };

/** One spelling's commits, by day. */
export interface SpellingDays {
  /** The name exactly as git records it. */
  readonly name: string;
  /** Day, then commits made that day, merges included. Day 0 holds the commits whose date could not be read. */
  readonly days: ReadonlyMap<number, number>;
  /** Day, then how many of that day's commits were merges. A day with none is not in it. */
  readonly merges: ReadonlyMap<number, number>;
}

/** What a tally reads of a commit: who, when, and how many parents - more than one is a merge. */
export type TalliedCommit = Pick<Commit, 'author' | 'authorDate'> & { readonly parents?: readonly string[] };

/**
 * A copy of a string that owns its characters.
 *
 * Every field the log parser hands out is cut from the text git wrote, and V8 keeps a cut string's whole
 * source alive for as long as the piece is held - `docs/design.md` has the measurement. The tally keeps a
 * name per spelling for as long as the graph is open, and a name kept as it arrived could be holding on
 * to a whole chunk of `git log` output.
 */
function detach(text: string): string {
  return JSON.parse(JSON.stringify(text)) as string;
}

/** A spelling as the tally keeps it. */
interface Counts {
  readonly name: string;
  readonly days: Map<number, number>;
  readonly merges: Map<number, number>;
}

export class CommitTally {
  private readonly bySpelling = new Map<string, Counts>();
  private commits = 0;
  private merged = 0;

  /** The spelling counted last. A history runs in stretches by one person, and a stretch costs one lookup. */
  private last: Counts | null = null;

  /** Every commit counted, each once, merges included. */
  get total(): number {
    return this.commits;
  }

  /** How many of them were merges. */
  get merges(): number {
    return this.merged;
  }

  /** Count a page of commits. */
  add(commits: readonly TalliedCommit[]): void {
    for (const commit of commits) {
      let spelling = this.last;

      if (spelling === null || spelling.name !== commit.author) {
        spelling = this.bySpelling.get(commit.author) ?? null;

        if (spelling === null) {
          const name = detach(commit.author);
          spelling = { name, days: new Map(), merges: new Map() };
          this.bySpelling.set(name, spelling);
        }

        this.last = spelling;
      }

      const day = dayOf(commit.authorDate);
      spelling.days.set(day, (spelling.days.get(day) ?? 0) + 1);

      // More than one parent. A stash arrives with its extra parents already folded away, so it is not one.
      if ((commit.parents?.length ?? 0) > 1) {
        spelling.merges.set(day, (spelling.merges.get(day) ?? 0) + 1);
        this.merged += 1;
      }
    }

    this.commits += commits.length;
  }

  /** Every spelling counted, with its commits and merges by day. */
  spellings(): Iterable<SpellingDays> {
    return this.bySpelling.values();
  }

  /** One spelling's counts, or undefined for a spelling with none in this walk. */
  spelling(name: string): SpellingDays | undefined {
    return this.bySpelling.get(name);
  }
}
