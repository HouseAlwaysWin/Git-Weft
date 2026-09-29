/**
 * The other working trees of this repository.
 *
 * `git worktree add` gives one repository several working directories. Each has its own root, its
 * own index and its own HEAD; they share the refs, the objects and the config. That sharing is the
 * whole reason these are worth showing: a branch checked out in one tree cannot be checked out in
 * another, and git's refusal names a path the user may have forgotten exists.
 *
 * Read with `-z` where git is new enough for it (2.36). Without it every attribute is a line and
 * records are separated by a blank one, so a path containing a newline - legal everywhere except
 * Windows - or a `git worktree lock --reason` typed across two lines silently merges two records
 * into one. The flag costs nothing, and `Git.atLeast` is already cached from the date filter.
 */

import type { Git } from './exec.ts';
import { until } from './exec.ts';
import type { RepoInfo } from './discovery.ts';

export interface Worktree {
  /** Absolute, with forward slashes - git prints them that way even on Windows. */
  readonly path: string;
  /** Where that tree's HEAD is. A bare repository has no working tree and so no HEAD here. */
  readonly head: string | null;
  /** `refs/heads/…`, or null when the tree is detached or bare. */
  readonly branch: string | null;
  /** The main worktree, which is a bare repository. It has no files and cannot be removed. */
  readonly bare: boolean;
  /**
   * Locked against pruning, with git's reason - which may be empty, because `--reason` is optional.
   * A tree on a removable disk is the case the flag exists for: absent, not gone.
   */
  readonly locked: { readonly reason: string } | null;
  /** git's own words for why it could be pruned, e.g. that the directory is no longer there. */
  readonly prunable: string | null;
  /** The first record, which git always makes the main worktree. It is the one that cannot go. */
  readonly main: boolean;
}

/** `-z` where git has it; the parser is told which separator it is about to see. */
export function worktreeListArgs(nulSeparated: boolean): string[] {
  const args = ['worktree', 'list', '--porcelain'];

  return nulSeparated ? [...args, '-z'] : args;
}

/** The git version `worktree list -z` arrived in. */
export const NUL_SEPARATED_SINCE = { major: 2, minor: 36 };

/**
 * Split one attribute into its key and the rest.
 *
 * `detached` and `bare` are bare words; `locked` may be either. So the key is up to the first
 * space, and everything after it is the value - which for `prunable` and `locked` is a sentence
 * that may contain spaces of its own.
 */
function attribute(line: string): { key: string; value: string } {
  const space = line.indexOf(' ');

  return space === -1
    ? { key: line, value: '' }
    : { key: line.slice(0, space), value: line.slice(space + 1) };
}

export function parseWorktrees(output: string, nulSeparated: boolean): Worktree[] {
  const [between, within] = nulSeparated ? ['\0\0', '\0'] : ['\n\n', '\n'];

  return output
    .split(between)
    .flatMap((record) => {
      const lines = record.split(within).filter((line) => line.length > 0);
      const first = lines[0] === undefined ? null : attribute(lines[0]);

      // Every record opens with its path. Anything else is a trailing separator, or git saying
      // something this version does not know about; either way there is no worktree to show.
      if (first === null || first.key !== 'worktree' || first.value.length === 0) {
        return [];
      }

      let head: string | null = null;
      let branch: string | null = null;
      let bare = false;
      let locked: { reason: string } | null = null;
      let prunable: string | null = null;

      for (const line of lines.slice(1)) {
        const { key, value } = attribute(line);

        if (key === 'HEAD') {
          head = value;
        } else if (key === 'branch') {
          branch = value;
        } else if (key === 'bare') {
          bare = true;
        } else if (key === 'locked') {
          locked = { reason: value };
        } else if (key === 'prunable') {
          prunable = value;
        }
        // `detached` is the absence of a branch, which is already how this is held.
      }

      return [{ path: first.value, head, branch, bare, locked, prunable, main: false }];
    })
    .map((worktree, at) => (at === 0 ? { ...worktree, main: true } : worktree));
}

export async function listWorktrees(
  git: Git,
  repo: RepoInfo,
  signal?: AbortSignal,
): Promise<Worktree[]> {
  const nulSeparated = await git.atLeast(NUL_SEPARATED_SINCE.major, NUL_SEPARATED_SINCE.minor);

  // A repository always has at least its own working tree, so an empty answer means the command
  // failed - an old git, a repository mid-clone - and the caller is better off told nothing than
  // told there are none.
  const out = await git
    .runRead(repo.root, worktreeListArgs(nulSeparated), until(signal))
    .catch(() => '');

  return parseWorktrees(out, nulSeparated);
}

/**
 * Which tree, if any, has this branch checked out.
 *
 * `here` is the one tree the answer ignores, and which that is depends on what is being asked.
 * Checking a branch out ignores the tree doing the asking, because being on a branch is no reason to
 * refuse to check it out. Making a worktree for a branch ignores nothing - git refuses that for the
 * branch you are standing on as readily as for one open in another folder - and passes null.
 *
 * Compared case-insensitively because Windows paths are, and with slashes normalised because git
 * prints forward ones where VS Code hands back backslashes.
 */
export function branchIsOut(
  worktrees: readonly Worktree[],
  ref: string,
  here: string | null,
): Worktree | null {
  const mine = here === null ? null : here.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');

  return (
    worktrees.find(
      (worktree) =>
        worktree.branch === ref && worktree.path.toLowerCase().replace(/\/$/, '') !== mine,
    ) ?? null
  );
}
