/**
 * The pane along the bottom, and the splitter above it.
 *
 * Three different things can be in it and they are not variations on one card: a commit has a hash,
 * an author, a message and parents; the working tree has none of those, because none of them exist
 * yet; a comparison is two commits and the distance between them. Each renders what it actually
 * has rather than a shared shape with empty fields in it, which is the honest way to say "there is
 * no author yet" - and the reason this is one module rather than one function.
 *
 * The pane is also the only thing here with a height somebody drags, and the graph's canvas is
 * sized to what is left over - so every change of height ends in a redraw, and the height is part
 * of the view state.
 */

import type { CommitInfo } from '../protocol.ts';
import type { WebviewMessage } from '../protocol.ts';
import type { SideCommit } from '../git/details.ts';
import { describeAge } from '../git/blame.ts';
import { findTickets } from '../git/ticketLinks.ts';
import { span } from './dom.ts';

/** The working tree as the host last described it - the counts, and where they would land. */
export interface WorkingTree {
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly conflicted: number;
  readonly branch: string | null;
}

const detailsEl = document.getElementById('details') as HTMLElement;
const detailMetaEl = document.getElementById('detail-meta') as HTMLElement;
const detailBodyEl = document.getElementById('detail-body') as HTMLElement;
const detailCommitsEl = document.getElementById('detail-commits') as HTMLElement;
const splitter = document.getElementById('splitter') as HTMLElement;

let detailsHeight = 200;
let currentDetails: CommitInfo | null = null;

/** The ticket patterns the host sent: ids in a commit message are marked by them. */
let ticketPatterns: readonly string[] = [];

/** `2026-07-28T13:37:20+08:00` -> `2026-07-28 13:37:20`, without pretending to know a locale. */
function formatDate(iso: string): string {
  return iso.slice(0, 19).replace('T', ' ');
}

/**
 * Resize the details pane. The graph's canvas is sized to the viewport, so every change has to be
 * followed by a redraw - the lanes would otherwise keep the height they had before the drag.
 */
function applyDetailsHeight(height: number): void {
  const max = Math.max(120, window.innerHeight - 160);
  detailsHeight = Math.round(Math.min(Math.max(height, 90), max));
  detailsEl.style.height = `${detailsHeight}px`;
  redraw();
}

splitter.addEventListener('pointerdown', (event: PointerEvent) => {
  const startY = event.clientY;
  const startHeight = detailsEl.getBoundingClientRect().height;

  splitter.setPointerCapture(event.pointerId);
  splitter.classList.add('dragging');
  event.preventDefault();

  const onMove = (move: PointerEvent): void => {
    // The pane is below the graph, so dragging up must make it taller.
    applyDetailsHeight(startHeight - (move.clientY - startY));
  };

  const onUp = (): void => {
    splitter.classList.remove('dragging');
    splitter.removeEventListener('pointermove', onMove);
    splitter.removeEventListener('pointerup', onUp);
    splitter.removeEventListener('pointercancel', onUp);
    remember();
  };

  splitter.addEventListener('pointermove', onMove);
  splitter.addEventListener('pointerup', onUp);
  splitter.addEventListener('pointercancel', onUp);
});

// Double-clicking a sash to reset it is the convention everywhere else in VS Code.
splitter.addEventListener('dblclick', () => {
  applyDetailsHeight(260);
  remember();
});

/**
 * Put the details pane away.
 *
 * The selection stays where it is - closing the pane is about wanting the graph's height back, not
 * about deselecting - so clicking another commit brings it straight back.
 */
function closeDetails(): void {
  detailsEl.hidden = true;
  splitter.hidden = true;
  redraw();
}

(document.getElementById('detail-close') as HTMLElement).addEventListener('click', closeDetails);

/** `3 staged, 2 unstaged, 1 untracked` - only the parts that are not zero. */
export function describeWorking(working: WorkingTree): string {
  const parts = [
    working.conflicted > 0 ? `${working.conflicted} conflicted` : '',
    working.staged > 0 ? `${working.staged} staged` : '',
    working.unstaged > 0 ? `${working.unstaged} unstaged` : '',
    working.untracked > 0 ? `${working.untracked} untracked` : '',
  ].filter((part) => part.length > 0);

  return parts.join(', ');
}

/**
 * The details pane for the working tree.
 *
 * No hash, no author, no message - none of them exist yet. What it can say is what is in the tree
 * and where it would land, and saying only that is more honest than a card of empty fields.
 */
function renderWorking(working: WorkingTree): void {
  currentDetails = null;
  detailsEl.hidden = false;
  splitter.hidden = false;
  applyDetailsHeight(detailsHeight);

  const meta = document.createDocumentFragment();
  const line = (label: string, value: string): void => {
    const wrap = document.createElement('div');
    const text = span('meta-value', value);

    wrap.append(span('meta-key', label), text);
    meta.append(wrap);
  };

  line('changes', describeWorking(working));

  if (working.branch !== null) {
    line('branch', working.branch);
  }

  detailMetaEl.replaceChildren(meta);
  detailBodyEl.replaceChildren();
  detailBodyEl.hidden = true;
  detailCommitsEl.replaceChildren();
  detailCommitsEl.hidden = true;
}

/** One end of a comparison, as the pane names it. */
type End = { readonly rev: string; readonly label: string; readonly sha: string; readonly drawn: boolean };

/** What the pane is told about a comparison. */
type ComparisonMessage = {
  readonly from: End;
  readonly to: End;
  readonly files: number;
  readonly onlyFrom: number;
  readonly onlyTo: number;
  readonly onlyFromCommits: readonly SideCommit[];
  readonly onlyToCommits: readonly SideCommit[];
};

/**
 * The pane for a comparison.
 *
 * Two counts rather than one, because two commits picked off a graph are not always one behind the
 * other - a single "N commits" would have to pick a side, and picking the wrong one is worse than
 * spending a line saying both.
 */
function renderComparison(message: ComparisonMessage): void {
  currentDetails = null;
  detailsEl.hidden = false;
  splitter.hidden = false;
  applyDetailsHeight(detailsHeight);

  const meta = document.createDocumentFragment();
  const line = (label: string, ...values: HTMLElement[]): void => {
    const wrap = document.createElement('div');
    const value = document.createElement('span');

    value.className = 'meta-value';
    value.append(...values);
    wrap.append(span('meta-key', label), value);
    meta.append(wrap);
  };

  // `.sha-full` carries a pointer cursor, so it has to actually do the thing it looks like it does.
  // Named as the end was asked for - a branch by its name - with the commit it came to on hover.
  const end = (at: End): HTMLElement => {
    const el = span('sha-full', at.label);

    el.title = `${at.sha}
Click to copy`;
    el.addEventListener('click', () => post({ type: 'copy', text: at.sha }));

    return el;
  };

  line('comparing', end(message.from), span('range-arrow', '→'), end(message.to));

  line(
    'changed',
    span('person', message.files === 1 ? '1 file' : `${message.files} files`),
  );

  line(
    'apart',
    span(
      'when',
      message.onlyFrom === 0 && message.onlyTo === 0
        ? 'the same commit content on both sides'
        : `${message.onlyFrom} commit${message.onlyFrom === 1 ? '' : 's'} only on ${message.from.label}, ` +
          `${message.onlyTo} only on ${message.to.label}`,
    ),
  );

  detailMetaEl.replaceChildren(meta);
  detailBodyEl.replaceChildren();
  detailBodyEl.hidden = true;
  renderSides(message);
}

/**
 * The commits each side has and the other does not, newest first, a row each that goes to it in the
 * graph - and, when a branch the comparison names is not drawn, the one click that draws it, since its
 * commits are what those rows are for going to.
 */
function renderSides(message: ComparisonMessage): void {
  const sides = document.createDocumentFragment();

  for (const [end, total, commits] of [
    [message.from, message.onlyFrom, message.onlyFromCommits],
    [message.to, message.onlyTo, message.onlyToCommits],
  ] as const) {
    if (total === 0) {
      continue;
    }

    const side = document.createElement('div');
    side.className = 'side';
    side.append(
      span(
        'side-heading',
        commits.length < total
          ? `Only on ${end.label} - the newest ${commits.length} of ${total.toLocaleString('en-US')}`
          : `Only on ${end.label}`,
      ),
    );

    for (const commit of commits) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'side-commit';
      row.title = `${commit.sha}\nGo to it in the graph`;
      row.append(
        span('side-sha', commit.sha.slice(0, 8)),
        span('side-subject', commit.subject),
        span('side-when', `${commit.author}, ${describeAge(commit.date)}`),
      );
      row.addEventListener('click', () => jump(commit.sha));
      side.append(row);
    }

    sides.append(side);
  }

  const undrawn = [message.from, message.to].filter((end) => !end.drawn);

  if (undrawn.length > 0) {
    const draw = document.createElement('button');
    draw.type = 'button';
    draw.className = 'side-draw';
    draw.textContent = undrawn.length === 2 ? 'Draw both' : `Draw ${undrawn[0]?.label ?? ''}`;
    draw.title = 'Tick in Branches & Tags, so the graph draws the commits these rows go to';
    draw.addEventListener('click', () =>
      post({ type: 'setRefsVisible', refNames: undrawn.map((end) => end.rev), visible: true }),
    );
    sides.append(draw);
  }

  detailCommitsEl.replaceChildren(sides);
  detailCommitsEl.hidden = !detailCommitsEl.hasChildNodes();
}

function renderDetails(details: CommitInfo): void {
  currentDetails = details;
  detailBodyEl.hidden = false;
  detailCommitsEl.replaceChildren();
  detailCommitsEl.hidden = true;
  detailsEl.hidden = false;
  splitter.hidden = false;
  applyDetailsHeight(detailsHeight);

  const meta = document.createDocumentFragment();

  const line = (label: string, ...values: HTMLElement[]): void => {
    const wrap = document.createElement('div');
    const value = document.createElement('span');
    value.className = 'meta-value';
    value.append(...values);
    wrap.append(span('meta-key', label), value);
    meta.append(wrap);
  };

  const sha = span('sha-full', details.sha);
  sha.title = 'Copy the full hash';
  sha.addEventListener('click', () => post({ type: 'copy', text: details.sha }));
  line('commit', sha);

  line(
    'author',
    span('person', details.author),
    span('email', `<${details.authorEmail}>`),
    span('when', formatDate(details.authorDate)),
  );

  // A rebase, a squash, or a merge made through a web UI leaves a committer who is not the author.
  // When they are the same person, saying it twice is noise.
  if (details.committer !== details.author) {
    line('committer', span('person', details.committer), span('when', formatDate(details.committerDate)));
  }

  if (details.parents.length > 0) {
    const parents = details.parents.map((parent) => {
      const chip = span('parent', parent.slice(0, 8));
      chip.title = `Go to ${parent}`;
      chip.addEventListener('click', () => jump(parent));
      return chip;
    });

    line(details.parents.length > 1 ? 'parents' : 'parent', ...parents);
  }

  detailMetaEl.replaceChildren(meta);

  // The first line is a title and the rest is prose; rendering them alike makes a long message a
  // wall of text.
  const lines = details.body.split('\n');
  const body = document.createDocumentFragment();
  body.append(linked('body-subject', lines[0] ?? ''));

  const rest = lines.slice(1).join('\n').trim();
  if (rest.length > 0) {
    body.append(linked('body-rest', rest));
  }

  detailBodyEl.replaceChildren(body);
}

/**
 * Text with its ticket ids marked, each one a link: clicked, or Enter or Space on it, it asks the host
 * to open it - by its text, since where tickets live is the host's to know. The key is taken as
 * handled, so the document's own keys - which move the selection - leave it alone.
 */
function linked(className: string, text: string): HTMLElement {
  const el = span(className, '');
  let at = 0;

  for (const [start, end] of findTickets(ticketPatterns, text)) {
    const id = text.slice(start, end);
    const ticket = span('ticket', id);
    const open = (): void => post({ type: 'openTicket', text: id });

    ticket.setAttribute('role', 'link');
    ticket.tabIndex = 0;
    ticket.title = `Open ${id}`;
    ticket.addEventListener('click', open);
    ticket.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });

    el.append(text.slice(at, start), ticket);
    at = end;
  }

  el.append(text.slice(at));
  return el;
}

/** What the view supplies, because none of it is this module's to know. */
let post: (message: WebviewMessage) => void = () => undefined;
let remember: () => void = () => undefined;
let redraw: () => void = () => undefined;
let jump: (sha: string) => void = () => undefined;

export function connect(options: {
  /** Where a message goes - the pane's own buttons ask the host for things. */
  post: (message: WebviewMessage) => void;
  /** Save the view state, so the pane comes back the height it was left. */
  remember: () => void;
  /** Ask for a frame: the canvas is sized to what the pane leaves, so a resize is a repaint. */
  redraw: () => void;
  /** Put a commit on screen and select it - which rows exist is the view's. */
  jump: (sha: string) => void;
}): void {
  post = options.post;
  remember = options.remember;
  redraw = options.redraw;
  jump = options.jump;
}

/** Show a commit. */
export function show(details: CommitInfo): void {
  renderDetails(details);
}

/**
 * The ticket patterns, as the host sent them - with the rest of what the view reads at the start, or
 * by themselves when `weft.ticketLinks` changed.
 *
 * A commit already on screen was marked with the patterns as they were, and the host does not send it
 * again: the pane holds it, so the pane draws it again.
 */
export function setTicketPatterns(patterns: readonly string[]): void {
  ticketPatterns = patterns;

  if (currentDetails !== null) {
    renderDetails(currentDetails);
  }
}

/** Show the working tree. */
export function showWorking(working: WorkingTree): void {
  renderWorking(working);
}

/** Show a comparison between two commits. */
export function showComparison(message: ComparisonMessage): void {
  renderComparison(message);
}

/** Whether the pane is on screen, which decides what Escape means. */
export function isOpen(): boolean {
  return !detailsEl.hidden;
}

export function close(): void {
  closeDetails();
}

/**
 * Put the pane back after it was closed, if it still holds something.
 *
 * Clicking the row that is already selected is how the pane is asked for again; without this that
 * one row is unclickable until another is picked.
 */
export function reopen(): void {
  if (detailsEl.hidden && currentDetails !== null) {
    detailsEl.hidden = false;
    splitter.hidden = false;
    applyDetailsHeight(detailsHeight);
  }
}

/** Empty and hide it, for a reload: whatever it held is about to stop existing. */
export function forget(): void {
  detailsEl.hidden = true;
  splitter.hidden = true;
  currentDetails = null;
}

/** For the view's saved state. */
export function height(): number {
  return detailsHeight;
}

export function restore(saved: number | undefined): void {
  if (saved !== undefined) {
    detailsHeight = saved;
  }
}
