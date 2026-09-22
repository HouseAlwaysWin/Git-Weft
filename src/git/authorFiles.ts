/**
 * Which files a person has changed, and how many times.
 *
 * The Authors sidebar answers "who" and the graph answers "when". This is the third question anybody
 * asks of a repository they have just been handed - what did this person work on - and until now it
 * was a git command nobody wants to type. Measured on a 64,252-commit repository: 0.9 seconds and
 * 4,401 files for a prolific person, three runs out of three.
 *
 * The first measurement of it said 6.3 seconds, and the difference is the walk below rather than the
 * machine: that one was `git log --author=X --name-only -- .`, where the pathspec turns every commit
 * into a tree comparison and merges are walked to be thrown away. It is worth knowing which of those
 * two numbers is the feature, because the slower one is what a progress bar gets designed around.
 *
 * Every spelling at once, because one person is often several - see `authorsView.ts`. `--author`
 * repeats as "any of these", and the names are escaped rather than passed with `--fixed-strings`,
 * which is a walk-wide flag and would quietly change what the reader's own query means.
 *
 * Where it walks from is what the sidebar has ticked, which is what the graph beside it is drawing.
 * Ticking a branch means "walk from here", and a branch's history holds everything ever merged into
 * it - so this answers "what did they do that reached what I am looking at", and a file they changed
 * on a branch that went nowhere stops being listed under a graph that cannot show it. With nothing
 * ticked apart there is nothing to narrow by, and `--branches --tags --remotes` is every branch.
 *
 * That rather than `--all`: a stash is work somebody has not committed, and this is a question about
 * history. Measured on that repository, which has three stashes in it, both spellings of the walk
 * produced the same 16,468 lines - so saying what is meant costs nothing here.
 *
 * Merges are left out because `--name-only` says nothing about one anyway: git shows no diff for a
 * merge unless it is asked to, and asking would hand every file in a branch to whoever merged it.
 * That covers merges git recorded as merges. The ones it did not are `looksLikeMerge` below.
 */
import { authorArgs } from './search.ts';

export function authorFilesArgs(spellings: readonly string[], refs: readonly string[] | null): string[] {
  return [
    'log',
    '--no-merges',
    '--name-only',
    // A NUL and the subject open each commit, so the files below it can be attributed or dropped.
    '--format=%x00%s',
    ...authorArgs(spellings),
    ...(refs === null ? ['--branches', '--tags', '--remotes'] : refs),
    // Nothing after this is a path, so a branch named like a folder is still read as a branch.
    '--',
  ];
}

/**
 * A commit that says it is a merge, which git did not record as one.
 *
 * A squash merge has a single parent and a diff, so it is an ordinary commit in every way git can be
 * asked about - and its diff is the whole of somebody else's branch, attributed to whoever pressed
 * the button. Reported as "files Wei_Pan has changed", three of those commits contributed 635 of
 * 2,623 files, including one whose only other author is the person who actually wrote it.
 *
 * Looser than `mergedBranch`, which has to read the branch names out and so insists on git's exact
 * wording: across that repository's 150 single-parent merges it matched 144, missing `Merge cs 'x'
 * into y` and one with a sentence in the middle. This asks only for the word and a quoted name -
 * and the quoted name is the part that matters, because "Merge the two config files into one" is a
 * refactor somebody did on purpose and every file in it is theirs.
 */
export function looksLikeMerge(subject: string): boolean {
  return /^Merge\b.*'[^']+'/.test(subject);
}

/** One file, and how many of that person's commits touched it. */
export interface TouchedFile {
  readonly path: string;
  readonly changes: number;
}

/** What that walk found: the files, and how many of its commits were left out, of each kind. */
export interface AuthorFiles {
  readonly files: readonly TouchedFile[];
  readonly merges: number;
  /** Commits `weft.statistics.excludeMessages` matches - the reader's own "this is not work" list. */
  readonly excluded: number;
}

/**
 * That walk's output, counted, one commit at a time.
 *
 * A commit is a NUL, its subject, and then the paths it touched, so a squash merge can be dropped
 * whole rather than leaving its branch's files behind under somebody else's name. How many were
 * dropped is counted and said out loud: a quarter of a list disappearing with nothing to show for it
 * is the same failure in the other direction.
 *
 * Ordered by how often the file was touched and then by name, because the question behind the
 * question is "what did they work on", and four thousand paths in walk order answer nothing at all.
 */
export function parseAuthorFiles(output: string, ignore: readonly RegExp[] = []): AuthorFiles {
  const counts = new Map<string, number>();
  let merges = 0;
  let excluded = 0;

  for (const block of output.split('\0')) {
    const lines = block.split('\n');
    // The line ending only. A leading space is part of a filename, however unlikely a filename it is.
    const strip = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);

    const subject = strip(lines[0] ?? '');

    if (looksLikeMerge(subject)) {
      merges += 1;
      continue;
    }

    /*
     * And the commits the reader has already said are not work.
     *
     * A release stamp carries whatever is in the tree when it is cut - somebody else's scratch SQL,
     * a zip, a skills file - all of it under the name of whoever ran the deploy. There is no marker
     * in git for that, but there is one in the settings: the same list the statistics tab leaves out
     * of its charts, which on the repository this was found on was already written and already
     * matched them.
     */
    if (block.length > 0 && ignore.some((pattern) => pattern.test(subject))) {
      excluded += 1;
      continue;
    }

    for (const line of lines.slice(1)) {
      const path = strip(line);

      if (path.length > 0) {
        counts.set(path, (counts.get(path) ?? 0) + 1);
      }
    }
  }

  return {
    files: [...counts]
      .map(([path, changes]) => ({ path, changes }))
      .sort((a, b) => b.changes - a.changes || a.path.localeCompare(b.path)),
    merges,
    excluded,
  };
}
