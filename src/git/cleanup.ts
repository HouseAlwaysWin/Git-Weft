/**
 * Which local branches a clean-up offers to delete, and how the deleting is split up.
 *
 * Measured where it was asked for: 135 of 151 local branches were already merged into the release
 * branch, most untouched for months, with nothing to say which. Deleting them a right-click at a time
 * is an afternoon, and deleting the wrong one is a branch somebody still needed. So the offer carries
 * its reasons: what is merged, ticked and oldest first; what tracked a branch the server no longer
 * has but holds commits of its own, offered unticked; and what is never offered, and why.
 */

import type { LocalBranch } from './localBranches.ts';

/** What a clean-up offers, and what it will not touch. */
export interface CleanupPlan {
  /** Every commit already in the base. Oldest first, since the oldest are the likeliest to be done with. */
  readonly merged: LocalBranch[];
  /**
   * Tracked a branch the server no longer has, and holds commits the base does not. Offered, never
   * ticked: deleting one strands its commits, so it takes a choice of its own. Oldest first.
   */
  readonly stranded: LocalBranch[];
  /** Never offered, each with the reason. */
  readonly kept: { readonly name: string; readonly why: string }[];
}

/**
 * A matcher for `weft.protectedBranches`: `*` is any run of characters, slashes included, and the rest
 * is matched as it is written - case too, because git's names are.
 */
export function protectedBy(globs: readonly string[]): (name: string) => boolean {
  const patterns = globs
    .map((glob) => glob.trim())
    .filter((glob) => glob.length > 0)
    .map((glob) => new RegExp(`^${glob.split('*').map(literal).join('.*')}$`));

  return (name) => patterns.some((pattern) => pattern.test(name));
}

function literal(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sort the branches into what is offered and what is kept.
 *
 * Kept, whatever else is true of them: the branch HEAD is on and one checked out in another worktree,
 * neither of which git will delete; the base itself; and whatever the protected list names.
 */
export function planCleanup(
  branches: readonly LocalBranch[],
  merged: ReadonlySet<string>,
  base: string,
  isProtected: (name: string) => boolean,
): CleanupPlan {
  const plan: CleanupPlan = { merged: [], stranded: [], kept: [] };

  for (const branch of branches) {
    const why = branch.head
      ? 'checked out here'
      : branch.worktree !== null
        ? `checked out in ${branch.worktree}`
        : branch.name === base
          ? 'the base'
          : isProtected(branch.name)
            ? 'protected'
            : null;

    if (why !== null) {
      plan.kept.push({ name: branch.name, why });
    } else if (merged.has(branch.name)) {
      plan.merged.push(branch);
    } else if (branch.gone) {
      plan.stranded.push(branch);
    }
  }

  plan.merged.sort(oldestFirst);
  plan.stranded.sort(oldestFirst);
  return plan;
}

function oldestFirst(a: LocalBranch, b: LocalBranch): number {
  return a.updated - b.updated;
}

/**
 * Names split so that no one `git branch -d` is given more than `maxNames` of them, or more than
 * `maxChars` of command line. Windows stops a command line at 32,767 characters, and a hundred and
 * thirty-five branch names is a fair way towards it; fifty at a time keeps each command well clear,
 * and each step of the progress short.
 */
export function chunk(names: readonly string[], maxNames = 50, maxChars = 8000): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let chars = 0;

  for (const name of names) {
    if (current.length > 0 && (current.length >= maxNames || chars + name.length + 1 > maxChars)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }

    current.push(name);
    chars += name.length + 1;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}
