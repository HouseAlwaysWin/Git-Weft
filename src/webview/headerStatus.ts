/**
 * Everything the header says about what is going on, as opposed to what is in the history.
 *
 * Four things that look unrelated and are not: whether a walk is running, why the pane is empty,
 * whether the repository is halfway through a rebase, and how far the branch is from its upstream.
 * Every one of them is the view admitting to something the rows cannot show - a walk in flight has
 * no rows yet, an empty pane has no rows by definition, a conflicted merge is a state rather than a
 * commit, and "3 behind" is about a ref that is not being drawn.
 *
 * They also interlock, which is the real reason they are together. The empty sentence depends on
 * whether the walk is running, and on whether it has been running long enough to admit it: three
 * states look identical without that - still walking, finished with nothing to show, and narrowed
 * to nothing by a filter somewhere else - and saying the wrong one sends the reader looking for
 * commits that are not there.
 *
 * What is *in* the history is not here. This module never reads a row.
 */

import type { Upstream } from '../git/repoState.ts';
import type { MenuItem } from '../actions/types.ts';
import type { WebviewMessage } from '../protocol.ts';
import { span } from './dom.ts';

const progressEl = document.getElementById('progress') as HTMLElement;
const emptyEl = document.getElementById('empty') as HTMLElement;
const upstreamEl = document.getElementById('upstream') as HTMLElement;

/** The last thing the host said about the remote, kept so the age beside it can keep counting. */
let remote: { upstream: Upstream | null; branch: string | null; fetchedAt: number | null } = {
  upstream: null,
  branch: null,
  fetchedAt: null,
};


/**
 * Whether a walk is in flight, and how long before saying so.
 *
 * Not immediately. Most reloads finish in tens of milliseconds - a tick moved, a file was saved -
 * and a bar that appears and vanishes inside one blink is worse than no bar: it reads as a glitch
 * rather than as progress. A walk that is going to take four seconds has still said so within a
 * quarter of one.
 */
const BUSY_AFTER_MS = 250;

let busy = false;

/** Whether the delay has passed, so the bar and the sentence appear together or not at all. */
let saying = false;

/** What git said, when the last walk did not finish. Cleared by the reset that starts the next. */
let walkError: string | null = null;
let busyTimer = 0;

function busyChanged(on: boolean): void {
  busy = on;
  window.clearTimeout(busyTimer);

  if (!on) {
    saying = false;
    progressEl.hidden = true;
    updateEmpty();
    return;
  }

  saying = false;
  progressEl.hidden = true;
  updateEmpty();

  busyTimer = window.setTimeout(() => {
    saying = busy;
    progressEl.hidden = !busy;
    updateEmpty();
  }, BUSY_AFTER_MS);
}

/**
 * The sentence in the middle of an empty pane.
 *
 * Three states look identical without it and mean completely different things: still walking,
 * finished with nothing to show, and narrowed to nothing by a filter somewhere else. The status
 * line says which, in a grey 0.9em at the far right of the header - which is where you look for it
 * once you already know it is there.
 */
function updateEmpty(): void {
  if (showing() > 0) {
    emptyEl.hidden = true;
    return;
  }

  // Nothing at all while a quick reload is in flight: the rows are cleared before the new ones
  // arrive, and a sentence that appears for a tenth of a second is a flicker, not an explanation.
  emptyEl.hidden = busy && !saying;

  /*
   * A walk that failed leaves exactly the same empty pane as a repository with nothing in it, and
   * saying the second when the first happened is worse than saying nothing: the reader goes looking
   * for commits that are there. git's own words, which are worth the room now that the streaming
   * path keeps them.
   */
  emptyEl.textContent = busy
    ? 'Walking the history…'
    : walkError !== null
      ? walkError
      : filtered()
        ? 'No commits match the filters. Clear Filters puts them all back.'
        : 'Nothing to draw. This repository has no commits yet.';
}


const operationEl = document.getElementById('operation') as HTMLElement;

/**
 * The banner for whatever git is halfway through.
 *
 * It is deliberately loud and deliberately at the top: an unfinished rebase changes what every
 * other action means, and a graph that draws history without mentioning it is how someone ends up
 * several commands deep in a state they did not know they were in.
 *
 * Conflicted files are listed and clickable. Weft does not resolve them - VS Code's merge editor
 * is better at that than anything that would fit here - so clicking one hands it over.
 */
function renderOperation(
  operation: string,
  description: string,
  conflicted: readonly string[],
  controls: readonly MenuItem[],
): void {
  if (operation === 'none') {
    operationEl.hidden = true;
    operationEl.replaceChildren();
    redraw();
    return;
  }

  const headline = document.createElement('div');
  headline.className = 'operation-headline';
  headline.append(span('operation-what', `You are in the middle of ${description}.`));

  const buttons = document.createElement('span');
  buttons.className = 'operation-controls';

  for (const control of controls) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = control.label;
    button.className = control.destructive ? 'destructive' : '';

    if (control.disabledReason === null) {
      button.addEventListener('click', () =>
        post({ type: 'runAction', id: control.id, target: { kind: 'repo' } }),
      );
    } else {
      button.disabled = true;
      button.title = control.disabledReason;
    }

    buttons.append(button);
  }

  headline.append(buttons);
  operationEl.replaceChildren(headline);

  if (conflicted.length > 0) {
    const list = document.createElement('div');
    list.className = 'operation-conflicts';
    list.append(
      span(
        'operation-conflicts-heading',
        `${conflicted.length} ${conflicted.length === 1 ? 'file needs' : 'files need'} resolving:`,
      ),
    );

    for (const path of conflicted) {
      const entry = document.createElement('span');
      entry.className = 'operation-conflict';
      entry.textContent = path;
      entry.title = `Open ${path} in the merge editor`;
      entry.addEventListener('click', () => post({ type: 'openConflict', path }));
      list.append(entry);
    }

    operationEl.append(list);
  }

  operationEl.hidden = false;
  redraw();
}


/** `3h`, `12m`, `just now` - short enough to sit next to two numbers without becoming a sentence. */
function ago(since: number): string {
  const minutes = Math.floor((Date.now() - since) / 60_000);

  if (minutes < 1) {
    return 'just now';
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);

  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * Where the branch stands against the one it tracks, and how old that answer is.
 *
 * The age is not decoration. `origin/main` is a local pointer that only a fetch moves, so every
 * count here is a statement about the last fetch rather than about now - `↓0` after three hours
 * offline means "nothing had arrived three hours ago", and read without the timestamp it means
 * "you are up to date". That is the whole way a graph misleads about a remote, and it is why this
 * stays on screen when the counts are zero: the zero is the number most likely to be believed.
 */
function renderRemote(): void {
  const { upstream, branch, fetchedAt } = remote;

  if (upstream === null && fetchedAt === null) {
    upstreamEl.hidden = true;
    return;
  }

  // Not the branch name: the button beside this says it, and on `claude/changelog-v0.52.0` having
  // it twice was most of why the row would not fit. (It was also picking up `.branch-name` from the
  // menu rows, `flex: 1 1 auto` and all, and growing to fill whatever was left.)
  const parts: HTMLElement[] = [];

  if (upstream?.gone === true) {
    // The ref's name is in the tooltip; on the line it would only push the branch out of sight.
    parts.push(span('gone', 'upstream gone'));
  } else if (upstream !== null) {
    if (upstream.ahead > 0) {
      parts.push(span('ahead', `↑${upstream.ahead}`));
    }

    if (upstream.behind > 0) {
      parts.push(span('behind', `↓${upstream.behind}`));
    }
  }

  parts.push(span('fetched', fetchedAt === null ? 'never fetched' : `fetched ${ago(fetchedAt)}`));

  upstreamEl.replaceChildren(...parts);

  const standing =
    upstream === null
      ? 'This branch tracks nothing.'
      : upstream.gone
        ? `${branch ?? 'HEAD'} tracks ${upstream.ref}, which no longer exists on the remote.`
        : `${branch ?? 'HEAD'} is ${upstream.ahead} ahead of and ${upstream.behind} behind ${upstream.ref}.`;

  upstreamEl.title =
    fetchedAt === null
      ? `${standing}\n\nNothing has been fetched yet, so the remote's position is unknown.`
      : `${standing}\n\nTrue as of the last fetch, ${ago(fetchedAt)}. A remote-tracking ref only moves when something fetches.`;

  upstreamEl.hidden = false;
}

// The age has to keep counting on its own: with no fetch and no reload, nothing else would ever
// come along to correct "just now" into the hour it has since become.
window.setInterval(() => {
  if (!upstreamEl.hidden) {
    renderRemote();
  }
}, 30_000);

/** What the view supplies, because none of it is this module's to know. */
let post: (message: WebviewMessage) => void = () => undefined;
let redraw: () => void = () => undefined;
let showing: () => number = () => 0;
let filtered: () => boolean = () => false;

export function connect(options: {
  /** Where a message goes: the banner's buttons ask the host to continue or abort. */
  post: (message: WebviewMessage) => void;
  /** Ask for a frame - the banner takes room at the top, so the rows below it move. */
  redraw: () => void;
  /** How many rows are on screen, which is what "empty" means. */
  showing: () => number;
  /** Whether something is narrowing the view, which is *why* it can be empty. */
  filtered: () => boolean;
}): void {
  post = options.post;
  redraw = options.redraw;
  showing = options.showing;
  filtered = options.filtered;
}

/** Whether a walk is in flight. */
export function setBusy(on: boolean): void {
  busyChanged(on);
}

/** Re-read the empty sentence, for when what is on screen changed without the walk changing. */
export function refresh(): void {
  updateEmpty();
}

/** What the host says the repository is halfway through, or nothing. */
export function operation(
  kind: string,
  description: string,
  conflicted: readonly string[],
  controls: readonly MenuItem[],
): void {
  renderOperation(kind, description, conflicted, controls);
}

/** What the host says about the remote, kept so the age beside it can keep counting. */
export function fromRemote(next: {
  upstream: Upstream | null;
  branch: string | null;
  fetchedAt: number | null;
}): void {
  remote = next;
  renderRemote();
}

/** What git said, when the walk did not finish. */
export function failed(message: string): void {
  walkError = message;
}

/** A reload is starting: whatever was being reported is about to stop being true. */
export function reset(): void {
  walkError = null;
  remote = { upstream: null, branch: null, fetchedAt: null };
  upstreamEl.hidden = true;
}
