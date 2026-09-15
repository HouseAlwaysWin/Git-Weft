/**
 * What a walk was narrowed to, in words: the line above the charts, so a count taken from one branch since
 * March is never read as the whole repository's.
 */

import type { DateRange } from '../git/dates.ts';
import { isDay } from '../git/dates.ts';
import type { Search, SearchMode } from '../git/search.ts';

/** How the graph was narrowed when it walked. */
export interface Scope {
  /** Full names of the refs walked - `refs/heads/main` - or null for all of them. */
  readonly refs: readonly string[] | null;
  readonly search: Search | null;
  /** Spellings ticked in Authors. None narrows nothing. */
  readonly authors: number;
  readonly dates: DateRange | null;
  readonly firstParent: boolean;
  readonly onlyHere: boolean;
}

/** How many refs are named before the rest are counted instead. */
const NAMED_REFS = 3;

/** What a search in each mode looks at, as the start of a phrase. */
const LOOKS_AT: Readonly<Record<SearchMode, string>> = {
  message: 'messages',
  author: 'authors',
  committer: 'committers',
  content: 'changes',
  path: 'paths',
};

/** A ref as the graph's badges name it: `main`, `origin/main`, `v1.0`. */
function shortName(ref: string): string {
  for (const prefix of ['refs/heads/', 'refs/remotes/', 'refs/tags/']) {
    if (ref.startsWith(prefix)) {
      return ref.slice(prefix.length);
    }
  }

  return ref;
}

/** "main", "main and uat", "main, uat and develop", or "main, uat, develop and 4 more". */
function listRefs(refs: readonly string[]): string {
  const names = refs.map(shortName);

  if (names.length > NAMED_REFS) {
    return `${names.slice(0, NAMED_REFS).join(', ')} and ${names.length - NAMED_REFS} more`;
  }

  return names.length === 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

/**
 * The scope as one line, such as "main and uat · only here · from 2026-01-01 · first parent".
 *
 * Only what narrowed the walk is said, in the words the graph's own controls use, so every part of it can
 * be found on screen and turned off.
 */
export function describeScope(scope: Scope): string {
  const parts: string[] = [];

  if (scope.refs === null) {
    parts.push('every branch and tag');
  } else if (scope.refs.length === 0) {
    parts.push('no branch ticked');
  } else {
    parts.push(listRefs(scope.refs));

    // It excludes what other refs reach, so with nothing ticked or everything drawn it narrows nothing.
    if (scope.onlyHere) {
      parts.push('only here');
    }
  }

  const query = scope.search?.query.trim() ?? '';

  if (scope.search !== null && query.length > 0) {
    parts.push(`${LOOKS_AT[scope.search.mode]} ${scope.search.invert ? 'not matching' : 'matching'} "${query}"`);
  }

  if (scope.authors > 0) {
    parts.push(scope.authors === 1 ? '1 author ticked' : `${scope.authors} authors ticked`);
  }

  const since = isDay(scope.dates?.since) ? scope.dates?.since : null;
  const until = isDay(scope.dates?.until) ? scope.dates?.until : null;

  if (since != null && until != null) {
    parts.push(`${since} to ${until}`);
  } else if (since != null) {
    parts.push(`from ${since}`);
  } else if (until != null) {
    parts.push(`until ${until}`);
  }

  if (scope.firstParent) {
    parts.push('first parent');
  }

  return parts.join(' · ');
}
