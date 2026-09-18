/**
 * Merges that took a test site's branch into something that is not one.
 *
 * A site everybody tests on - `uat`, `sit`, `staging` - is a branch with commits of its own on it, and
 * merging it into a feature branch puts those commits on the way to wherever that branch is going. The
 * feature is merged into the trunk in the ordinary way, and the test site's commits arrive with it,
 * asked for by nobody. This finds those merges, and says which have already arrived.
 *
 * Read from the merge message rather than worked out from the shape of the history, which was tried
 * first and does not survive a real repository. The shape says: the second parent of such a merge is
 * the test branch's tip as it was at the time, so look for second parents on that branch's first-parent
 * line. Every `git pull` on the test branch makes a merge of its own, and takes the tip it merged off
 * that line. Measured on a 64,204-commit repository with 2,157 of those pulls: the shape found 39 of
 * the 119 merges the messages name, and offered 2,400 more that were nothing of the kind - mostly the
 * trunk being merged *into* feature branches, which is the opposite of the thing being looked for.
 *
 * So: what git wrote when it made the merge. Which means a merge somebody squashed or rebased leaves
 * nothing to find, and a message somebody rewrote says whatever they rewrote it to - both worth knowing
 * about a report, and neither a reason to prefer an answer that is wrong two times in three.
 */

/** One merge, as `MERGE_ARGS` asks for it. */
export interface MergeLine {
  readonly sha: string;
  readonly author: string;
  /** When it was committed, in seconds. */
  readonly at: number;
  readonly subject: string;
}

/** A merge that took a test branch somewhere. */
export interface TestMerge extends MergeLine {
  /** The name from `weft.testBranches` that it matched, rather than the spelling the message used. */
  readonly branch: string;
  /** What it went into, where the message says - git leaves that out when it was the current branch. */
  readonly into: string | null;
  /** Whether it is in the branch that was asked about. */
  readonly landed: boolean;
}

/** The branch names the setting holds that can be used. */
export function readTestBranches(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * Every merge in the repository, whatever branch it is on, newest first.
 *
 * `--all` rather than the branch being asked about, because a merge that has not arrived yet is the
 * one there is still time to do something about.
 */
export const MERGE_ARGS: readonly string[] = ['log', '--all', '--merges', '--format=%H%x00%an%x00%at%x00%s'];

/** Every branch, local and remote, for `branchChoices` to read. */
export const BRANCH_ARGS: readonly string[] = ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'];

/**
 * The names to offer for `weft.testBranches`, from what `BRANCH_ARGS` asked for.
 *
 * Under the name the setting wants rather than the name the ref has: a remote's copy of `uat` is
 * offered as `uat`, which is what matches both of them, so picking from this list cannot produce a
 * setting that means something narrower than it looks. `origin/HEAD` is a pointer at whatever the
 * remote's default branch is, not a branch, and is left out.
 */
export function branchChoices(output: string): string[] {
  const names = new Set<string>();

  for (const line of output.split('\n')) {
    const ref = line.trim();

    if (ref.startsWith('refs/heads/')) {
      names.add(ref.slice('refs/heads/'.length));
      continue;
    }

    if (!ref.startsWith('refs/remotes/')) {
      continue;
    }

    const rest = ref.slice('refs/remotes/'.length);
    const at = rest.indexOf('/');
    const name = at < 0 ? rest : rest.slice(at + 1);

    if (name.length > 0 && name !== 'HEAD') {
      names.add(name);
    }
  }

  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Read what `MERGE_ARGS` asked for. A record with anything missing is not a merge this can report. */
export function parseMerges(output: string): MergeLine[] {
  return output.split('\n').flatMap((line): MergeLine[] => {
    const [sha, author, at, subject] = line.trim().split('\0');

    if (sha === undefined || author === undefined || at === undefined || subject === undefined) {
      return [];
    }

    const seconds = Number(at);

    return Number.isFinite(seconds) ? [{ sha, author, at: seconds, subject }] : [];
  });
}

/**
 * What a merge message says was merged, and into what.
 *
 * The shapes git writes, and the one a GitLab merge writes, which quotes the target:
 *
 *   Merge branch 'uat'
 *   Merge branch 'uat' into Dev_Thing
 *   Merge branch 'uat' of http://host/group/repo into Dev_Thing
 *   Merge remote-tracking branch 'origin/uat' into Dev_Thing
 *   Merge branch 'uat' into 'uat_deploy'
 *
 * An octopus merge says "Merge branches 'a' and 'b'" and is not read: there is no second branch to
 * report against, and nobody merges a test site three at a time.
 */
export function mergedBranch(subject: string): { readonly branch: string; readonly into: string | null } | null {
  const said = /^Merge (?:remote-tracking )?branch '([^']+)'(?: of \S+)?(?: into '?(.+?)'?)?$/.exec(subject.trim());

  if (said === null || said[1] === undefined) {
    return null;
  }

  return { branch: said[1], into: said[2] ?? null };
}

/**
 * Which of the names a branch is, with whatever remote it may have been read from in front of it.
 *
 * `origin/uat` is `uat`; `uat_deploy` is not, because the whole name has to match and not the start of
 * it - a repository with fifteen branches whose names begin with the test site's is the ordinary case.
 */
function named(branch: string, names: readonly string[]): string | null {
  const read = branch.toLowerCase();

  return names.find((name) => read === name.toLowerCase() || read.endsWith(`/${name.toLowerCase()}`)) ?? null;
}

/** The merges that took one of these branches into something that is not one of them, newest first. */
export function findTestMerges(
  merges: readonly MergeLine[],
  names: readonly string[],
  reached: ReadonlySet<string>,
): TestMerge[] {
  const found: TestMerge[] = [];

  for (const merge of merges) {
    const said = mergedBranch(merge.subject);
    const branch = said === null ? null : named(said.branch, names);

    if (said === null || branch === null) {
      continue;
    }

    /*
     * A pull on the test branch itself, which is not somebody taking it anywhere: `Merge branch 'uat'
     * of http://host/group/repo into uat`. There were two thousand of these in the repository this was
     * measured on, against a hundred of the thing being looked for.
     */
    if (said.into !== null && named(said.into, names) !== null) {
      continue;
    }

    found.push({ ...merge, branch, into: said.into, landed: reached.has(merge.sha) });
  }

  return found;
}
