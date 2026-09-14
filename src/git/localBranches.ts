/**
 * The local branches, read once: what each points at, what it tracks and whether that is gone, when
 * it last moved, and whether a worktree has it checked out.
 *
 * One `for-each-ref` for all of it, shared by everything that asks about the local branches as a set:
 * cleaning up the merged ones, and which of them a remote branch leaves tracking nothing.
 */

import type { Git } from './exec.ts';
import type { RepoInfo } from './discovery.ts';

export interface LocalBranch {
  readonly name: string;
  readonly sha: string;
  /** `origin/main`, or null when it tracks nothing. */
  readonly upstream: string | null;
  /** It tracked a branch that is not there any more: deleted on the server, and pruned by a fetch. */
  readonly gone: boolean;
  /** Committer date of its tip, epoch milliseconds. */
  readonly updated: number;
  /** The worktree it is checked out in - this one included - or null. */
  readonly worktree: string | null;
  /** HEAD is on it, in this worktree. */
  readonly head: boolean;
}

const FORMAT = [
  '%(refname:short)',
  '%(objectname)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(committerdate:unix)',
  '%(worktreepath)',
  '%(HEAD)',
].join('%00');

export async function localBranches(git: Git, repo: RepoInfo, signal?: AbortSignal): Promise<LocalBranch[]> {
  const out = await git.runRead(
    repo.root,
    ['for-each-ref', `--format=${FORMAT}`, 'refs/heads'],
    signal === undefined ? {} : { signal },
  );

  return parseLocalBranches(out);
}

/** The format above, a branch to a line, NUL between the fields. */
export function parseLocalBranches(out: string): LocalBranch[] {
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name = '', sha = '', upstream = '', track = '', updated = '', worktree = '', head = ''] =
        line.split('\x00');

      return {
        name,
        sha,
        upstream: upstream.length > 0 ? upstream : null,
        gone: track.includes('gone'),
        updated: (Number(updated) || 0) * 1000,
        worktree: worktree.length > 0 ? worktree : null,
        head: head === '*',
      };
    });
}

/**
 * The local branches every one of whose commits is in `base`.
 *
 * Not the same question `git branch -d` asks, which is about a branch's upstream - or HEAD, when it
 * tracks nothing - rather than about a base anybody chose. So this says what is safe to offer, and
 * git still has the last word on each one.
 */
export async function mergedInto(git: Git, repo: RepoInfo, base: string, signal?: AbortSignal): Promise<Set<string>> {
  const out = await git.runRead(
    repo.root,
    ['for-each-ref', '--format=%(refname:short)', `--merged=${base}`, 'refs/heads'],
    signal === undefined ? {} : { signal },
  );

  return new Set(
    out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}
