/**
 * Where a row matched, marked up - which is a different question from what git was asked for.
 *
 * git has already narrowed the walk by the time a row exists, so none of this decides which commits
 * are on screen. It decides where inside a row to draw attention, and it is derived from the very
 * search that was sent rather than re-read from the boxes, so the marking cannot drift from what
 * was actually asked.
 *
 * Two of the five modes have a match that is visible in a row at all. A `content` hit is inside a
 * diff, a `path` hit is inside a filename, and a `committer` hit is in a column the rows do not
 * carry - so those mark nothing rather than marking the nearest thing to hand. An inverted search
 * marks nothing either: every row on screen is one that did *not* match.
 *
 * Pure, and apart from the view, because the interesting part is a decision rather than a paint:
 * given a search, which column and which pattern. That is a thing a test can be handed a search
 * and check, and it had a bug in it that only a test would have caught.
 */

import type { Search } from '../git/search.ts';
import { TOGGLES } from '../git/search.ts';

/** The row column a mark can land in. */
export type Field = 'subject' | 'author';

export interface Marking {
  /** What to mark, or null when there is nothing to mark. */
  readonly pattern: RegExp | null;
  /**
   * And which column it marks.
   *
   * Carried beside the pattern rather than worked out again where the rows are built, because the
   * two change together and watching only one of them is a bug: switching from message to author
   * with the same word in the box leaves the pattern identical, so nothing repainted and the marks
   * stayed on the subject - the column the search was no longer looking at.
   */
  readonly field: Field | null;
}

const NOTHING: Marking = { pattern: null, field: null };

/** Which column this mode's matches are visible in, or null when none of them is. */
function fieldFor(mode: Search['mode']): Field | null {
  return mode === 'message' ? 'subject' : mode === 'author' ? 'author' : null;
}

/**
 * What to mark for a search, and where.
 *
 * The dialect is a compromise. Text mode is exact, because the escape is ours on both sides; a
 * regular expression is git's BRE being read by JavaScript, which agrees on the common cases and
 * not on all of them. A highlight that misses is a hint that missed, so a pattern JavaScript
 * cannot parse simply turns the marking off rather than the search.
 */
export function marking(search: Search | null): Marking {
  if (search === null || search.invert) {
    return NOTHING;
  }

  const field = fieldFor(search.mode);
  const query = search.query.trim();

  if (field === null || query.length === 0) {
    return NOTHING;
  }

  // Through the same table the buttons come from, so the marking cannot claim to have split the
  // query on words in a mode where git was never asked to.
  const splitting = search.allTerms && (TOGGLES[search.mode] ?? []).includes('allTerms');
  const terms = splitting ? query.split(/\s+/).filter((term) => term.length > 0) : [query];

  if (terms.length === 0) {
    return NOTHING;
  }

  const source = terms
    .map((term) => (search.regex ? term : term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('|');

  try {
    return { pattern: new RegExp(source, search.caseSensitive ? 'g' : 'gi'), field };
  } catch {
    return NOTHING;
  }
}

/** Whether two markings would paint the same thing, which is what decides a repaint. */
export function same(a: Marking, b: Marking): boolean {
  return (
    a.field === b.field &&
    a.pattern?.source === b.pattern?.source &&
    a.pattern?.flags === b.pattern?.flags
  );
}
