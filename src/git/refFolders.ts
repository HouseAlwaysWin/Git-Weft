/**
 * Branch names folded into folders, the way a file tree folds paths.
 *
 * A repository with a hundred and fifty branches is a list nobody reads top to bottom. Most of them
 * share a prefix that says what they are - `feature/`, `release/`, or, in a repository that named them
 * before anybody agreed on slashes, `Dev_` and `Fix_` - and folding on it turns a hundred and fifty
 * rows into a handful of folders, each a question you can open or not.
 *
 * `/` folds at every level. `_` folds once, at the first one in the last part: `Dev_ACR080VN_ERP-10147`
 * is a `Dev_` branch, not a `Dev_` / `ACR080VN_` / `ERP-10147` one - past the first `_` the name is an
 * id, and ids do not share prefixes worth opening. A folder is made only for two names or more, since
 * a folder around one branch is a click to find one branch. Labels keep their separator, so a name
 * still reads through from folder to leaf. And nothing is folded case-insensitively: `Dev_` and `dev_`
 * are two prefixes, because git says they are two names.
 *
 * Shared by the sidebar and the header's menu, which is why nothing here knows about either.
 */

export type BranchFolders = 'auto' | 'slash' | 'slashAndUnderscore' | 'none';

export type Folding = 'slash' | 'slashAndUnderscore' | 'none';

export interface FolderNode<T> {
  readonly kind: 'folder';
  /** The prefix the folder stands for, separators included: what every name inside it starts with. */
  readonly path: string;
  /** What it reads as: its own part of that prefix, separator included. */
  readonly label: string;
  readonly children: readonly Folded<T>[];
}

export interface LeafNode<T> {
  readonly kind: 'leaf';
  /** What is left of the name inside its folder. */
  readonly label: string;
  readonly item: T;
}

export type Folded<T> = FolderNode<T> | LeafNode<T>;

/**
 * How to fold these names. `auto` folds on `_` as well only when more of them use it than use `/`: a
 * repository that names branches `feature/x` folds on slashes alone, one that names them `Dev_x` folds
 * on the underscore, and neither is asked which it is.
 */
export function foldingFor(names: readonly string[], setting: BranchFolders): Folding {
  if (setting !== 'auto') {
    return setting;
  }

  const slashed = names.filter((name) => name.includes('/')).length;
  const underscored = names.filter((name) => name.includes('_')).length;

  return underscored > slashed ? 'slashAndUnderscore' : 'slash';
}

/**
 * Fold `items` by their names, keeping the order they came in - a folder stands where its first name
 * would have. `strip` is a prefix every name is read without: `origin/`, when there is one remote and
 * a folder for it would be one more click around everything.
 */
export function foldRefs<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
  folding: Folding,
  strip = '',
): Folded<T>[] {
  const entries = items.map((item) => {
    const full = nameOf(item);
    const name = strip.length > 0 && full.startsWith(strip) ? full.slice(strip.length) : full;

    return { item, parts: folding === 'none' ? [name] : split(name, folding) };
  });

  return build(entries, '');
}

interface Entry<T> {
  readonly item: T;
  /** What is left to place: folder parts, then the leaf. */
  readonly parts: readonly string[];
}

/** A name's folder parts, each with its separator, and then the leaf. */
function split(name: string, folding: 'slash' | 'slashAndUnderscore'): string[] {
  const segments = name.split('/');
  const parts = segments.slice(0, -1).map((segment) => `${segment}/`);
  const last = segments[segments.length - 1] ?? '';
  const underscore = folding === 'slashAndUnderscore' ? last.indexOf('_') : -1;

  // The first `_` only, and never at either end: `_x` and `x_` have no prefix to share.
  if (underscore > 0 && underscore < last.length - 1) {
    parts.push(last.slice(0, underscore + 1), last.slice(underscore + 1));
  } else {
    parts.push(last);
  }

  return parts;
}

function build<T>(entries: readonly Entry<T>[], path: string): Folded<T>[] {
  const byPrefix = new Map<string, Entry<T>[]>();
  const order: (string | Entry<T>)[] = [];

  for (const entry of entries) {
    const head = entry.parts[0] ?? '';

    if (entry.parts.length === 1) {
      order.push(entry);
      continue;
    }

    const group = byPrefix.get(head);

    if (group === undefined) {
      byPrefix.set(head, [entry]);
      order.push(head);
    } else {
      group.push(entry);
    }
  }

  return order.map((next): Folded<T> => {
    if (typeof next !== 'string') {
      return { kind: 'leaf', label: next.parts[0] ?? '', item: next.item };
    }

    const group = byPrefix.get(next) ?? [];
    const first = group[0];

    // One name is not a folder: it stays at this level, read in full from here down.
    if (group.length < 2 && first !== undefined) {
      return { kind: 'leaf', label: first.parts.join(''), item: first.item };
    }

    return {
      kind: 'folder',
      path: path + next,
      label: next,
      children: build(
        group.map((entry) => ({ item: entry.item, parts: entry.parts.slice(1) })),
        path + next,
      ),
    };
  });
}
