/**
 * Merge, rebase, and getting out of either one.
 *
 * The operations themselves are two thin actions. The weight is in the third part: when a merge or
 * a rebase stops on a conflict, git leaves the repository in a state that has to be finished or
 * abandoned before anything else can happen, and a tool that shows a graph without showing that
 * state is how people end up three commands deep in something they did not know they were in.
 *
 * Weft does not try to resolve conflicts. VS Code's merge editor is better at that than anything
 * that would fit here, so Weft's job is to say what is going on, list the files, and offer the
 * three ways out git actually provides.
 */

import type { Action } from './types.ts';
import { Tier, blockedByOperation, revisionOf, shortLabel } from './types.ts';
import type { Git } from '../git/exec.ts';
import type { RepoInfo } from '../git/discovery.ts';
import { Operation, describeOperation } from '../git/repoState.ts';

/** The git subcommand each in-progress operation is finished or abandoned with. */
const CONTROL: Partial<Record<Operation, { verb: string; skips: boolean }>> = {
  [Operation.Merge]: { verb: 'merge', skips: false },
  [Operation.CherryPick]: { verb: 'cherry-pick', skips: true },
  [Operation.Revert]: { verb: 'revert', skips: true },
  [Operation.Rebase]: { verb: 'rebase', skips: true },
};

/**
 * Whether merging `revision` would just move the branch forward.
 *
 * True when HEAD is already an ancestor of it: nothing on this branch is missing from there, so git
 * can move the pointer and record nothing. That is the only case where "how should this merge" is a
 * real question - when the histories have both moved, a merge commit is the only thing a merge can
 * produce, and asking would be offering a choice of one.
 */
async function canFastForward(git: Git, repo: RepoInfo, revision: string): Promise<boolean> {
  return git
    .runRead(repo.root, ['merge-base', '--is-ancestor', 'HEAD', revision])
    .then(() => true)
    .catch(() => false);
}

async function countAhead(git: Git, repo: RepoInfo, revision: string): Promise<number> {
  const out = await git
    .runRead(repo.root, ['rev-list', '--count', `HEAD..${revision}`])
    .catch(() => '0');

  return Number(out.trim()) || 0;
}

const merge: Action = {
  id: 'weft.merge',
  group: 'commit',
  // Forwards only: a merge adds a commit and moves the branch on. Nothing stops being reachable,
  // and a conflicted merge can be abandoned outright.
  tier: Tier.Safe,

  label: (target) => `Merge ${shortLabel(target)} into the current branch`,

  appliesTo: (target) => target.kind === 'ref' && target.refKind !== 'tag',

  unavailable(target, state) {
    const blocked = blockedByOperation(state);

    if (blocked !== null) {
      return blocked;
    }

    if (state.branch === null) {
      return 'Not on a branch';
    }

    if (target.kind === 'ref' && state.branch === target.label) {
      return 'Already on this branch';
    }

    return null;
  },

  async run({ git, repo, state, target, ui }) {
    const revision = revisionOf(target);
    const label = shortLabel(target);
    const branch = state.branch ?? 'HEAD';
    const ahead = await countAhead(git, repo, revision);

    if (ahead === 0) {
      return { message: `${label} is already in ${branch}`, ran: false };
    }

    /*
     * The question is only asked when there is one.
     *
     * With both histories moved, a merge produces a merge commit and there is nothing to choose.
     * With this branch strictly behind, git will move the pointer and record nothing unless told
     * otherwise - and that is a decision, not a default: afterwards there is no sign the two were
     * ever apart. The same shape as pull, which asks merge or rebase only once they have diverged.
     */
    const extra: string[] = [];

    if (await canFastForward(git, repo, revision)) {
      const choice = await ui.choose({
        title: `${branch} is ${ahead} ${ahead === 1 ? 'commit' : 'commits'} behind ${label}`,
        detail:
          `${branch} has nothing that ${label} does not, so this can simply move forward.\n\n` +
          `Fast-forward moves ${branch} to ${label} and records nothing. Afterwards there is no ` +
          `sign the two were ever separate.\n` +
          `Merge commit keeps the fork in the history and records that this is where ${label} came in.`,
        options: ['Fast-forward', 'Merge commit'],
      });

      if (choice === null) {
        return { message: '', ran: false };
      }

      if (choice === 'Merge commit') {
        extra.push('--no-ff');
      }
    }

    // --no-edit rather than relying on GIT_MERGE_AUTOEDIT: being explicit here means the command
    // behaves the same if anyone ever runs it by hand from the command log.
    await ui.progress(`Merging ${label}`, () =>
      git.runWrite(repo.root, ['merge', '--no-edit', ...extra, revision]),
    );

    const how = extra.length > 0 ? ' with a merge commit' : '';
    return {
      message: `Merged ${ahead} ${ahead === 1 ? 'commit' : 'commits'} from ${label}${how}`,
      ran: true,
    };
  },
};

/**
 * Take a branch's changes without its history.
 *
 * A separate action rather than a third option on the merge menu, because it is a different
 * intention: merging asks how to join two histories, squashing declines to join them at all. It
 * also ends somewhere else - with staged changes and an unmoved HEAD, waiting for a commit that
 * Weft does not make, because committing is Source Control's job and it is better at it.
 *
 * The consequence worth stating before rather than after: git still considers the branch unmerged
 * afterwards. Nothing records where those changes came from, so deleting it later will warn that
 * commits are about to be stranded, and it will be right.
 */
const mergeSquash: Action = {
  id: 'weft.mergeSquash',
  group: 'commit',
  // It writes the index and the working tree, and it can conflict. Nothing is lost that was
  // committed, so not tier 3 - but it is not something to do by accident either.
  tier: Tier.Confirm,

  label: (target) => `Squash ${shortLabel(target)} into the working tree`,

  appliesTo: (target) => target.kind === 'ref' && target.refKind !== 'tag',

  unavailable(target, state) {
    const blocked = blockedByOperation(state);

    if (blocked !== null) {
      return blocked;
    }

    if (state.branch === null) {
      return 'Not on a branch';
    }

    if (target.kind === 'ref' && state.branch === target.label) {
      return 'Already on this branch';
    }

    // A squash lands in the index, so anything already staged would be committed along with it
    // under a message about the branch. That is a surprise nobody wants inside a commit.
    if (state.files.some((file) => file.staged)) {
      return 'Commit or unstage what is already staged first';
    }

    return null;
  },

  async confirmDetail({ git, repo, target, state }) {
    const label = shortLabel(target);
    const ahead = await countAhead(git, repo, revisionOf(target));
    const branch = state.branch ?? 'HEAD';

    return (
      `The changes from ${ahead} ${ahead === 1 ? 'commit' : 'commits'} on ${label} will be staged ` +
      `on ${branch} as one set. Nothing is committed - Source Control has the commit box, and the ` +
      `message git prepared is waiting in it.\n\n` +
      `${branch} will not record where they came from, so git will still consider ${label} ` +
      `unmerged: deleting it afterwards will warn that its commits are about to be stranded, and ` +
      `it will be right.`
    );
  },

  async run({ git, repo, target, state, ui }) {
    const label = shortLabel(target);
    const ahead = await countAhead(git, repo, revisionOf(target));

    if (ahead === 0) {
      return { message: `${label} has nothing that ${state.branch ?? 'HEAD'} does not`, ran: false };
    }

    await ui.progress(`Squashing ${label}`, () =>
      git.runWrite(repo.root, ['merge', '--squash', revisionOf(target)]),
    );

    return {
      message: `Staged ${ahead} ${ahead === 1 ? "commit's" : "commits'"} worth of changes from ${label}. Commit them in Source Control.`,
      ran: true,
    };
  },
};

/** The command that starts an interactive rebase. What makes it interactive is the environment below. */
export function interactiveRebaseArgs(revision: string): string[] {
  return ['rebase', '-i', revision];
}

/**
 * The editors git is given for it.
 *
 * In the environment rather than through `-c sequence.editor`, because the environment is what was in
 * the way: every write runs with `GIT_SEQUENCE_EDITOR=true` and `GIT_EDITOR=true` so that nothing a
 * write does can stop and wait for somebody (`gitEnv` in `git/exec.ts`), and git reads both of those
 * before it reads any config. A `-c sequence.editor` therefore never reached git at all - the rebase
 * ran with every commit picked while the confirmation promised a list.
 *
 * Both of them, not one: `GIT_SEQUENCE_EDITOR` draws the list, and `GIT_EDITOR` is what a `reword` stops
 * at. Left at `true` that one keeps the old message without saying so, which is the same failure one
 * step further in.
 *
 * `code` is VS Code's own command line, which its installer puts on the PATH; where it is not, git says
 * so and the rebase stops before it has done anything. This deliberately overrides an editor of
 * somebody's own for this one command, because the menu item exists to open Weft's list - `git rebase
 * -i` in a terminal is untouched by any of it.
 */
export function interactiveRebaseEnv(): NodeJS.ProcessEnv {
  return { GIT_SEQUENCE_EDITOR: 'code --wait', GIT_EDITOR: 'code --wait' };
}

const rebase: Action = {
  id: 'weft.rebase',
  group: 'commit',
  // Rebase rewrites commits: the originals stop being reachable from the branch, and only the
  // reflog still knows about them.
  tier: Tier.Confirm,

  label: (target) => `Rebase the current branch onto ${shortLabel(target)}`,

  appliesTo: (target) => target.kind === 'commit' || (target.kind === 'ref' && target.refKind !== 'tag'),

  unavailable(target, state) {
    const blocked = blockedByOperation(state);

    if (blocked !== null) {
      return blocked;
    }

    if (state.branch === null) {
      return 'Not on a branch';
    }

    if (target.kind === 'ref' && state.branch === target.label) {
      return 'Already on this branch';
    }

    return null;
  },

  async confirmDetail({ git, repo, state, target }) {
    const revision = revisionOf(target);
    const rewritten = await git
      .runRead(repo.root, ['rev-list', '--count', `${revision}..HEAD`])
      .catch(() => '0');

    const count = Number(rewritten.trim()) || 0;
    const branch = state.branch ?? 'HEAD';

    if (count === 0) {
      return `${branch} has nothing that ${shortLabel(target)} does not, so this only moves the branch.`;
    }

    return (
      `${count} ${count === 1 ? 'commit' : 'commits'} on ${branch} will be rewritten onto ` +
      `${shortLabel(target)}. They get new hashes; the originals stay in the reflog.\n\n` +
      'If any of them are already pushed, everyone else will need to reconcile.'
    );
  },

  async run({ git, repo, state, target, ui }) {
    const branch = state.branch ?? 'HEAD';

    await ui.progress(`Rebasing ${branch}`, () =>
      git.runWrite(repo.root, ['rebase', revisionOf(target)]),
    );

    return { message: `Rebased ${branch} onto ${shortLabel(target)}`, ran: true };
  },
};

/**
 * The same rebase, with the list of commits opened first.
 *
 * git writes the list and waits for an editor; VS Code opens it, and Weft's own editor draws it as rows
 * rather than as text. Closing that editor is what lets the rebase run, which is git's own arrangement
 * and not something added here.
 */
const rebaseInteractive: Action = {
  id: 'weft.rebaseInteractive',
  group: 'commit',
  tier: Tier.Confirm,

  label: (target) => `Rebase the current branch onto ${shortLabel(target)}, interactively…`,

  appliesTo: (target) => target.kind === 'commit' || (target.kind === 'ref' && target.refKind !== 'tag'),

  unavailable: (target, state) => rebase.unavailable?.(target, state) ?? null,

  async confirmDetail(context) {
    const said = await rebase.confirmDetail?.(context);

    return `${said ?? ''}\n\nThe list of commits opens first: closing it starts the rebase, and emptying it stops.`;
  },

  async run({ git, repo, state, target, ui }) {
    const branch = state.branch ?? 'HEAD';

    /*
     * This waits for as long as the list is open, which is the point of it: git is holding the rebase
     * until its editor closes. Writes take no timeout, so a list somebody thinks about for an hour is
     * a rebase that still runs afterwards.
     */
    await ui.progress(`Rebasing ${branch}`, () =>
      git.runWrite(repo.root, interactiveRebaseArgs(revisionOf(target)), { env: interactiveRebaseEnv() }),
    );

    return { message: `Rebased ${branch} onto ${shortLabel(target)}`, ran: true };
  },
};

/**
 * The three ways out of a stopped operation.
 *
 * These are the mirror image of every other action: they are the only things available *while* an
 * operation is in progress, and unavailable at any other time.
 */
function control(
  kind: 'continue' | 'abort' | 'skip',
  options: { tier: Tier; label: string; detail?: string },
): Action {
  return {
    id: `weft.${kind}Operation`,
    // All three are the same kind of thing - a way out - and the banner selects on exactly this.
    // Abort still renders in red: the view styles by tier, not by group.
    group: 'operation',
    tier: options.tier,

    label: () => options.label,

    appliesTo: (target) => target.kind === 'repo',

    unavailable(_target, state) {
      if (state.operation === Operation.None) {
        return 'Nothing in progress';
      }

      const entry = CONTROL[state.operation];

      if (entry === undefined) {
        // Bisect and squash are the odd ones out: neither has a --continue, and each has its own
        // way back. A squash is concluded by committing, which is Source Control's box, not a
        // button here.
        return kind === 'abort'
          ? null
          : state.operation === Operation.Squash
            ? 'Commit it in Source Control, or abandon it'
            : 'Not available for this operation';
      }

      if (kind === 'skip' && !entry.skips) {
        return 'A merge cannot skip a commit';
      }

      if (kind === 'continue' && state.files.some((file) => file.conflicted)) {
        return 'Resolve the conflicts first';
      }

      return null;
    },

    async confirmDetail({ state }) {
      const name = describeOperation(state.operation) ?? 'the operation';
      return options.detail?.replace('{operation}', name) ?? '';
    },

    async run({ git, repo, state, ui }) {
      const name = describeOperation(state.operation) ?? 'the operation';
      const entry = CONTROL[state.operation];

      /*
       * Bisect ends with `bisect reset` rather than an --abort flag, and a squash ends with neither:
       * it left no MERGE_HEAD, so `merge --abort` refuses it outright. `reset --merge` is what
       * actually undoes one - it drops the staged result, the conflict markers and SQUASH_MSG
       * together, and leaves the branch where it already was.
       */
      const args =
        state.operation === Operation.Squash
          ? ['reset', '--merge']
          : entry === undefined
            ? ['bisect', 'reset']
            : [entry.verb, `--${kind}`];

      await ui.progress(`${options.label} ${name}`, () => git.runWrite(repo.root, args));

      return { message: `${options.label} ${name}`, ran: true };
    },
  };
}

export const MERGE_ACTIONS: readonly Action[] = [
  merge,
  mergeSquash,
  rebase,
  rebaseInteractive,
  control('continue', { tier: Tier.Safe, label: 'Continue' }),
  control('skip', {
    tier: Tier.Confirm,
    label: 'Skip',
    detail:
      'The commit being applied is dropped and {operation} carries on with the next one. It stays in the reflog.',
  }),
  control('abort', {
    tier: Tier.Confirm,
    label: 'Abort',
    detail:
      'Everything {operation} has done so far is undone and the repository goes back to where it started.',
  }),
];
