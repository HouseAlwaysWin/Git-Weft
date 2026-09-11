/**
 * How wide each column is, which of them are shown, and the grips between them.
 *
 * Including the lanes, which have no heading of their own - they are the header's left padding -
 * but are a column in every way that matters here: they can be dragged, they have a grip, and the
 * width they end up with is what everything to the right of them is laid out around.
 *
 * What it does not decide is the *sort*. The headings are buttons for both things and it reads as
 * one feature, but "how wide is Author" and "order by Author" share nothing but a click target -
 * so the ordering stays with the rows it orders.
 */

import { close as closeMenu, showAt } from './contextMenu.ts';
import { span } from './dom.ts';

const columnsEl = document.getElementById('columns') as HTMLElement;

/** The rows, whose own left padding has to keep step with the header's. */
const rowsEl = document.getElementById('rows') as HTMLElement;

/** What the grips were last placed against, so they are only re-measured when it moves. */
let columnGeometry = '';

/**
 * Whether the Date column has room for the time as well as the day.
 *
 * A date column wide enough for `2022-01-25` and no wider is the right default - the day is what
 * a history is read by, and four thousand rows of `00:00` beside it is noise. But two commits an
 * hour apart on the same day are indistinguishable without it, which is exactly the moment anybody
 * widens the column. So the format follows the width rather than a setting: drag it out and the
 * time appears, drag it back and it goes.
 */
let dateWide = false;

/** A date with the time, in digits, for measuring against the column. */
const DATE_WITH_TIME = '2222-22-22 22:22';

/**
 * Measures text in the row's own font.
 *
 * Its own canvas rather than the graph's: nothing else sets a font on that one, and borrowing it
 * to ask a question about text would leave the answer to the next drawing pass' assumptions.
 */
const ruler = document.createElement('canvas').getContext('2d');

/**
 * What the lanes are actually given, which is not always what they asked for.
 *
 * A repository with thirty concurrent branches wants three hundred and sixty pixels of lanes, and
 * on a side panel that is the whole width - the subjects end up as `feat(s…`, which is the column
 * people came to read. So the graph is capped by default and can be dragged, and when it has less
 * room than it wanted the lanes are drawn closer together rather than cut off: a graph missing its
 * right-hand branches is a graph that is lying about the history.
 *
 * null means "whatever the lanes need, up to the cap" - the state it is in until somebody drags.
 */
let graphColumn: number | null = null;

/*
 * The three columns that can be resized and switched off.
 *
 * Description is not among them on purpose. It is the `1fr` that absorbs whatever the other three
 * leave, so it has no width of its own to drag, and it is the column people came to read - a header
 * menu that offers to hide it is offering a graph with no subjects in it.
 *
 * Defaults stay in `ch` rather than pixels so they follow the editor's font. A width only becomes a
 * number once somebody drags one, and only that column stops adapting.
 */
const FIXED_COLUMNS = [
  { key: 'author', label: 'Author', fallback: '16ch' },
  { key: 'date', label: 'Date', fallback: '10ch' },
  { key: 'sha', label: 'Commit', fallback: '9ch' },
] as const;

type ColumnKey = (typeof FIXED_COLUMNS)[number]['key'];

const columnState: Record<string, { width?: number; hidden: boolean }> = {
  author: { hidden: false },
  date: { hidden: false },
  sha: { hidden: false },
};

/** The narrowest a column may be dragged - below this the header text is gone and so is the grip. */
const MIN_COLUMN = 36;

/**
 * Push the column layout onto the root, where the stylesheet reads it.
 *
 * Custom properties rather than a generated stylesheet: the content security policy has no
 * `unsafe-inline` for styles, and setting a property through the CSSOM is not what that forbids.
 */
function applyColumns(): void {
  const root = document.documentElement;
  const tracks = ['minmax(6ch, 1fr)'];
  let track = 1;

  for (const column of FIXED_COLUMNS) {
    const state = columnState[column.key] ?? { hidden: false };

    if (state.hidden) {
      root.style.setProperty(`--weft-col-${column.key}-show`, 'none');
      continue;
    }

    root.style.removeProperty(`--weft-col-${column.key}-show`);
    track += 1;
    tracks.push(state.width === undefined ? column.fallback : `${state.width}px`);
    root.style.setProperty(`--weft-col-${column.key}`, String(track));
  }

  root.style.setProperty('--weft-columns', tracks.join(' '));
  placeGrips();
  redraw();
}

/**
 * Decide whether the time fits, and repaint if the answer changed.
 *
 * Measured rather than compared against a pixel count, because the answer is about a font: the same
 * column is wide enough in one theme's font and not in another's.
 */
function measureDateWidth(): void {
  const cell = columnsEl.querySelector<HTMLElement>(".col[data-sort='date']");

  if (cell === null || ruler === null) {
    return;
  }

  // The row's date, not the heading: they are different sizes, and it is the row that has to fit.
  const sample = rowsEl.querySelector<HTMLElement>('.row .date') ?? cell;
  const style = getComputedStyle(sample);

  ruler.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

  // A few pixels of room, or the text sits flush against the edge and is ellipsised for it.
  const fits = ruler.measureText(DATE_WITH_TIME).width + 6 <= cell.getBoundingClientRect().width;

  if (fits !== dateWide) {
    dateWide = fits;
    redraw();
  }
}

/**
 * Put each grip on its column's left edge.
 *
 * Measured rather than computed: the tracks can be `ch`, the gap is its own value, and the header
 * carries a left padding that follows the graph's width. Reading the boxes back is the one way to
 * be right about all three at once.
 */
function placeGrips(): void {
  // Called from a drag and from a column being shown or hidden, neither of which is a frame - and
  // from the one frame in a hundred where the geometry moved, which is measuring the DOM here
  // anyway. Either way the numbers have to be current rather than last frame's.
  measure();

  const bar = columnsEl.getBoundingClientRect();

  measureDateWidth();
  const graphGrip = columnsEl.querySelector<HTMLElement>(".col-grip[data-grip='graph']");

  if (graphGrip !== null) {
    // The lanes have no header cell of their own - they are the header's left padding - so this one
    // is placed from the padding rather than measured off a column.
    const room = laneRoom();
    graphGrip.hidden = flat() || room === 0;
    graphGrip.style.left = `${room + 4}px`;
  }

  for (const column of FIXED_COLUMNS) {
    const grip = columnsEl.querySelector<HTMLElement>(`.col-grip[data-grip='${column.key}']`);
    const cell = columnsEl.querySelector<HTMLElement>(`.col[data-sort='${column.key}']`);

    if (grip === null || cell === null) {
      continue;
    }

    const state = columnState[column.key] ?? { hidden: false };
    grip.hidden = state.hidden;

    if (!state.hidden) {
      // Half the gap to the left of the cell, so the line sits between the two columns rather than
      // against the text of one of them.
      grip.style.left = `${cell.getBoundingClientRect().left - bar.left - 8}px`;
    }
  }
}

function setColumnWidth(key: ColumnKey, width: number): void {
  const state = columnState[key];

  if (state === undefined) {
    return;
  }

  // Leave the subject something to be. Without a ceiling a determined drag can take every pixel,
  // and the column that matters most is the one with no minimum of its own to defend it.
  const ceiling = Math.max(MIN_COLUMN, columnsEl.clientWidth - 120);

  state.width = Math.round(Math.min(Math.max(width, MIN_COLUMN), ceiling));
  applyColumns();
}

columnsEl.addEventListener('pointerdown', (event: PointerEvent) => {
  const grip = (event.target as HTMLElement).closest('.col-grip') as HTMLElement | null;

  if (grip === null) {
    return;
  }

  const key = grip.dataset['grip'] as ColumnKey | 'graph';

  if (key === 'graph') {
    const startX = event.clientX;
    const startRoom = laneRoom();

    grip.setPointerCapture(event.pointerId);
    grip.classList.add('dragging');
    event.preventDefault();

    // The lanes are on the left, so the boundary moving right is the graph growing - the opposite
    // of the fixed columns, which are anchored to the other edge.
    const onGraphMove = (move: PointerEvent): void => {
      const ceiling = Math.max(MIN_COLUMN, columnsEl.clientWidth - 160);
      graphColumn = Math.round(
        Math.min(Math.max(startRoom + (move.clientX - startX), MIN_COLUMN), ceiling),
      );
      placeGrips();
      redraw();
    };

    const onGraphUp = (): void => {
      grip.classList.remove('dragging');
      grip.removeEventListener('pointermove', onGraphMove);
      grip.removeEventListener('pointerup', onGraphUp);
      grip.removeEventListener('pointercancel', onGraphUp);
      remember();
    };

    grip.addEventListener('pointermove', onGraphMove);
    grip.addEventListener('pointerup', onGraphUp);
    grip.addEventListener('pointercancel', onGraphUp);
    return;
  }

  const cell = columnsEl.querySelector<HTMLElement>(`.col[data-sort='${key}']`);

  if (cell === null) {
    return;
  }

  const startX = event.clientX;
  const startWidth = cell.getBoundingClientRect().width;

  grip.setPointerCapture(event.pointerId);
  grip.classList.add('dragging');
  event.preventDefault();

  // The fixed columns are anchored to the right, so the boundary moving left is the column growing.
  const onMove = (move: PointerEvent): void => setColumnWidth(key, startWidth - (move.clientX - startX));

  const onUp = (): void => {
    grip.classList.remove('dragging');
    grip.removeEventListener('pointermove', onMove);
    grip.removeEventListener('pointerup', onUp);
    grip.removeEventListener('pointercancel', onUp);
    remember();
  };

  grip.addEventListener('pointermove', onMove);
  grip.addEventListener('pointerup', onUp);
  grip.addEventListener('pointercancel', onUp);
});

// Double-clicking a sash to reset it is the convention everywhere else in VS Code.
columnsEl.addEventListener('dblclick', (event: MouseEvent) => {
  const grip = (event.target as HTMLElement).closest('.col-grip') as HTMLElement | null;

  if (grip === null) {
    return;
  }

  if (grip.dataset['grip'] === 'graph') {
    // Back to taking what the lanes need, up to the ceiling - which is a rule that adapts, rather
    // than a number that happened to be right on one panel width.
    graphColumn = null;
    placeGrips();
    redraw();
    remember();
    return;
  }

  const state = columnState[grip.dataset['grip'] as ColumnKey];

  if (state !== undefined) {
    // Back to the `ch` default, which means back to following the font rather than to a number
    // that happened to be right once.
    delete state.width;
    applyColumns();
    remember();
  }
});

/** Right-clicking the header offers the columns; Description is listed but never switchable. */
function openColumnMenu(event: MouseEvent): void {
  closeMenu();

  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');

  const entry = (label: string, on: boolean, run: (() => void) | null): void => {
    const el = document.createElement('div');

    el.className = `menu-item${run === null ? ' disabled' : ''}`;
    el.setAttribute('role', 'menuitemcheckbox');
    el.setAttribute('aria-checked', String(on));
    el.append(span('menu-tick', on ? '\u2713' : '\u00A0'), span('menu-label-text', label));

    if (run !== null) {
      el.addEventListener('click', () => {
        closeMenu();
        run();
      });
    }

    menu.append(el);
  };

  // Listed and greyed rather than left out: its absence would read as a bug of its own, and the
  // reason it cannot be switched off is that it is the column people came to read.
  entry('Description', true, null);

  for (const column of FIXED_COLUMNS) {
    const state = columnState[column.key] ?? { hidden: false };

    entry(column.label, !state.hidden, () => {
      state.hidden = !state.hidden;
      applyColumns();
      remember();
    });
  }

  const rule = document.createElement('div');
  rule.className = 'menu-separator';
  menu.append(rule);

  const reset = document.createElement('div');
  reset.className = 'menu-item';
  reset.setAttribute('role', 'menuitem');
  reset.textContent = 'Reset columns';
  reset.addEventListener('click', () => {
    closeMenu();

    for (const column of FIXED_COLUMNS) {
      columnState[column.key] = { hidden: false };
    }

    applyColumns();
    remember();
  });

  menu.append(reset);
  showAt(menu, event.clientX, event.clientY);
}

columnsEl.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  openColumnMenu(event);
});

/** What the view supplies, because none of it is this module's to know. */
let remember: () => void = () => undefined;
let redraw: () => void = () => undefined;
let measure: () => void = () => undefined;
let laneRoom: () => number = () => 0;
let flat: () => boolean = () => false;

export function connect(options: {
  /** Save the view state; a width or a hidden column is remembered across a reload. */
  remember: () => void;
  /** Ask for a frame, because a column moving changes what the rows and the lanes look like. */
  redraw: () => void;
  /** Re-read the panel's geometry, which the grips are placed from. */
  measure: () => void;
  /** How much room the lanes are actually given. */
  laneRoom: () => number;
  /** Whether the graph is switched off, in which case the lanes' grip has nothing to grip. */
  flat: () => boolean;
}): void {
  remember = options.remember;
  redraw = options.redraw;
  measure = options.measure;
  laneRoom = options.laneRoom;
  flat = options.flat;
}

/** The width the lanes were dragged to, or null while they take what they need. */
export function graphRoom(): number | null {
  return graphColumn;
}

/** Whether the Date column is wide enough to hold a time as well as a day. */
export function showsTime(): boolean {
  return dateWide;
}

/**
 * Put the grips back, but only when the geometry actually moved.
 *
 * This runs every frame, and four rect reads a frame during a scroll is the kind of thing that
 * turns a smooth list into a stuttering one.
 */
export function reposition(key: string): void {
  if (key !== columnGeometry) {
    columnGeometry = key;
    placeGrips();
  }
}

/** For the view's saved state. */
export function saved(): {
  columns: Record<string, { width?: number; hidden: boolean }>;
  graphColumn?: number;
} {
  const saved: Record<string, { width?: number; hidden: boolean }> = {};

  for (const column of FIXED_COLUMNS) {
    const state = columnState[column.key];

    saved[column.key] = {
      ...(state?.width === undefined ? {} : { width: state.width }),
      hidden: state?.hidden === true,
    };
  }

  return { columns: saved, ...(graphColumn === null ? {} : { graphColumn }) };
}

export function restore(state: {
  readonly columns?: Readonly<Record<string, { readonly width?: number; readonly hidden?: boolean }>>;
  readonly graphColumn?: number;
}): void {
  graphColumn = typeof state.graphColumn === 'number' ? state.graphColumn : null;

  for (const column of FIXED_COLUMNS) {
    const restored = state.columns?.[column.key];

    if (restored !== undefined) {
      // Assigned rather than spread: an explicit `width: undefined` is a different thing from no
      // width at all, and only the second means "follow the font".
      columnState[column.key] = {
        ...(typeof restored.width === 'number' ? { width: restored.width } : {}),
        hidden: restored.hidden === true,
      };
    }
  }

  applyColumns();
}
