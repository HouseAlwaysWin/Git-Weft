/**
 * The statistics tab's page. It draws the summary the host sends and works nothing out for itself: which
 * commits count, who is who, and which bar a day belongs to were all decided on the other side.
 *
 * Names are the one thing on it that came from somebody else's keyboard, so they only ever go in as text.
 */

import type { StatsHostMessage, StatsWebviewMessage } from '../protocol.ts';
import type { StatsSummary } from '../stats/summary.ts';

interface VsCodeApi {
  postMessage(message: StatsWebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// Must be called exactly once - a second call throws.
const vscode = acquireVsCodeApi();

/** People listed before "Show all": enough to see who does the work, few enough to see it at a glance. */
const LISTED = 50;

/**
 * How long a walk runs before the charts from the one before it are dimmed. Most walks finish sooner, and
 * dimming on every one of them would flicker charts that are about to say the same thing again.
 */
const STALE_AFTER_MS = 250;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);

  if (found === null) {
    throw new Error(`the statistics page has no #${id}`);
  }

  return found as T;
}

const titleEl = element('stats-title');
const scopeEl = element('stats-scope');
const notesEl = element('stats-notes');
const stateEl = element('stats-state');
const messageEl = element('stats-message');
const openGraphEl = element<HTMLButtonElement>('stats-open-graph');
const chartsEl = element('stats-charts');
const peopleEl = element('stats-people');
const showAllEl = element<HTMLButtonElement>('stats-show-all');
const mergesEl = element<HTMLInputElement>('stats-merges');

/** What the charts are drawn from, or null while there is nothing to draw. */
let summary: StatsSummary | null = null;
let showingAll = false;
let staleTimer: ReturnType<typeof setTimeout> | null = null;

// Remembered by the page rather than the host, so the switch is where it was left when the tab is shown again.
mergesEl.checked = (vscode.getState() as { readonly includeMerges?: unknown } | undefined)?.includeMerges === true;

/** A count as a reader says it: "1 commit", "2,314 commits". */
function commits(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'commit' : 'commits'}`;
}

/** A merge count as a reader says it: "1 merge", "506 merges". */
function merges(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'merge' : 'merges'}`;
}

/** What a summary counts, and what it did with merges: "2,314 commits and 506 merges left out". */
function counted(drawn: StatsSummary): string {
  if (drawn.merges === 0) {
    return commits(drawn.total);
  }

  return drawn.includeMerges
    ? `${commits(drawn.total)}, ${merges(drawn.merges)} among them`
    : `${commits(drawn.total)} and ${merges(drawn.merges)} left out`;
}

function stopDimming(): void {
  if (staleTimer !== null) {
    clearTimeout(staleTimer);
    staleTimer = null;
  }

  chartsEl.classList.remove('stale');
}

/** Say something in place of the charts: why there are none, or what is happening instead. */
function say(message: string, offerGraph: boolean): void {
  stopDimming();
  summary = null;
  chartsEl.hidden = true;
  scopeEl.textContent = '';
  notesEl.replaceChildren();
  messageEl.textContent = message;
  openGraphEl.hidden = !offerGraph;
  stateEl.hidden = false;
}

/** What a reader has to know to read the numbers, most surprising first. */
function notesFor(drawn: StatsSummary): string[] {
  const notes: string[] = [];

  if (drawn.truncated) {
    notes.push(
      `The walk stopped at weft.maxCommits, ${drawn.limit.toLocaleString('en-US')} commits, so older history is not counted.`,
    );
  }

  if (drawn.dated) {
    notes.push(
      'The date filter compares committer dates, and these charts count author dates - so a rebased commit can sit outside the range it was walked for.',
    );
  }

  if (drawn.undated > 0) {
    notes.push(`${commits(drawn.undated)} had no date that could be read: counted, but on no bar.`);
  }

  if (drawn.overlapping) {
    notes.push('Someone is in more than one group, so the rows add up to more than the total.');
  }

  notes.push('Authors counts every branch back to the root commit, so its numbers can be larger.');
  return notes;
}

function drawPeople(drawn: StatsSummary): void {
  const busiest = drawn.people[0]?.commits ?? 0;
  const listed = showingAll ? drawn.people : drawn.people.slice(0, LISTED);

  peopleEl.replaceChildren(
    ...listed.map((person) => {
      const row = document.createElement('li');
      row.className = 'stats-person';

      const name = document.createElement('span');
      name.className = 'stats-name';
      name.textContent = person.name;
      name.title = person.spellings.join(', ');

      const track = document.createElement('span');
      track.className = 'stats-track';

      // The same colour as the person's band in the charts over time, or grey for someone without one.
      const band = drawn.series[person.series];
      const bar = document.createElement('span');
      bar.className = band === undefined ? 'stats-bar stats-unbanded' : 'stats-bar';
      bar.style.setProperty('--weft-stats-share', String(busiest === 0 ? 0 : person.commits / busiest));

      if (band !== undefined) {
        bar.style.setProperty('--weft-author-hue', String(band.hue));
      }

      track.append(bar);

      const count = document.createElement('span');
      count.className = 'stats-count';
      count.textContent = person.commits.toLocaleString('en-US');

      // Counted apart whichever way the charts count, since who merges is a question of its own.
      const merged = document.createElement('span');
      merged.className = 'stats-merged';
      merged.textContent = person.merges === 0 ? '' : merges(person.merges);

      row.append(name, track, count, merged);
      return row;
    }),
  );

  showAllEl.hidden = showingAll || drawn.people.length <= LISTED;
  showAllEl.textContent = `Show all ${drawn.people.length.toLocaleString('en-US')} people`;
}

function draw(next: StatsSummary): void {
  stopDimming();

  if (next.total === 0) {
    say(
      next.merges > 0
        ? `Every commit in what the graph walked is a merge, and merges are left out: ${next.scope}.`
        : `There are no commits in what the graph walked: ${next.scope}.`,
      false,
    );
    return;
  }

  summary = next;
  stateEl.hidden = true;
  chartsEl.hidden = false;
  scopeEl.textContent = `${counted(next)}, as the graph walked them: ${next.scope}`;
  notesEl.replaceChildren(
    ...notesFor(next).map((text) => {
      const note = document.createElement('li');
      note.textContent = text;
      return note;
    }),
  );

  drawPeople(next);
}

window.addEventListener('message', (event: MessageEvent<StatsHostMessage>) => {
  const message = event.data;

  switch (message.type) {
    case 'init':
      titleEl.textContent = `Statistics · ${message.repoName}`;
      break;

    case 'noGraph':
      say('No graph is open on this repository. These charts count what a graph walks, so they need one.', true);
      break;

    case 'walking':
      // The charts of the walk before stay up until this one is counted, dimmed once it is taking a while.
      if (summary === null) {
        say('Counting as the graph walks…', false);
      } else if (staleTimer === null) {
        staleTimer = setTimeout(() => chartsEl.classList.add('stale'), STALE_AFTER_MS);
      }

      break;

    case 'summary':
      draw(message.summary);
      break;

    case 'failed':
      say(`The graph's walk failed, so there is nothing to count. git said: ${message.message}`, false);
      break;
  }
});

openGraphEl.addEventListener('click', () => vscode.postMessage({ type: 'openGraph' }));

mergesEl.addEventListener('change', () => {
  vscode.setState({ includeMerges: mergesEl.checked });
  vscode.postMessage({ type: 'includeMerges', on: mergesEl.checked });
});

showAllEl.addEventListener('click', () => {
  showingAll = true;

  if (summary !== null) {
    drawPeople(summary);
  }
});

vscode.postMessage({ type: 'ready', includeMerges: mergesEl.checked });
