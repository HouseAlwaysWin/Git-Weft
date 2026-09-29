/*
 * w3's pure part, drafted: where a new worktree goes by default, and what branch it gets.
 *
 * Kept out of extension.ts because both answers are fiddly enough to be worth testing on their own,
 * and neither needs an editor in the room.
 */

/**
 * Where to suggest putting a worktree for `branch`.
 *
 * Beside the repository, named after it and the branch: `app` and `feature/login` suggest
 * `app-feature-login`. Not inside the repository, which git allows and which makes the new tree
 * show up as untracked files in the old one; not in a temporary directory, because the point of a
 * worktree is that it is somewhere you can leave it.
 *
 * Slashes become dashes rather than folders. `app/feature/login` would be a folder called `app`
 * holding one called `feature`, which on a second branch of the same prefix is a folder half full
 * of worktrees and half full of somebody's source.
 */
export function suggestWorktreePath(repoRoot: string, branch: string): string {
  const root = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const at = root.lastIndexOf('/');
  const parent = at === -1 ? root : root.slice(0, at);
  const name = at === -1 ? root : root.slice(at + 1);
  const shortened = branch.replace(/^refs\/(heads|remotes)\//, '');

  /*
   * Everything a filesystem argues about, in one pass: separators, the characters Windows refuses,
   * and the dots and spaces it silently strips from the end of a name.
   */
  const safe = shortened
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');

  return `${parent}/${name}-${safe === '' ? 'worktree' : safe}`;
}

/**
 * What `git worktree add` should be told, given the ref that was right-clicked.
 *
 * A local branch is checked out as it is. A remote one cannot be: checking out `origin/feature`
 * detaches HEAD, and a detached worktree is not what anybody right-clicking a branch meant. So a
 * remote ref makes a local branch of the same short name, which is what `git switch` would have
 * done, and which sets the upstream on the way.
 *
 * `taken` is the local branch names that already exist. If the name is one of them, the remote ref
 * is checked out through that local branch rather than a second one being invented - the two would
 * point at the same commit and only one of them would be tracking anything.
 */
export function worktreeAddArgs(
  path: string,
  refName: string,
  refKind: 'local' | 'remote' | 'tag',
  taken: ReadonlySet<string>,
): string[] {
  if (refKind !== 'remote') {
    /*
     * The short name, never the full ref. `git worktree add <path> refs/heads/topic` reads the ref
     * as a commit-ish and leaves the new tree on a detached HEAD; `<path> topic` checks the branch
     * out. The two are indistinguishable from outside - a folder appears either way and git exits 0
     * either way - and only one of them is what right-clicking a branch meant.
     *
     * A tag keeps its full ref and so stays detached, which for a tag is the only thing it can be.
     */
    return ['worktree', 'add', path, refName.replace(/^refs\/heads\//, '')];
  }

  const short = refName.replace(/^refs\/remotes\//, '');
  const local = short.slice(short.indexOf('/') + 1);

  return local === '' || taken.has(local)
    ? ['worktree', 'add', path, local === '' ? refName : local]
    : ['worktree', 'add', '-b', local, path, refName];
}
