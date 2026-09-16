/**
 * The last commit that touched a file, read from `git log -1` and worded for the line above it.
 *
 * Pure, so what the lens says is tested in Node: the running of git is in `codeLens.ts`, and what it
 * says about the answer is here.
 */

import { describeAge } from './blame.ts';

/** The commit that last touched a file. */
export interface LastChange {
  readonly sha: string;
  readonly author: string;
  /** When it was authored, in milliseconds, or 0 when the date could not be read. */
  readonly at: number;
}

/**
 * `git log -1 --format=%H%x00%aN%x00%aI -- <path>`, read.
 *
 * Null for a file no commit has touched - one just made, or one only ever ignored - where git says
 * nothing at all rather than saying so.
 */
export function parseLastChange(out: string): LastChange | null {
  const [sha = '', author = '', date = ''] = out.trim().split('\0');

  if (!/^[0-9a-f]{40}$/.test(sha)) {
    return null;
  }

  const at = Date.parse(date);

  return { sha, author, at: Number.isNaN(at) ? 0 : at };
}

/**
 * What the line above the file says: "Ada Fischer, 3 days ago".
 *
 * A date that could not be read leaves the name on its own rather than putting a wrong age beside it:
 * `Date.parse` of nothing is 1970, and "56 years ago" above a file changed this morning is worse than
 * saying less.
 */
export function describeLastChange(change: LastChange, now: number = Date.now()): string {
  return change.at === 0 ? change.author : `${change.author}, ${describeAge(change.at, now)}`;
}
