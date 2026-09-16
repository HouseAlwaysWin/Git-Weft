/**
 * The statistics tab's page. It draws the summary the host sends and works nothing out for itself: which
 * commits count, who is who, and which bar a day belongs to were all decided on the other side.
 *
 * Names are the one thing on it that came from somebody else's keyboard, so they only ever go in as text.
 */

import type { StatsHostMessage, StatsWebviewMessage } from '../protocol.ts';
import { describeBucket } from '../stats/calendar.ts';
import { beside, ceiling, columns, gridLines, heights, ticks } from '../stats/chart.ts';
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

/** The namespace `createElementNS` has to be given for an element to be SVG at all. */
const SVG = 'http://www.w3.org/2000/svg';

/** Room around a chart's bars: the scale on the left, and the labels along the bottom. */
const MARGIN = { top: 8, right: 12, bottom: 22, left: 48 } as const;

/** How tall each chart over time is, in pixels. The stacked one has more in it to tell apart. */
const TOTAL_HEIGHT = 160;
const STACKED_HEIGHT = 220;

function element<T extends Element = HTMLElement>(id: string): T {
  const found: Element | null = document.getElementById(id);

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
const timeEl = element('stats-time');
const totalTitleEl = element('stats-total-heading');
const totalChartEl = element<SVGSVGElement>('stats-total');
const stackedTitleEl = element('stats-stacked-heading');
const stackedChartEl = element<SVGSVGElement>('stats-stacked');
const legendEl = element('stats-legend');
const mergesEl = element<HTMLInputElement>('stats-merges');
const excludedSwitchEl = element('stats-excluded-switch');
const excludedEl = element<HTMLInputElement>('stats-excluded');
const sideBySideEl = element<HTMLInputElement>('stats-side-by-side');

/** What the charts are drawn from, or null while there is nothing to draw. */
let summary: StatsSummary | null = null;
let showingAll = false;
let staleTimer: ReturnType<typeof setTimeout> | null = null;

// Remembered by the page rather than the host, so the switches are where they were left when the tab is shown again.
const remembered = vscode.getState() as
  | { readonly includeMerges?: unknown; readonly includeExcluded?: unknown; readonly sideBySide?: unknown }
  | undefined;
mergesEl.checked = remembered?.includeMerges === true;
excludedEl.checked = remembered?.includeExcluded === true;
sideBySideEl.checked = remembered?.sideBySide === true;

/** A count as a reader says it: "1 commit", "2,314 commits". */
function commits(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'commit' : 'commits'}`;
}

/** A merge count as a reader says it: "1 merge", "506 merges". */
function merges(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'merge' : 'merges'}`;
}

/** An excluded-commit count as a reader says it: "1 excluded commit", "741 excluded commits". */
function excludedCommits(count: number): string {
  return `${count.toLocaleString('en-US')} excluded ${count === 1 ? 'commit' : 'commits'}`;
}

/**
 * What a summary counts, and what it did with merges and excluded commits: "2,314 commits and 506 merges
 * left out", or "2,820 commits, 506 merges among them, 741 excluded commits left out".
 */
function counted(drawn: StatsSummary): string {
  const among: string[] = [];
  const leftOut: string[] = [];

  if (drawn.merges > 0) {
    (drawn.includeMerges ? among : leftOut).push(merges(drawn.merges));
  }

  if (drawn.excluded > 0) {
    (drawn.includeExcluded ? among : leftOut).push(excludedCommits(drawn.excluded));
  }

  const inside = among.length === 0 ? '' : `, ${among.join(' and ')} among them`;
  const joiner = inside === '' && leftOut.length === 1 ? ' and' : ',';
  const outside = leftOut.length === 0 ? '' : `${joiner} ${leftOut.join(' and ')} left out`;

  return `${commits(drawn.total)}${inside}${outside}`;
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

  if (drawn.excludeRules.length > 0) {
    const rules = drawn.excludeRules.map((rule) => JSON.stringify(rule)).join(', ');
    notes.push(`Excluded commits are the ones whose subject matches weft.statistics.excludeMessages: ${rules}.`);
  }

  if (drawn.unreadableRules.length > 0) {
    const rules = drawn.unreadableRules.map((rule) => JSON.stringify(rule)).join(', ');
    notes.push(`weft.statistics.excludeMessages: ${rules} could not be used, and left nothing out.`);
  }

  notes.push('Authors counts every branch back to the root commit, so its numbers can be larger.');
  return notes;
}

function drawPeople(drawn: StatsSummary): void {
  const busiest = drawn.people[0]?.commits ?? 0;
  const listed = showingAll ? drawn.people : drawn.people.slice(0, LISTED);
  const excluding = drawn.excludeRules.length > 0;

  peopleEl.classList.toggle('stats-excluding', excluding);

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

      // Only while there is a rule to exclude by: otherwise the column would be empty on every row.
      if (excluding) {
        const excluded = document.createElement('span');
        excluded.className = 'stats-excluded-count';
        excluded.textContent = person.excluded === 0 ? '' : `${person.excluded.toLocaleString('en-US')} excluded`;
        row.append(excluded);
      }

      return row;
    }),
  );

  showAllEl.hidden = showingAll || drawn.people.length <= LISTED;
  showAllEl.textContent = `Show all ${drawn.people.length.toLocaleString('en-US')} people`;
}

/** One band of a chart over time: whose commits, in which colour, and how many in each bar. */
interface Band {
  /** Whose commits, for the words on hover; null when the band is every commit. */
  readonly name: string | null;
  /** A person's hue, or null for a band in a colour of the chart's own. */
  readonly hue: number | null;
  readonly className: string;
  readonly counts: readonly number[];
}

/** An SVG element and its attributes. Geometry goes in attributes, which the content security policy allows. */
function shape<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Readonly<Record<string, string | number>>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, name);

  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, String(value));
  }

  return node;
}

/**
 * A bar chart over time: the scale and its lines, a bar for every week or month cut into `bands`, and a
 * label under each bar `ticks` picks. Every piece says in words who and when it is, on hover.
 */
function drawOverTime(
  target: SVGSVGElement,
  drawn: StatsSummary,
  bands: readonly Band[],
  height: number,
  label: string,
  sideBySide = false,
): void {
  const width = Math.max(240, Math.floor(timeEl.clientWidth));
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const room = plotWidth / Math.max(1, drawn.buckets.length);
  const gap = room >= 4 ? 1 : 0;
  const barWidth = Math.max(1, room - gap);
  const slots = beside(bands.length, barWidth);

  /*
   * The tallest bar the chart will hold, which is what the scale has to reach: a bar's whole stack, or its
   * busiest single band when they stand side by side. Bars that each start from the baseline, drawn against
   * the total's scale, would leave everybody at a fraction of the height they have the room for.
   */
  const tallest = drawn.buckets.reduce((most, _start, bar) => {
    const counts = bands.map((band) => band.counts[bar] ?? 0);

    return Math.max(most, sideBySide ? Math.max(0, ...counts) : counts.reduce((sum, count) => sum + count, 0));
  }, 0);
  const top = ceiling(tallest);
  const parts: SVGElement[] = [];

  for (const value of gridLines(top)) {
    const y = MARGIN.top + plotHeight - Math.round((value / top) * plotHeight) + 0.5;
    parts.push(shape('line', { class: 'stats-grid', x1: MARGIN.left, x2: width - MARGIN.right, y1: y, y2: y }));

    const scale = shape('text', { class: 'stats-axis', x: MARGIN.left - 6, y: y + 4, 'text-anchor': 'end' });
    scale.textContent = value.toLocaleString('en-US');
    parts.push(scale);
  }

  for (const [bar, start] of drawn.buckets.entries()) {
    const when = describeBucket(start, drawn.unit);
    const counts = bands.map((band) => band.counts[bar] ?? 0);
    const left = MARGIN.left + bar * room + gap / 2;

    /*
     * Stacked, the bar is cut into pieces that add up to it, each sitting on the one below. Side by side,
     * each band is a bar of its own from the baseline in its own slice of the room the one bar would have
     * had - the comparison a stack cannot give, since only its bottom band has a line to be read from.
     */
    const placed = sideBySide
      ? heights(counts, top, plotHeight).map((tall, index) => ({
          x: left + (slots[index]?.x ?? 0),
          width: slots[index]?.width ?? 1,
          y: plotHeight - tall,
          height: tall,
        }))
      : columns(counts, top, plotHeight).map((piece) => ({ x: left, width: barWidth, y: piece.y, height: piece.height }));

    for (const [index, where] of placed.entries()) {
      const band = bands[index];

      // Drawn even when it rounds to no height at all, so every commit in the bar is one of its pieces.
      if (band === undefined || (counts[index] ?? 0) === 0) {
        continue;
      }

      const rect = shape('rect', {
        class: band.className,
        x: where.x.toFixed(2),
        y: MARGIN.top + where.y,
        width: where.width.toFixed(2),
        height: where.height,
      });

      if (band.hue !== null) {
        rect.style.setProperty('--weft-author-hue', String(band.hue));
      }

      const count = commits(counts[index] ?? 0);
      const title = shape('title', {});
      title.textContent =
        band.name === null ? `${when.charAt(0).toUpperCase()}${when.slice(1)}: ${count}` : `${band.name}, ${when}: ${count}`;
      rect.append(title);
      parts.push(rect);
    }
  }

  for (const tick of ticks(drawn.buckets, drawn.unit, plotWidth)) {
    const text = shape('text', { class: 'stats-axis', x: (MARGIN.left + tick.index * room).toFixed(1), y: height - 6 });
    text.textContent = tick.label;
    parts.push(text);
  }

  target.setAttribute('width', String(width));
  target.setAttribute('height', String(height));
  target.setAttribute('viewBox', `0 0 ${width} ${height}`);
  target.setAttribute('aria-label', label);
  target.replaceChildren(...parts);
}

/**
 * Commits per week or month, and the busiest people stacked over the same bars in the colours the people
 * chart gives them - with everyone else in one grey band on top, and a legend in the order of the bands.
 */
function drawTime(drawn: StatsSummary): void {
  // Commits with no readable date are counted and on no bar, so a walk of only those has no time to draw.
  timeEl.hidden = drawn.buckets.length === 0;

  if (timeEl.hidden) {
    return;
  }

  const unit = drawn.unit;
  const span = `${describeBucket(drawn.buckets[0] ?? 0, unit)} to ${describeBucket(drawn.buckets.at(-1) ?? 0, unit)}`;
  const tallest = drawn.perBucket.reduce((most, count) => Math.max(most, count), 0);

  totalTitleEl.textContent = `Commits per ${unit}`;
  stackedTitleEl.textContent = `Each person, per ${unit}`;

  drawOverTime(
    totalChartEl,
    drawn,
    [{ name: null, hue: null, className: 'stats-piece stats-total', counts: drawn.perBucket }],
    TOTAL_HEIGHT,
    `Commits per ${unit}, from ${span}: at most ${commits(tallest)} in one ${unit}.`,
  );

  const bands: Band[] = drawn.series.map((band) => ({
    name: drawn.people[band.person]?.name ?? '',
    hue: band.hue,
    className: 'stats-piece',
    counts: band.counts,
  }));

  if (drawn.others.some((count) => count > 0)) {
    bands.push({ name: 'Everyone else', hue: null, className: 'stats-piece stats-unbanded', counts: drawn.others });
  }

  drawOverTime(
    stackedChartEl,
    drawn,
    bands,
    STACKED_HEIGHT,
    `Commits per ${unit} from ${span}, ${sideBySideEl.checked ? 'side by side' : 'stacked'}, for ${bands
      .map((band) => band.name)
      .join(', ')}.`,
    sideBySideEl.checked,
  );

  legendEl.replaceChildren(
    ...bands.map((band) => {
      const item = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = band.hue === null ? 'stats-swatch stats-unbanded' : 'stats-swatch';

      if (band.hue !== null) {
        swatch.style.setProperty('--weft-author-hue', String(band.hue));
      }

      const name = document.createElement('span');
      name.textContent = band.name ?? '';
      item.append(swatch, name);
      return item;
    }),
  );
}

function draw(next: StatsSummary): void {
  stopDimming();

  // Only with a rule to exclude by, since without one there is nothing for it to put back.
  excludedSwitchEl.hidden = next.excludeRules.length === 0;

  if (next.total === 0) {
    const reasons = [
      ...(next.merges > 0 && !next.includeMerges ? ['a merge'] : []),
      ...(next.excluded > 0 && !next.includeExcluded ? ['excluded by weft.statistics.excludeMessages'] : []),
    ];

    say(
      reasons.length > 0
        ? `Every commit in what the graph walked is ${reasons.join(' or ')}, and left out: ${next.scope}.`
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
  drawTime(next);
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

/** Every switch, remembered together by the page. */
function remember(): void {
  vscode.setState({
    includeMerges: mergesEl.checked,
    includeExcluded: excludedEl.checked,
    sideBySide: sideBySideEl.checked,
  });
}

mergesEl.addEventListener('change', () => {
  remember();
  vscode.postMessage({ type: 'includeMerges', on: mergesEl.checked });
});

excludedEl.addEventListener('change', () => {
  remember();
  vscode.postMessage({ type: 'includeExcluded', on: excludedEl.checked });
});

// Nothing for the host to answer: which way the bands go is drawn from the summary the page already has.
sideBySideEl.addEventListener('change', () => {
  remember();

  if (summary !== null) {
    drawTime(summary);
  }
});

showAllEl.addEventListener('click', () => {
  showingAll = true;

  if (summary !== null) {
    drawPeople(summary);
  }
});

/**
 * Drawn again when the tab changes width, at most once a frame. The charts are laid out in pixels, and a
 * chart laid out for the width it used to be is either cut off or a strip down one side.
 */
let drawnWidth = 0;
let frame = 0;

new ResizeObserver((entries) => {
  const width = Math.round(entries[0]?.contentRect.width ?? 0);

  if (width === drawnWidth) {
    return;
  }

  drawnWidth = width;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    if (summary !== null) {
      drawTime(summary);
    }
  });
}).observe(chartsEl);

vscode.postMessage({ type: 'ready', includeMerges: mergesEl.checked, includeExcluded: excludedEl.checked });
