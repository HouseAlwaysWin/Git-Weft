/**
 * The filter bar: what the reader types and picks, and when git is told about it.
 *
 * The search box and the date range are one thing rather than two. They combine - "what did Ada
 * touch today" is one question - they are sent as separate messages only because git takes them as
 * separate arguments, and they share the one piece of state that matters here: what the host was
 * last told. Every one of these messages costs a full walk of the history, and the ways to ask for
 * a walk that is already on screen are not exotic: type a word and delete it, open the custom range
 * and close it again, pick `any time` when there was never a date filter.
 *
 * What it does not decide is what the answer looks like. The marking inside a row is derived from
 * the search rather than from the boxes - see `highlight.ts` - and the rows, the selection and the
 * frame are the view's. This owns the controls, the debounce, and the rule about not asking twice.
 */

import type { DateRange } from '../git/dates.ts';
import type { Search, SearchMode, SearchToggle } from '../git/search.ts';
import { TOGGLES, fileHistorySearch } from '../git/search.ts';
import type { WebviewMessage } from '../protocol.ts';

/*
 * Search is debounced and pushed down to git: every keystroke would otherwise start a fresh walk of
 * the history. 300ms is long enough that typing a word costs one query, short enough to feel live.
 */
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchMode = document.getElementById('search-mode') as HTMLSelectElement;
const searchToggles = document.getElementById('search-toggles') as HTMLElement;
let searchTimer: number | undefined;

/*
 * All four off by default, which makes the plain case the honest one: what you typed is what git
 * looks for. It used to be a case-insensitive regex whether you wanted one or not, so `v0.4.1`
 * quietly also matched `v0X4Y1`; `.*` turns that back on when it is what you meant.
 */
const searchOptions: Record<SearchToggle, boolean> = {
  caseSensitive: false,
  regex: false,
  allTerms: false,
  invert: false,
  follow: false,
};

function currentMode(): SearchMode {
  return searchMode.value as SearchMode;
}

/**
 * Put the selected option's own tooltip on the closed dropdown.
 *
 * A `<select>` shows its own title when it is shut, not the selected option's - so without this the
 * only way to read what a mode does is to open the list and hover the entry you have already
 * chosen. The modes are not self-describing enough for that: `content` searches the files rather
 * than the message, and nothing about the word says so.
 */
function updateModeTooltip(): void {
  const chosen = searchMode.selectedOptions[0];
  searchMode.title = chosen?.title ?? '';
}

/** The switches this mode honours; the rest are not shown, because they would do nothing. */
function applicable(): readonly SearchToggle[] {
  return TOGGLES[currentMode()] ?? [];
}

/** What the search box currently asks for, or null when it asks for nothing. */
function currentSearch(): Search | null {
  const query = searchInput.value.trim();

  return query.length === 0 ? null : { query, mode: currentMode(), ...searchOptions };
}

function submitSearch(): void {
  const query = searchInput.value.trim();

  // A hash is a destination, not a pattern - if it reaches a row. See `jump` on `connect`.
  if (query.length > 0 && jump(query)) {
    return;
  }

  remember();

  const next = JSON.stringify(currentSearch());

  if (next !== sentSearch) {
    sentSearch = next;
    post({ type: 'search', search: currentSearch() });
  }
}

function queueSearch(): void {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(submitSearch, 300);
}


function updateSearchToggles(): void {
  const supported = applicable();

  /*
   * `--follow` refuses a pathspec with magic in it: `git log --follow -- ':(icase)x'` is a fatal
   * error rather than a quieter answer. So following renames means matching the path exactly, and
   * the case switch is shown locked on instead of offering to turn off something that git was
   * never going to do.
   */
  const exact = currentMode() === 'path' && searchOptions.follow;

  searchToggles.querySelectorAll<HTMLButtonElement>('.toggle').forEach((button) => {
    const toggle = button.dataset['toggle'] as SearchToggle;
    const shown = supported.includes(toggle);
    const locked = exact && toggle === 'caseSensitive';

    button.hidden = !shown;
    button.disabled = locked;
    button.classList.toggle('on', shown && (locked || searchOptions[toggle]));

    if (locked) {
      button.title = 'Following renames matches the path exactly: git will not follow a case-insensitive pathspec.';
    }
  });
}

searchToggles.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('.toggle') as HTMLButtonElement | null;

  if (button === null || button.disabled) {
    return;
  }

  const toggle = button.dataset['toggle'] as SearchToggle;
  searchOptions[toggle] = !searchOptions[toggle];

  updateSearchToggles();
  remember();
  rehighlight();

  // A click is a decision, not a keystroke: there is nothing to wait for.
  if (searchInput.value.trim().length > 0) {
    window.clearTimeout(searchTimer);
    submitSearch();
  }
});

searchInput.addEventListener('input', () => {
  rehighlight();
  queueSearch();
});

searchMode.addEventListener('change', () => {
  updateModeTooltip();
  updateSearchToggles();
  rehighlight();

  if (searchInput.value.trim().length > 0) {
    submitSearch();
  }
});


/**
 * Put every control in the bar back to "no filter", without asking for anything.
 *
 * Silent on purpose: this runs *because* the host has already dropped the filters and is reloading,
 * so a `search` or `dates` message from here would be a second walk saying the same thing. The
 * memo of what was last sent is reset with them, so the next real filter is not mistaken for one
 * the host already has.
 */
export function clear(): void {
  searchInput.value = '';
  searchMode.value = 'message';
  dateRange.value = '';
  dateSince.value = '';
  dateUntil.value = '';
  dateCustom.hidden = true;

  for (const toggle of Object.keys(searchOptions) as SearchToggle[]) {
    searchOptions[toggle] = false;
  }

  window.clearTimeout(searchTimer);
  sentSearch = 'null';
  sentDates = 'null';
  updateSearchToggles();
  rehighlight();
}


/*
 * The date filter. A separate message from the search rather than a mode of it, because the two
 * combine: "what did Ada touch today" is one question, not two that cancel each other out.
 */
const dateRange = document.getElementById('date-range') as HTMLSelectElement;
const dateCustom = document.getElementById('date-custom') as HTMLElement;
const dateSince = document.getElementById('date-since') as HTMLInputElement;
const dateUntil = document.getElementById('date-until') as HTMLInputElement;
const dateClose = document.getElementById('date-close') as HTMLButtonElement;

/*
 * What the host was last told, so that telling it again can be skipped.
 *
 * Every one of these messages costs a full walk of the history, and the ways to ask for a walk that
 * is already on screen are not exotic: type a word and delete it, open the custom range and close
 * it again, pick `any time` when there was never a date filter.
 */
let sentSearch = 'null';
let sentDates = 'null';

/**
 * A day, `YYYY-MM-DD`, in the reader's own timezone.
 *
 * `toISOString` would be UTC, which is the wrong day for anyone far enough east or west of it -
 * "today" would start in the middle of the afternoon, or yesterday.
 */
function day(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The range the controls are currently describing, or null for the whole history. */
function currentRange(): DateRange | null {
  const choice = dateRange.value;

  if (choice === '') {
    return null;
  }

  if (choice === 'custom') {
    const since = dateSince.value === '' ? null : dateSince.value;
    const until = dateUntil.value === '' ? null : dateUntil.value;

    return since === null && until === null ? null : { since, until };
  }

  // The presets are all "the last N days, today included", and today is N = 0.
  const back = choice === 'today' ? 0 : Number(choice);
  const from = new Date();

  from.setDate(from.getDate() - back);

  return { since: day(from), until: null };
}

/**
 * Ask for one file's history: the path search, with renames followed.
 *
 * Driven from the changed-file list rather than typed, so the path is git's own spelling of it -
 * which matters more than usual here, because following renames is the one path search that cannot
 * be case-insensitive.
 */
function showHistory(path: string): void {
  // What it asks for is decided in `search.ts`, where it can be tested. Following renames is off,
  // and the reason is measured there.
  const wanted = fileHistorySearch(path);

  searchMode.value = wanted.mode;
  searchInput.value = wanted.query;

  for (const toggle of Object.keys(searchOptions) as SearchToggle[]) {
    searchOptions[toggle] = wanted[toggle];
  }

  dateRange.value = '';
  dateSince.value = '';
  dateUntil.value = '';
  dateCustom.hidden = true;

  updateSearchToggles();
  rehighlight();
  submitDates();
  window.clearTimeout(searchTimer);
  submitSearch();
}

function submitDates(): void {
  dateCustom.hidden = dateRange.value !== 'custom';
  remember();

  const range = currentRange();
  const next = JSON.stringify(range);

  if (next !== sentDates) {
    sentDates = next;
    post({ type: 'dates', range });
  }
}

dateRange.addEventListener('change', () => {
  /*
   * Opening the custom row is not itself a filter: with both boxes empty there is no range to ask
   * for, and reloading the graph to show what it already shows is a walk nobody asked for.
   */
  const opening = dateRange.value === 'custom' && currentRange() === null;

  dateCustom.hidden = dateRange.value !== 'custom';

  if (opening) {
    dateSince.focus();
    return;
  }

  submitDates();
});

dateSince.addEventListener('change', submitDates);
dateUntil.addEventListener('change', submitDates);

dateClose.addEventListener('click', () => {
  dateRange.value = '';
  dateSince.value = '';
  dateUntil.value = '';
  submitDates();
});

searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    window.clearTimeout(searchTimer);
    submitSearch();
  } else if (event.key === 'Escape') {
    searchInput.value = '';
    submitSearch();
  }

  // Arrow keys belong to the text field while it has focus, not to the commit list.
  event.stopPropagation();
});

/** What the view supplies, because none of it is this module's to know. */
let post: (message: WebviewMessage) => void = () => undefined;
let remember: () => void = () => undefined;
let rehighlight: () => void = () => undefined;
let jump: (query: string) => boolean = () => false;

export function connect(options: {
  /** Where a search or a date range goes. */
  post: (message: WebviewMessage) => void;
  /** Save the view state, so the boxes come back holding what they held. */
  remember: () => void;
  /** Re-read the search into the row markup, which is the view's to paint. */
  rehighlight: () => void;
  /**
   * Try to land on a commit id, and say whether it landed.
   *
   * A hash is a destination, not a pattern - but only when it actually reaches a row. Falling
   * through to the search means `deadbeef` in a commit message is still findable, and nothing is
   * lost by trying the jump first. Which rows exist and what selecting one means are the view's.
   */
  jump: (query: string) => boolean;
}): void {
  post = options.post;
  remember = options.remember;
  rehighlight = options.rehighlight;
  jump = options.jump;
}

/** What the search box currently asks for, or null when it asks for nothing. */
export function search(): Search | null {
  return currentSearch();
}

/** The stretch of time the controls are describing, or null for the whole history. */
export function range(): DateRange | null {
  return currentRange();
}

/**
 * Count what the boxes are showing as already sent.
 *
 * The filters go out with the handshake rather than as a second message, so the host walks the
 * history once - with the filters the boxes are showing rather than with whatever it still held.
 */
export function prime(): void {
  sentSearch = JSON.stringify(currentSearch());
  sentDates = JSON.stringify(currentRange());
}

/** The reader wants to type. */
export function focus(): void {
  searchInput.focus();
  searchInput.select();
}

/** Ask for one file's history, from the host's own command. */
export function history(path: string): void {
  showHistory(path);
}

/** Draw the bar as its current state says it should be - for startup, after a restore. */
export function refresh(): void {
  updateModeTooltip();
  updateSearchToggles();
}

/** For the view's saved state. */
export function saved(): {
  searchOptions: Record<SearchToggle, boolean>;
  query: string;
  mode: SearchMode;
  dateChoice: string;
  dateSince: string;
  dateUntil: string;
} {
  return {
    searchOptions: { ...searchOptions },
    query: searchInput.value,
    mode: currentMode(),
    dateChoice: dateRange.value,
    dateSince: dateSince.value,
    dateUntil: dateUntil.value,
  };
}

export function restore(state: {
  searchOptions?: Record<SearchToggle, boolean>;
  query?: string;
  mode?: SearchMode;
  dateChoice?: string;
  dateSince?: string;
  dateUntil?: string;
}): void {
  if (state.searchOptions !== undefined) {
    Object.assign(searchOptions, state.searchOptions);
  }

  searchInput.value = state.query ?? '';
  searchMode.value = state.mode ?? 'message';
  updateModeTooltip();
  dateRange.value = state.dateChoice ?? '';
  dateSince.value = state.dateSince ?? '';
  dateUntil.value = state.dateUntil ?? '';
  dateCustom.hidden = dateRange.value !== 'custom';
}
