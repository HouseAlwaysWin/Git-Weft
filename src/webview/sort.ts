/**
 * Ordering the commit list.
 *
 * The lanes are laid out in a single forward pass over git's output, and a lane point's Y *is* a
 * row index - so any order other than the one git delivered makes the lines join rows that are no
 * longer next to each other. Sorting therefore produces a flat list with the graph switched off,
 * and git's order is kept underneath, untouched, so it can be switched back on.
 *
 * This lives apart from the view for the usual reason: it is the one piece here that is pure, so it
 * is the one piece that can be tested without a browser.
 */

export type SortColumn = 'subject' | 'author' | 'date' | 'sha';
export type SortDirection = 'asc' | 'desc';

export interface Sort {
  readonly column: SortColumn;
  readonly direction: SortDirection;
}

/** Just enough of a row to put it in order. */
export interface SortableRow {
  readonly subject: string;
  readonly author: string;
  readonly date: string;
  readonly sha: string;
}

/**
 * Which way a column goes on the first click. Names read A to Z; dates read newest first, because
 * that is the order the column already had when it was part of the graph.
 */
export const FIRST_DIRECTION: Readonly<Record<SortColumn, SortDirection>> = {
  subject: 'asc',
  author: 'asc',
  date: 'desc',
  sha: 'asc',
};

/*
 * One collator for the whole session: constructing it is the expensive half, and a comparator that
 * built one per call would pay that cost n log n times.
 *
 * `numeric` so `v10` lands after `v9` rather than after `v1`, and `sensitivity: 'base'` so a name
 * does not appear in two places in the list because someone typed it lowercase once.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Rows in display order. The input is never mutated - it is the graph's order, and the view has to
 * be able to go back to it.
 *
 * Ties keep the order they arrived in, which `Array.prototype.sort` guarantees: two commits by the
 * same author stay in history order under the name rather than shuffling on every re-sort.
 */
export function sortRows<T extends SortableRow>(rows: readonly T[], sort: Sort): T[] {
  const sign = sort.direction === 'asc' ? 1 : -1;

  if (sort.column === 'date') {
    /*
     * `%aI` carries each commit's own UTC offset, so comparing the strings puts one written at
     * 01:00+08:00 *after* one written at 20:00-05:00 - eight hours before it. A date column means
     * the instant, so parse once per row rather than comparing the text.
     */
    const decorated = rows.map((row) => ({ row, at: Date.parse(row.date) }));
    decorated.sort((a, b) => sign * (a.at - b.at));
    return decorated.map((entry) => entry.row);
  }

  const out = [...rows];

  if (sort.column === 'sha') {
    // Hex: codepoint order is the only order there is, and a collator would only cost time.
    out.sort((a, b) => sign * (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
    return out;
  }

  const key: (row: SortableRow) => string =
    sort.column === 'author' ? (row) => row.author : (row) => row.subject;

  out.sort((a, b) => sign * collator.compare(key(a), key(b)));
  return out;
}

/**
 * `sortRows`, but not twice for the same question.
 *
 * The view re-derives itself on every message about the working tree - which is every file saved -
 * and sorting is the expensive half: measured on 78,000 rows, 333ms for Description, on the thread
 * that is also drawing. Saving a file cannot reorder a history, so it should not cost a reorder.
 *
 * The key is the array's identity *and* its length. A page pushes onto the same array, so the
 * length catches that; a reload replaces it outright, so the identity catches a new history that
 * happens to be the same size as the one before it.
 */
export class SortCache<T extends SortableRow> {
  private last: {
    rows: readonly T[];
    length: number;
    column: SortColumn;
    direction: SortDirection;
    out: T[];
  } | null = null;

  sorted(rows: readonly T[], sort: Sort): T[] {
    const last = this.last;

    if (
      last !== null &&
      last.rows === rows &&
      last.length === rows.length &&
      last.column === sort.column &&
      last.direction === sort.direction
    ) {
      return last.out;
    }

    const out = sortRows(rows, sort);

    this.last = {
      rows,
      length: rows.length,
      column: sort.column,
      direction: sort.direction,
      out,
    };

    return out;
  }

  /** Let go of a history nobody is showing any more. */
  clear(): void {
    this.last = null;
  }
}
