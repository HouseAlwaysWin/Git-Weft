/**
 * Who has committed to this repository.
 *
 * `shortlog -sne` is the right tool rather than counting `git log` output by hand: it groups by
 * identity and honours `.mailmap`, so someone who has committed from three addresses appears once
 * rather than three times - the same reason the log format uses `%aN` instead of `%an`.
 *
 * `.mailmap` only merges the identities it has been told about, though, and most repositories have
 * not been told about any. So there are two steps here, and they are deliberately apart:
 *
 * - `listAuthors` asks git, and folds only what git itself is sure about: one entry per name
 *   exactly as it is spelled, carrying every address that name has committed from.
 * - `groupAuthors` decides which of those spellings are one person. That is a judgement, it can be
 *   overruled by hand, and it has nothing to do with git - so it does not live behind a process.
 *
 * A hand-made group is a label rather than a box: one person is on the platform team and on the
 * release rota, and being asked to pick one of those is being asked the wrong question. So a
 * spelling carries any number of group names, and appears under each of them.
 *
 * **What the counts cover:** `--all` walks every ref, back to the root commit. It is the whole
 * history and takes no notice of what the graph is currently narrowed to - a date range, a search,
 * a branch unticked - so the number beside a name does not move when those do.
 *
 * It walks the whole history, so this is loaded on demand rather than on open.
 */

import type { Git } from './exec.ts';
import type { RepoInfo } from './discovery.ts';

/** One name exactly as git records it, with everything committed under it. */
export interface AuthorIdentity {
  /** The spelling `--author` has to be given. */
  readonly name: string;
  /** Every address this spelling has committed from, the busiest first. */
  readonly emails: readonly string[];
  readonly commits: number;
}

/**
 * One person, as the list shows them.
 *
 * A group of one is not a group: it is a name that matched nobody else, and the view draws it as a
 * plain row rather than as something to open.
 */
export interface Author {
  /** What the row is called: the busiest spelling, or the name a hand-made group was given. */
  readonly name: string;
  /** The spellings folded into it, busiest first. */
  readonly members: readonly AuthorIdentity[];
  /** Every address across all of them. */
  readonly emails: readonly string[];
  /** Commits from all of them together - which is what ticking the row shows. */
  readonly commits: number;
  /** True when a hand-made assignment put this together rather than the spelling rule. */
  readonly custom: boolean;
}

/** `   42\tMartin Wang <martin@example.com>` */
const LINE = /^\s*(\d+)\s+(.*?)\s*<([^>]*)>\s*$/;

/**
 * What makes two spellings the same person: letters and digits, folded to lower case.
 *
 * `Sean Lin`, `sean_lin` and `SEAN_LIN` are one person who has configured git on three machines,
 * and separators are the whole of the difference. Deliberately no further than that - `Lineric`
 * and `lineric_lin` share a prefix and nothing that can be proved, and a list that quietly merges
 * two people is worse than one that shows a person twice. Those are what the hand-made groups are
 * for.
 *
 * A name with nothing but punctuation in it keeps its own spelling rather than joining every other
 * such name at the empty string.
 */
export function fingerprint(name: string): string {
  const stripped = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return stripped.length > 0 ? stripped : name.toLowerCase();
}

/**
 * Every name git has, one entry per spelling.
 *
 * Addresses are folded in, because a name committing from a laptop and a build box is that name
 * twice and `--author=<name>` finds both whichever row you clicked. Spellings are not: telling
 * `Sean Lin` from `sean_lin` is a judgement, and it is made in `groupAuthors`.
 */
export async function listAuthors(git: Git, repo: RepoInfo): Promise<AuthorIdentity[]> {
  const out = await git
    .runRead(repo.root, ['shortlog', '--summary', '--numbered', '--email', '--all'])
    .catch(() => '');

  const byName = new Map<string, { name: string; emails: string[]; commits: number }>();

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
    const existing = byName.get(name);

    if (existing === undefined) {
      byName.set(name, { name, emails: email.length === 0 ? [] : [email], commits });
      continue;
    }

    existing.commits += commits;

    if (email.length > 0 && !existing.emails.includes(email)) {
      existing.emails.push(email);
    }
  }

  return [...byName.values()].sort((a, b) => b.commits - a.commits);
}

/**
 * The groups a repository's spellings were put in, in whichever shape they were remembered.
 *
 * A spelling used to be in one group, and one group was stored as one string. It is a list now. The
 * old shape is read rather than rewritten on sight, because somebody's assignments are not worth
 * losing to a version they happened to skip, and because a shape this small is cheaper to keep
 * reading than to migrate carefully.
 */
export function readGroupAssignments(
  stored: Readonly<Record<string, string | readonly string[]>>,
): Map<string, string[]> {
  return new Map(
    Object.entries(stored).map(([spelling, groups]) => [
      spelling,
      typeof groups === 'string' ? [groups] : [...groups],
    ]),
  );
}

/**
 * Fold spellings into people.
 *
 * `custom` overrules the spelling rule: it maps a spelling to the groups it belongs in, which is how
 * `Lineric` and `lineric_lin` become one person, and how a name the rule swept in can be taken back
 * out again by being given a group of its own.
 *
 * More than one group, because a person is not on one team. A spelling that has been put somewhere
 * by hand appears under each place it was put and nowhere else - the assignment replaces what the
 * rule would have done with it, rather than adding to it, or grouping anybody would list them twice.
 *
 * Which means the counts across rows can add up to more than the history has: two groups sharing a
 * person each count that person's commits. That is what a label does, and the alternative is a row
 * that says a number no tick of it would produce.
 */
export function groupAuthors(
  identities: readonly AuthorIdentity[],
  custom: ReadonlyMap<string, readonly string[]> = new Map(),
): Author[] {
  const folded = new Map<
    string,
    { name: string | null; members: AuthorIdentity[]; emails: string[]; commits: number }
  >();

  for (const identity of identities) {
    const named = custom.get(identity.name) ?? [];

    /*
     * Where this spelling is listed, by key and by the name to show: the groups it was put in, or
     * its own spelling when it was put in none.
     *
     * The group's name goes through the same fingerprint as a spelling would. Otherwise "group this
     * with Weft Test" files it under `Weft Test` while Weft Test itself is filed under `wefttest`,
     * and the two never meet - which looks exactly like the assignment having been ignored. Naming
     * an existing person is the ordinary way to use this, so the two keys have to be the same kind
     * of thing.
     *
     * Keyed, so that a spelling put in both `Backend` and `backend` lands in one row rather than
     * being counted twice into the same one.
     */
    const places = new Map<string, string | null>();

    if (named.length === 0) {
      places.set(fingerprint(identity.name), null);
    } else {
      for (const name of named) {
        places.set(fingerprint(name), name);
      }
    }

    for (const [key, name] of places) {
      const entry = folded.get(key) ?? { name, members: [], emails: [], commits: 0 };

      // A hand-made group keeps the name it was given, whichever spelling arrives first.
      entry.name = name ?? entry.name;
      entry.members.push(identity);
      entry.commits += identity.commits;

      for (const email of identity.emails) {
        if (!entry.emails.includes(email)) {
          entry.emails.push(email);
        }
      }

      folded.set(key, entry);
    }
  }

  return [...folded.values()]
    .map((entry) => {
      // Busiest spelling first: it names the group when nothing else does, and it is the one a
      // reader will recognise.
      const members = [...entry.members].sort((a, b) => b.commits - a.commits);

      return {
        name: entry.name ?? members[0]?.name ?? '',
        members,
        emails: entry.emails,
        commits: entry.commits,
        custom: entry.name !== null,
      };
    })
    .sort((a, b) => b.commits - a.commits);
}
