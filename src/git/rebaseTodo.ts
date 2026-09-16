/**
 * git's `git-rebase-todo`, read and written.
 *
 * The file `git rebase -i` opens is the whole of what an interactive rebase will do: a line per commit,
 * in the order they will be replayed, each saying what to do with it. Editing that file is the rebase,
 * which is why this is worth a module of its own - the editor on top of it only ever changes an action
 * or an order, and everything else in the file has to come back out exactly as it went in.
 *
 * Pure: text in, lines out, text back. What runs git is elsewhere.
 */

/** What a rebase does with one commit. */
export type CommitAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

/** One line of a todo file. */
export type TodoLine =
  | {
      readonly kind: 'commit';
      readonly action: CommitAction;
      /** `-C` or `-c` on a fixup, which says which message to keep. Empty for everything else. */
      readonly flags: string;
      readonly sha: string;
      /** What git wrote after the sha: the subject, which is a reminder rather than something git reads. */
      readonly rest: string;
    }
  /**
   * Anything else, kept as it was: git's comment block, the blank lines, and the commands this does not
   * know about - `exec`, `break`, `label`, `reset`, `merge`, `update-ref`, `noop`. A rebase somebody
   * built with those is not one to be quietly rewritten.
   */
  | { readonly kind: 'other'; readonly text: string };

/** Every spelling git accepts for the commands that take a commit, long and short. */
const ACTIONS: Readonly<Record<string, CommitAction>> = {
  p: 'pick',
  pick: 'pick',
  r: 'reword',
  reword: 'reword',
  e: 'edit',
  edit: 'edit',
  s: 'squash',
  squash: 'squash',
  f: 'fixup',
  fixup: 'fixup',
  d: 'drop',
  drop: 'drop',
};

/** `<action> [-C|-c] <sha> [subject]`, which is the only shape this reads as a commit. */
const COMMIT = /^([a-z]+) +(-[Cc] +)?([0-9a-fA-F]{4,40})(?: +(.*))?$/;

/**
 * A todo file, line by line.
 *
 * Every line comes back, in order, including the ones that are not commits: rendering the result is how
 * the file is written again, and a line this did not understand has to survive that.
 */
export function parseTodo(text: string): TodoLine[] {
  return text.split('\n').map((line) => {
    const match = COMMIT.exec(line);
    const action = match === null ? undefined : ACTIONS[match[1] ?? ''];

    if (match === undefined || match === null || action === undefined) {
      return { kind: 'other', text: line };
    }

    return { kind: 'commit', action, flags: (match[2] ?? '').trim(), sha: match[3] ?? '', rest: match[4] ?? '' };
  });
}

/**
 * The lines as a file again.
 *
 * A commit line is written in full - `pick` rather than `p` - which git reads the same and a person
 * reads better. A file git wrote comes back byte for byte; one somebody spaced out by hand comes back
 * tidied, which is the only thing here that does not survive a round trip.
 */
export function renderTodo(lines: readonly TodoLine[]): string {
  return lines
    .map((line) =>
      line.kind === 'other'
        ? line.text
        : `${line.action}${line.flags === '' ? '' : ` ${line.flags}`} ${line.sha}${line.rest === '' ? '' : ` ${line.rest}`}`,
    )
    .join('\n');
}

/**
 * Move the commit at `from` - counted among the commits rather than among the lines - by `by` places.
 *
 * The lines that are not commits stay where they are. git's comment block sits at the end of the file
 * explaining it, and carrying a commit past it would put the explanation in the middle of the list.
 */
export function moveCommit(lines: readonly TodoLine[], from: number, by: number): TodoLine[] {
  const commits = lines.filter((line) => line.kind === 'commit');
  const to = Math.min(Math.max(from + by, 0), commits.length - 1);

  if (from < 0 || from >= commits.length || to === from) {
    return [...lines];
  }

  const moved = [...commits];
  const taken = moved.splice(from, 1)[0];

  if (taken !== undefined) {
    moved.splice(to, 0, taken);
  }

  let next = 0;

  return lines.map((line) => (line.kind === 'commit' ? (moved[next++] ?? line) : line));
}

/**
 * What the file comes to, in a sentence: "9 commits, 3 squashed into the one before, 1 dropped".
 *
 * Said because the list is a plan rather than a history, and the thing worth checking before it runs is
 * how many commits come out of it - which is not the number of lines.
 */
export function describeTodo(lines: readonly TodoLine[]): string {
  let kept = 0;
  let squashed = 0;
  let dropped = 0;

  for (const line of lines) {
    if (line.kind !== 'commit') {
      continue;
    }

    if (line.action === 'squash' || line.action === 'fixup') {
      squashed += 1;
    } else if (line.action === 'drop') {
      dropped += 1;
    } else {
      kept += 1;
    }
  }

  if (kept + squashed + dropped === 0) {
    return 'Nothing to do';
  }

  const counted = (count: number, one: string): string => `${count} ${count === 1 ? one : `${one}s`}`;

  return [
    counted(kept, 'commit'),
    ...(squashed === 0 ? [] : [`${squashed} squashed into the one before`]),
    ...(dropped === 0 ? [] : [`${dropped} dropped`]),
  ].join(', ');
}
