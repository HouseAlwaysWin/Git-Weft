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
 * The merges first, then - at the end - the copies: `pickedArgs` and `parsePicked` ask git which
 * commits carry a change that is also on the other side, and `pickedByOneAuthor` throws out the
 * ones that are the same change by coincidence rather than because anybody copied anything.
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
 * `git log --<side>-only --cherry-mark A...B`: the commits on one side that have a copy on the other -
 * the same change under another name, which is what a cherry-pick or a rebase leaves behind.
 *
 * Which side is asked for is the care here. The same change is two commits, one either side, and the
 * one worth drawing is the one in this history: the commit that is on screen, the commit you can click,
 * the commit whose sha the walk produces. Ask for both at once and the set quietly includes commits
 * from over there, which are then drawn whenever the graph happens to be showing that branch as well.
 *
 * The right side is read too, but for one thing and never to be drawn: who wrote the twin. See
 * `pickedByOneAuthor`.
 *
 * `git cherry` answers about the other side only, which is why it is not what this uses. Measured on a
 * 64,204-commit repository: `git cherry` 2.9 seconds, this 0.9.
 */
export function pickedArgs(here: string, there: string, side: 'left' | 'right'): string[] {
  return ['log', `--${side}-only`, '--cherry-mark', '--format=%m%x00%H%x00%an', `${here}...${there}`];
}

/** A commit that walk marked as having a copy on the other side, and who wrote it. */
export interface PickedCommit {
  readonly sha: string;
  readonly author: string;
}

/** A commit that walk produced on this side, and whether its change is on the other side as well. */
export interface WalkedCommit extends PickedCommit {
  readonly sameChange: boolean;
}

/**
 * Every commit that walk produced, marked or not.
 *
 * The unmarked ones are not copies and are never drawn as any. What they are is the size of the
 * question: `A...B` can only answer about what A has and B does not, so these are exactly the commits
 * that could have been copies and were not. That number is worth showing. Without it the filter looks
 * broken whenever the two branches are close - four found in the last week, nothing in the two years
 * before, and no way to tell "nobody did this" from "nothing back there was even looked at".
 */
export function parseWalked(output: string): WalkedCommit[] {
  return output.split('\n').flatMap((line) => {
    const [mark, sha, author] = line.trim().split('\0');

    // `=` is the mark for a commit with a copy on the other side; `<` and `>` are the ones without.
    return sha === undefined || sha.length === 0 ? [] : [{ sha, author: author ?? '', sameChange: mark === '=' }];
  });
}

/** The commits that walk marked as having a copy on the other side. */
export function parsePicked(output: string): PickedCommit[] {
  return parseWalked(output).filter((commit) => commit.sameChange);
}

/**
 * `git log --stdin --no-walk -p`: the patches of those commits, for `git patch-id` to read.
 *
 * The shas go in on stdin rather than on the command line. Nothing bounds how many commits a
 * `--cherry-mark` walk can mark, and a command line is bounded - 32 KB on Windows, about 780 shas - and
 * what happens past that is git refusing to start, which is not a failure anybody could act on.
 */
export function patchesArgs(): string[] {
  return ['log', '--stdin', '--no-walk', '-p', '--format=%H'];
}

/** `git patch-id --stable`, which reads those patches on stdin and says which of them are one change. */
export const PATCH_ID_ARGS = ['patch-id', '--stable'];

/** `<patch id> <sha>` a line, as `git patch-id` writes it: which commit carries which change. */
export function parsePatchIds(output: string): Map<string, string> {
  const found = new Map<string, string>();

  for (const line of output.split('\n')) {
    const [id, sha] = line.trim().split(' ');

    if (id !== undefined && sha !== undefined && id.length > 0 && sha.length > 0) {
      found.set(sha, id);
    }
  }

  return found;
}

/**
 * Of the commits marked as copies, the ones whose twin over there was written by the same person.
 *
 * A patch id says two commits are the same change. It does not say anybody copied anything, and on a
 * real repository that difference is most of the answer. Measured on the 64,204-commit one: of the 17
 * commits marked as copies between `release/v1.3` and `uat`, **thirteen were a version bump** - one
 * line of `package.json`, 5382 becoming 5383 - matched against the commit that made the same bump on
 * the other branch three months earlier, by somebody else entirely. Two branches walking the same
 * counter pass through the same numbers, and those diffs are identical byte for byte. git is not
 * wrong; "the same change" is simply not the question being asked.
 *
 * What a cherry-pick keeps is the author - the picker becomes the committer, the original author stays
 * - so the twin's author is the cheapest thing that tells the two apart. On that repository it told
 * them apart completely: all thirteen version bumps had a different name on each side, and all four
 * real copies had the same name on both.
 *
 * It costs recall, deliberately. A change somebody retyped by hand is copied by any ordinary reading of
 * the word, and its author is whoever retyped it, so it is no longer reported. That is the trade:
 * thirteen wrong answers for one right one that needed somebody to have been careless in a particular
 * way.
 *
 * A group of one is a twin that was not read, and is dropped rather than guessed at.
 */
export function pickedByOneAuthor(
  mine: readonly PickedCommit[],
  theirs: readonly PickedCommit[],
  patchIds: ReadonlyMap<string, string>,
): string[] {
  const byPatch = new Map<string, PickedCommit[]>();

  for (const commit of [...mine, ...theirs]) {
    const id = patchIds.get(commit.sha);

    if (id !== undefined) {
      byPatch.set(id, [...(byPatch.get(id) ?? []), commit]);
    }
  }

  return mine
    .filter((commit) => {
      const id = patchIds.get(commit.sha);
      const group = id === undefined ? [] : (byPatch.get(id) ?? []);

      return group.length > 1 && group.every((other) => other.author === commit.author);
    })
    .map((commit) => commit.sha);
}

/**
 * The remotes this repository has, out of the refs there are, in the order they first appear.
 *
 * For the one case where nothing else says which side to compare against - see `pickedFrom`. A remote
 * names its own default branch in `refs/remotes/<remote>/HEAD`, and that is the closest thing a git
 * repository has to an answer for "the branch this work goes to".
 */
export function remotesIn(refNames: readonly string[]): string[] {
  const found: string[] = [];

  for (const ref of refNames) {
    if (!ref.startsWith('refs/remotes/')) {
      continue;
    }

    const rest = ref.slice('refs/remotes/'.length);
    const at = rest.indexOf('/');
    const remote = at < 0 ? rest : rest.slice(0, at);

    if (remote.length > 0 && !found.includes(remote)) {
      found.push(remote);
    }
  }

  return found;
}

/**
 * The refs a name in the box means, out of the refs there are: the local branch and every remote's copy
 * of it, local first.
 *
 * All of them, and this is the reason. A test site is deployed from a server, so the branch that says
 * what is on it is the remote's - and the local copy is a snapshot of that from whenever somebody last
 * fetched. Measured on a repository where those two had drifted: the same comparison found twelve
 * changes against the local copy, which was 251 commits behind, and none at all against the remote,
 * because the copies are recent and the local branch has not seen them. Neither answer is the wrong
 * one; taking one of the two and calling it "uat" is.
 *
 * Needed at all because git resolves neither from `uat` alone: a name with no local branch behind it is
 * not a revision, and a walk asked for one fails rather than quietly answering about something else.
 */
export function refsFor(name: string, refNames: readonly string[]): string[] {
  const wanted = name.toLowerCase();
  const found = refNames.filter((ref) => ref.toLowerCase() === `refs/heads/${wanted}`);

  for (const ref of refNames) {
    const remote = ref.toLowerCase().startsWith('refs/remotes/') ? ref.slice('refs/remotes/'.length) : null;
    const at = remote === null ? -1 : remote.indexOf('/');

    if (at >= 0 && remote !== null && remote.slice(at + 1).toLowerCase() === wanted) {
      found.push(ref);
    }
  }

  return found;
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
