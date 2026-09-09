/**
 * The history of a few lines, rather than of a whole file.
 *
 * `git log -L <from>,<to>:<path>` answers the question blame raises. Blame says who touched a line
 * last; this says who touched it before that, and what they were doing at the time - which is the
 * question somebody actually has when they are staring at a line and wondering why it is like that.
 *
 * It is not the file's history narrowed down. git re-derives the range at every step, so a line
 * that moved within the file is followed to where it moved, and a file that was renamed is followed
 * across the rename by the lines themselves rather than by a similarity score. That is the
 * difference from `--follow`, which guesses at whole files and can guess wrong: a file scaffolded
 * by copying its neighbour is followed into the neighbour's history, measured and turned off.
 *
 * **One tip, and that is not a limitation to route around.** `-L` walks from exactly one commit -
 * two refs are `fatal: More than one commit to dig from`, and the shape the graph uses to exclude
 * refs is `fatal: No commit specified?`. So this cannot be the graph's walk narrowed by a filter,
 * and it is not offered as one: it answers from HEAD and says so.
 */

import type { Git } from './exec.ts';
import type { RepoInfo } from './discovery.ts';
import type { Commit } from './logParser.ts';
import { LOG_ARGS, parseLog } from './logParser.ts';

/** The lines being asked about, one-based and inclusive, the way an editor counts them. */
export interface LineRange {
  /** Repo-relative, spelled the way git spells it. */
  readonly path: string;
  readonly from: number;
  readonly to: number;
}

/**
 * How far back to go.
 *
 * Deep enough that the answer is the whole story for any line anybody asks about, and shallow
 * enough that a line living in a file that changes constantly cannot turn a right-click into a walk
 * of the entire repository.
 */
const LIMIT = 200;

/** `-L` numbers lines from one, and an editor that gave us a zero would silently mean line one. */
export function clampRange(range: LineRange): LineRange {
  const from = Math.max(1, Math.floor(range.from));

  return { path: range.path, from, to: Math.max(from, Math.floor(range.to)) };
}

/**
 * Commits that touched these lines, newest first.
 *
 * `--no-patch` because `-L` implies a diff and this wants the commits; the format is the same one
 * the graph's walk uses, so there is one parser and one format to keep in step rather than two.
 */
export async function lineHistory(
  git: Git,
  repo: RepoInfo,
  range: LineRange,
): Promise<Commit[]> {
  const { path, from, to } = clampRange(range);

  const out = await git.runRead(repo.root, [
    'log',
    ...LOG_ARGS,
    '--no-patch',
    `--max-count=${LIMIT}`,
    /*
     * One argument rather than two, because `-L` takes its whole spec after the flag and a path
     * that begins with a dash would otherwise be read as one. The path is not a pathspec here -
     * no globs, no magic - so it goes in exactly as git spells it.
     */
    `-L${from},${to}:${path}`,
  ]);

  return parseLog(out);
}
