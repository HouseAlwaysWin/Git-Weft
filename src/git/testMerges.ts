/**
 * What came into this history from a test site's branch: merged in, or copied across.
 *
 * Two ways in and two ways to find them. A merge says so in the message git wrote; a cherry-pick says
 * nothing at all unless somebody used `-x`, and what it leaves instead is a commit whose change is the
 * same as one over there - which git can find by patch id, and which is the only record there is.
 *
 * Measured on a 64,204-commit repository: 119 merges, and 5 changes that came across as copies. The
 * second number is small, and two of the five were from that same morning, so it is not a historical
 * curiosity either.
 *
 * The merges first, then - at the end - `pickedArgs` and `parsePicked`, which are the copies.
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

/**
 * `git log --left-only --cherry-mark A...B`: the commits on A's side that have a copy on B's - the same
 * change under another name, which is what a cherry-pick or a rebase leaves behind.
 *
 * `--left-only` is the whole of the care here. The same change is two commits, one either side, and the
 * one worth anything is the one in this history: it is the commit that is drawn, the commit you can
 * click, and the commit whose sha the walk produces. Without it both sides come back marked and the set
 * quietly includes commits from over there, which are then drawn whenever the graph happens to be
 * showing that branch as well.
 *
 * `git cherry` answers about the other side only, which is why it is not what this uses. Measured on a
 * 64,204-commit repository: `git cherry` 2.9 seconds, this 0.9.
 */
export function pickedArgs(here: string, there: string): string[] {
  return ['log', '--left-only', '--cherry-mark', '--format=%m%x00%H', `${here}...${there}`];
}

/** The shas that walk marked as having a copy on the other side. */
export function parsePicked(output: string): string[] {
  return output.split('\n').flatMap((line) => {
    const [mark, sha] = line.trim().split('\0');

    // `=` is the mark for a commit with a copy on the other side; `<` and `>` are the ones without.
    return mark === '=' && sha !== undefined && sha.length > 0 ? [sha] : [];
  });
}

/**
 * The ref a name in the box means, out of the refs there are.
 *
 * `uat` is `refs/heads/uat` where there is one and `refs/remotes/origin/uat` where there is not - the
 * same rule a merge message is read by, and needed here because git itself resolves neither from `uat`
 * alone: a name with no local branch behind it is not a revision, and the walk would fail rather than
 * quietly answer about something else.
 */
export function refFor(name: string, refNames: readonly string[]): string | null {
  const wanted = name.toLowerCase();
  const local = refNames.find((ref) => ref.toLowerCase() === `refs/heads/${wanted}`);

  if (local !== undefined) {
    return local;
  }

  return (
    refNames.find((ref) => {
      const remote = ref.toLowerCase().startsWith('refs/remotes/') ? ref.slice('refs/remotes/'.length) : null;
      const at = remote === null ? -1 : remote.indexOf('/');

      return at >= 0 && remote !== null && remote.slice(at + 1).toLowerCase() === wanted;
    }) ?? null
  );
}

/** The names typed into one box - `uat, sit` - as a list. */
export function splitBranchNames(text: string): string[] {
  return text
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * Which of these branches a merge took somewhere that is not one of them, and where it took it.
 *
 * The one rule, asked by both things that want it: the report, of every merge in the repository, and
 * the graph's own filter, of every merge its walk produces. Null for everything else, which includes
 * the two that look like it and are not - a pull on the test branch itself (`Merge branch 'uat' of
 * http://host/group/repo into uat`, of which there were two thousand in the repository this was
 * measured on, against a hundred of the thing being looked for), and a feature going the ordinary way
 * round, into the test site.
 */
export function tookTestBranch(
  subject: string,
  names: readonly string[],
): { readonly branch: string; readonly into: string | null } | null {
  const said = mergedBranch(subject);
  const branch = said === null ? null : named(said.branch, names);

  if (said === null || branch === null) {
    return null;
  }

  return said.into !== null && named(said.into, names) !== null ? null : { branch, into: said.into };
}

/** The merges that took one of these branches into something that is not one of them, newest first. */
export function findTestMerges(
  merges: readonly MergeLine[],
  names: readonly string[],
  reached: ReadonlySet<string>,
): TestMerge[] {
  const found: TestMerge[] = [];

  for (const merge of merges) {
    const took = tookTestBranch(merge.subject, names);

    if (took !== null) {
      found.push({ ...merge, ...took, landed: reached.has(merge.sha) });
    }
  }

  return found;
}
