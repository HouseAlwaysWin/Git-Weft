/**
 * The sidebar's one read of every ref.
 *
 * Separate from the view so it can be tested without an editor, and because the format is the sort
 * of thing that has to be decided rather than typed. `for-each-ref` fails outright on a field it
 * does not know - `fatal: unknown field name`, with no output at all - so a field added for one
 * feature takes the entire ref list with it on any git too old for it. Branches & Tags going empty
 * is a far worse outcome than a missing detail, which is why the field is asked for only where it
 * exists and the parse reads a line that never had it.
 */

/** `%(worktreepath)` arrived in this version. */
export const WORKTREE_PATHS_SINCE = { major: 2, minor: 23 };

/** One line of it: what the ref is, whether HEAD is on it, when it moved, and who has it out. */
export interface RefLine {
  readonly refName: string;
  readonly head: boolean;
  readonly updated: number;
  /** The working tree with this branch checked out - this one included - or null. */
  readonly worktree: string | null;
}

export function refListArgs(worktreePaths: boolean): string[] {
  const fields = [
    '%(refname)',
    '%(HEAD)',
    '%(committerdate:unix)',
    // One field more, and no second process: which folder has a branch out comes off the same walk.
    ...(worktreePaths ? ['%(worktreepath)'] : []),
  ];

  return ['for-each-ref', `--format=${fields.join('%00')}`, 'refs/heads', 'refs/remotes', 'refs/tags'];
}

/**
 * A line of that format, or null when there is nothing on it.
 *
 * The worktree field is read as absent rather than empty when it was never asked for, which is the
 * same thing a ref nobody has checked out produces - and has to be, because on an older git every
 * line looks like that.
 */
export function parseRefLine(line: string): RefLine | null {
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return null;
  }

  const [refName = '', head = '', updated = '', worktree = ''] = trimmed.split('\x00');

  if (refName.length === 0) {
    return null;
  }

  return {
    refName,
    head: head.trim() === '*',
    updated: Number(updated) * 1000 || 0,
    worktree: worktree.length > 0 ? worktree : null,
  };
}

/**
 * How a row says another folder has this branch: by that folder's name, not its path.
 *
 * A row is a line in a narrow sidebar, and the interesting word is the last one. The whole path is
 * on the tooltip, where there is room for it.
 */
export function worktreeLabel(worktree: string): string {
  const parts = worktree.replace(/\\/g, '/').replace(/\/$/, '').split('/');

  return parts[parts.length - 1] ?? worktree;
}
