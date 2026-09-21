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
 * `--branches --tags --remotes` rather than `--all`: a stash is work somebody has not committed, and
 * this is a question about history. Measured on that repository, which has three stashes in it, both
 * spellings of the walk produced the same 16,468 lines - so saying what is meant costs nothing here.
 *
 * Merges are left out because `--name-only` says nothing about one anyway: git shows no diff for a
 * merge unless it is asked to, and asking would hand every file in a branch to whoever merged it.
 */
import { authorArgs } from './search.ts';

export function authorFilesArgs(spellings: readonly string[]): string[] {
  return [
    'log',
    '--branches',
    '--tags',
    '--remotes',
    '--no-merges',
    '--name-only',
    '--format=',
    ...authorArgs(spellings),
  ];
}

/** One file, and how many of that person's commits touched it. */
export interface TouchedFile {
  readonly path: string;
  readonly changes: number;
}

/**
 * That walk's output, counted.
 *
 * Ordered by how often the file was touched and then by name, because the question behind the
 * question is "what did they work on", and four thousand paths in walk order answer nothing at all.
 */
export function parseAuthorFiles(output: string): TouchedFile[] {
  const counts = new Map<string, number>();

  for (const line of output.split('\n')) {
    // The line ending only. A leading space is part of a filename, however unlikely a filename it is.
    const path = line.endsWith('\r') ? line.slice(0, -1) : line;

    if (path.length > 0) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }

  return [...counts]
    .map(([path, changes]) => ({ path, changes }))
    .sort((a, b) => b.changes - a.changes || a.path.localeCompare(b.path));
}
