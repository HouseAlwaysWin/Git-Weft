/**
 * Who has committed to this repository.
 *
 * `shortlog -sne` is the right tool rather than counting `git log` output by hand: it groups by
 * identity and honours `.mailmap`, so someone who has committed from three addresses appears once
 * rather than three times - the same reason the log format uses `%aN` instead of `%an`.
 *
 * `.mailmap` only merges the identities it has been told about, though, and most repositories have
 * not been told about any - so the addresses are folded by name here as well. See `listAuthors`.
 *
 * **What the count covers:** `--all` walks every ref, back to the root commit. It is the whole
 * history and takes no notice of what the graph is currently narrowed to - a date range, a search,
 * a branch unticked - so the number beside a name does not move when those do.
 *
 * It walks the whole history, so this is loaded on demand rather than on open.
 */

import type { Git } from './exec.ts';
import { escapeBasicRegex } from './search.ts';
import type { RepoInfo } from './discovery.ts';

export interface Author {
  /** The spelling to show: whichever has the most commits behind it. */
  readonly name: string;
  /**
   * Every spelling folded into this row, busiest first.
   *
   * Kept rather than thrown away because `--author` is case-sensitive: ticking a row that folded
   * `Max_Chiue` into `max_chiue` has to name both, or the graph walks a fraction of what the row
   * counted.
   */
  readonly names: readonly string[];
  /** Every address those names have committed from, the busiest first. */
  readonly emails: readonly string[];
  /** Commits from all of them together - which is what ticking the row shows. */
  readonly commits: number;
}

/** `   42\tMartin Wang <martin@example.com>` */
const LINE = /^\s*(\d+)\s+(.*?)\s*<([^>]*)>\s*$/;

/**
 * What makes two spellings the same person: letters and digits, folded to lower case.
 *
 * `Sean Lin`, `sean_lin` and `SEAN_LIN` are one person who has configured git on three machines,
 * and separators are the whole of the difference. Deliberately no further than that - `Lineric`
 * and `lineric_lin` share a prefix and nothing else that can be proved, and a list that quietly
 * merges two people is worse than one that shows a person twice.
 *
 * A name with nothing but punctuation in it keeps its own spelling rather than joining every other
 * such name at the empty string.
 */
function fingerprint(name: string): string {
  const stripped = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return stripped.length > 0 ? stripped : name.toLowerCase();
}

/**
 * Every author, one row per person.
 *
 * Two things are folded together, and neither is what `shortlog` does on its own:
 *
 * **Addresses**, because the tick is `--author=<name>` and that finds every address the name has
 * committed from. Two rows that always select each other are two rows of the same thing - and
 * sharing a name meant sharing a tree item id, which is what put one of them on screen twice
 * wearing the other's count.
 *
 * **Spelling**, by `fingerprint`: case and separators, so `MARTIN_WANG`, `martin_wang` and
 * `Martin Wang` are one person who has configured git three times. Nothing beyond that, and in
 * particular not the address: a service account - `Administrator <admin@example.com>` - is one
 * address behind a dozen names, and merging on it would fold a dozen people into one row.
 *
 * The spellings themselves are kept, because `--author` *is* case-sensitive - see `Author.names`.
 */
export async function listAuthors(git: Git, repo: RepoInfo): Promise<Author[]> {
  const out = await git
    .runRead(repo.root, ['shortlog', '--summary', '--numbered', '--email', '--all'])
    .catch(() => '');

  /** Keyed by fingerprint; the spellings map counts each one, to pick which to show first. */
  const folded = new Map<
    string,
    { names: Map<string, number>; emails: string[]; commits: number }
  >();

  for (const line of out.split('\n')) {
    const match = LINE.exec(line);

    if (match === null) {
      continue;
    }

    const name = match[2] ?? '';

    if (name.length === 0) {
      continue;
    }

    const email = match[3] ?? '';
    const commits = Number(match[1]) || 0;
    const key = fingerprint(name);
    const existing = folded.get(key) ?? { names: new Map<string, number>(), emails: [], commits: 0 };

    existing.commits += commits;
    existing.names.set(name, (existing.names.get(name) ?? 0) + commits);

    if (email.length > 0 && !existing.emails.includes(email)) {
      existing.emails.push(email);
    }

    folded.set(key, existing);
  }

  return (
    [...folded.values()]
      .map((entry) => {
        // Busiest spelling first: it is the one shown, and the one a reader will recognise.
        const names = [...entry.names.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([name]) => name);

        return {
          name: names[0] ?? '',
          names,
          emails: entry.emails,
          commits: entry.commits,
        };
      })
      // shortlog numbered its own output; folding rows together can only have moved a name up past
      // another, so the order has to be settled again here.
      .sort((a, b) => b.commits - a.commits)
  );
}

/**
 * `git log --author` takes a regular expression, and names contain characters that mean something
 * to a regex - `Foo (Bar)` and `A. Person` are ordinary names that would otherwise match the wrong
 * people or nobody at all.
 *
 * Escaping here rather than passing `--fixed-strings` is deliberate: that flag would also apply to
 * the user's message search, quietly changing what their own query means. The escape itself is
 * the search box's, because the dialect is git's and there is only one of it.
 */
export function authorArgs(names: readonly string[]): string[] {
  return names.map((name) => `--author=${escapeBasicRegex(name)}`);
}
