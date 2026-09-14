/**
 * Clean up merged branches: the local branches whose work is already in a base, deleted together.
 *
 * The one write here that deletes more than one thing, and everything about it is shaped by that. It
 * asks in steps, and any step can be the last: which base; which branches - the merged ones ticked,
 * oldest first, and the ones whose upstream is gone listed after them, unticked; when any of those are
 * chosen, whether to strand their commits; and once, with the count, whether to go ahead. Every tip is
 * written to the log before anything is deleted, because a deleted branch takes its reflog with it.
 * And git is asked with -d, so it still refuses a branch it does not count as merged - and whatever it
 * refuses is named, not forced.
 */

import type { Action, ActionContext, ActionResult } from './types.ts';
import { Tier, blockedByOperation } from './types.ts';
import { orphanCount } from './branches.ts';
import { describeAge } from '../git/blame.ts';
import { chunk, planCleanup, protectedBy } from '../git/cleanup.ts';
import type { LocalBranch } from '../git/localBranches.ts';
import { localBranches, mergedInto } from '../git/localBranches.ts';

/** The answer that strands commits, spelled once so the question and the check cannot drift apart. */
const STRAND = 'Delete Them Too';

const cleanUpBranches: Action = {
  id: 'weft.cleanUpBranches',
  group: 'danger',
  // Its questions are its own, asked in order inside `run`: the confirmation has to name what was
  // picked, and nothing has been picked before `run` begins.
  tier: Tier.Safe,

  label: () => 'Clean Up Merged Branches…',

  appliesTo: (target) => target.kind === 'repo',

  unavailable: (_target, state) => blockedByOperation(state),

  async run(context): Promise<ActionResult> {
    const { git, repo, state, ui } = context;
    const base = await chooseBase(context);

    if (base === null) {
      return { message: '', ran: false };
    }

    const [branches, merged] = await Promise.all([localBranches(git, repo), mergedInto(git, repo, base)]);
    const plan = planCleanup(branches, merged, base, protectedBy(ui.protectedBranches()));

    if (plan.merged.length === 0 && plan.stranded.length === 0) {
      // Said without a reload: nothing moved, and a walk of the history to show it would be for nothing.
      ui.notify(`nothing to clean up: no other local branch is merged into ${base}`);
      return { message: '', ran: false };
    }

    const orphans = new Map<string, number>();

    if (plan.stranded.length > 0) {
      await ui.progress('Counting what the unmerged branches would strand', async () => {
        for (const branch of plan.stranded) {
          orphans.set(branch.name, await orphanCount(git, repo, branch.name));
        }
      });
    }

    const picked = await ui.pick({
      title: `Delete which branches? ${plan.merged.length} merged into ${base}`,
      placeholder: 'The merged ones are ticked, oldest first; after them, branches whose upstream is gone',
      items: [
        ...plan.merged.map((branch) => ({ label: branch.name, description: describe(branch, 'merged'), picked: true })),
        ...plan.stranded.map((branch) => ({
          label: branch.name,
          description: describe(branch, `upstream gone, ${commits(orphans.get(branch.name) ?? 0)} only here`),
          picked: false,
        })),
      ],
    });

    if (picked === null || picked.length === 0) {
      return { message: '', ran: false };
    }

    const chosen = new Set(picked);
    const mergedChosen = plan.merged.filter((branch) => chosen.has(branch.name));
    let strandedChosen = plan.stranded.filter((branch) => chosen.has(branch.name));

    // What is not merged takes a choice of its own: ticking one in a list of a hundred is not the same
    // as deciding to strand what is on it.
    if (strandedChosen.length > 0) {
      const lost = strandedChosen.reduce((sum, branch) => sum + (orphans.get(branch.name) ?? 0), 0);
      const answer = await ui.choose({
        title: `${strandedChosen.length} of these ${strandedChosen.length === 1 ? 'is' : 'are'} not merged`,
        detail:
          `${commits(lost)} would be on no branch: recoverable from the tips written to the log, and ` +
          'from the reflog for a while, then garbage collected.',
        options: ['Merged Only', STRAND],
      });

      if (answer === null) {
        return { message: '', ran: false };
      }

      if (answer !== STRAND) {
        strandedChosen = [];
      }
    }

    const doomed = [...mergedChosen, ...strandedChosen];

    if (doomed.length === 0) {
      return { message: '', ran: false };
    }

    const confirmed = await ui.confirm({
      title: `Delete ${branchesOf(doomed.length)}?`,
      detail: [
        ...doomed.slice(0, 20).map((branch) => branch.name),
        ...(doomed.length > 20 ? [`… and ${doomed.length - 20} more`] : []),
        '',
        'Each tip is written to the Weft log first, so any of them can be put back.',
      ].join('\n'),
      confirmLabel: `Delete ${branchesOf(doomed.length)}`,
      destructive: true,
    });

    if (!confirmed) {
      return { message: '', ran: false };
    }

    // Before anything goes: a deleted branch takes its reflog with it, and this is then the record.
    for (const branch of doomed) {
      ui.log(`clean-up: ${branch.name} was ${branch.sha} - "git branch ${branch.name} ${branch.sha}" puts it back`);
    }

    await ui.progress(`Deleting ${branchesOf(doomed.length)}`, async () => {
      for (const [flag, list] of [
        ['-d', mergedChosen],
        ['-D', strandedChosen],
      ] as const) {
        for (const names of chunk(list.map((branch) => branch.name))) {
          // A refusal is one name among many, and git goes on with the rest; what it kept is read below.
          await git.runWrite(repo.root, ['branch', flag, ...names]).catch(() => undefined);
        }
      }
    });

    const left = new Set((await localBranches(git, repo)).map((branch) => branch.name));
    const refused = doomed.filter((branch) => left.has(branch.name)).map((branch) => branch.name);
    const deleted = doomed.length - refused.length;

    if (refused.length > 0) {
      ui.log(
        `clean-up: git kept ${refused.join(', ')}. -d asks whether a branch is merged into its upstream, ` +
          `or into HEAD (${state.branch ?? 'detached'}) when it tracks nothing - not into ${base}.`,
      );
    }

    return {
      message:
        refused.length === 0
          ? `Deleted ${branchesOf(deleted)}, each tip written to the log`
          : `Deleted ${branchesOf(deleted)}; git kept ${refused.length} it does not count as merged - see the log`,
      ran: deleted > 0,
    };
  },
};

/**
 * What "merged" is measured against: what the remote calls its main line first - `origin/HEAD`, which
 * was release/v1.3 where this was asked for, a repository with no develop and no main - and then the
 * branch HEAD is on. Asked only when there is a choice between the two.
 */
async function chooseBase({ git, repo, state, ui }: ActionContext): Promise<string | null> {
  const remoteHead = (
    await git.runRead(repo.root, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']).catch(() => '')
  ).trim();
  const options = [...new Set([remoteHead, state.branch ?? ''].filter((name) => name.length > 0))];

  if (options.length < 2) {
    return options[0] ?? null;
  }

  return ui.choose({
    title: 'Clean up the branches merged into…',
    detail: `${remoteHead} is what origin calls its main line, and ${state.branch ?? ''} is the branch you are on.`,
    options,
  });
}

function describe(branch: LocalBranch, what: string): string {
  return branch.updated > 0 ? `${what} · ${describeAge(branch.updated)}` : what;
}

function commits(n: number): string {
  return `${n} commit${n === 1 ? '' : 's'}`;
}

function branchesOf(n: number): string {
  return `${n} branch${n === 1 ? '' : 'es'}`;
}

export const CLEANUP_ACTIONS: readonly Action[] = [cleanUpBranches];
