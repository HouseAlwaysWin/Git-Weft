/**
 * What the canvas is told to draw.
 *
 * The drawing used to live in the view, where the only way to check it was to look at it - and the
 * Browser pane throttles frames while it is hidden, so on the day this was extracted there was no
 * looking at it. Handing the painter a surface rather than letting it fetch a canvas makes the
 * question answerable here instead, and answerable more strictly: not "do the pixels look right"
 * but "which calls, in which order, with which arguments".
 *
 * That order is not decoration. Lanes, then arcs, then dots: an arc joins two lanes and has to be
 * seen over them, and a dot is what an arc leaves from, so a line drawn across it would read as
 * passing through.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LayoutState, appendCommits, finishLayout } from '../src/graph/layout.ts';
import type { GraphCommit } from '../src/graph/model.ts';
import type { Frame, Surface } from '../src/webview/graph.ts';
import { DOT_RADIUS, GraphPainter, LANE_COLORS } from '../src/webview/graph.ts';

/** Every call the painter makes, in order, as `name(args)`. */
interface Recorder extends Surface {
  readonly calls: string[];
}

function recorder(): Recorder {
  const calls: string[] = [];
  const show = (v: unknown): string =>
    typeof v === 'number'
      ? String(Number(v.toFixed(2)))
      : // The dash pattern arrives as an array, and flattening it would make `setLineDash([3, 3])`
        // and `setLineDash(3, 3)` the same line.
        Array.isArray(v)
        ? `[${v.join(', ')}]`
        : String(v);
  const note =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push(`${name}(${args.map(show).join(', ')})`);
    };

  return {
    calls,
    setTransform: note('setTransform'),
    clearRect: note('clearRect'),
    beginPath: note('beginPath'),
    moveTo: note('moveTo'),
    lineTo: note('lineTo'),
    quadraticCurveTo: note('quadraticCurveTo'),
    arc: note('arc'),
    stroke: note('stroke'),
    fill: note('fill'),
    setLineDash: note('setLineDash'),

    // The four that are set rather than called. Recorded on write, so the colour a stroke used is
    // in the transcript beside it.
    set strokeStyle(value: string) {
      calls.push(`strokeStyle = ${String(value)}`);
    },
    set fillStyle(value: string) {
      calls.push(`fillStyle = ${String(value)}`);
    },
    set lineWidth(value: number) {
      calls.push(`lineWidth = ${value}`);
    },
    set lineJoin(value: string) {
      calls.push(`lineJoin = ${String(value)}`);
    },
    set lineCap(value: string) {
      calls.push(`lineCap = ${String(value)}`);
    },
  } as Recorder;
}

const PALETTE = Array.from({ length: LANE_COLORS }, (_, i) => `#lane${i}`);

function frame(over: Partial<Frame> = {}): Frame {
  return {
    scrollTop: 0,
    height: 240,
    width: 100,
    scale: 1,
    rowHeight: 24,
    devicePixelRatio: 1,
    shift: 0,
    background: '#bg',
    palette: PALETTE,
    ...over,
  };
}

function c(sha: string, ...parents: string[]): GraphCommit {
  return { sha, parents };
}

/**
 * One of everything the canvas draws: lanes, a merge that opens a lane, a merge that joins one that
 * already exists - which is the only kind that makes an arc - and a HEAD to hang the working tree
 * from.
 *
 * The obvious shape does not do it. A branch merged once has no lane until the merge opens one, and
 * that arrives as an ordinary polyline; the arc is the *second* merge into a branch already on
 * screen. Measured before it was written down here: the obvious shape gives 0 arcs, this gives 1.
 */
const HISTORY: GraphCommit[] = [
  { sha: 'top', parents: ['m1', 'm2'], isHead: true },
  c('m1', 'a', 'b'),
  c('m2', 'a', 'b'),
  c('a', 'r'),
  c('b', 'r'),
  c('r'),
];

function painted(commits: readonly GraphCommit[], over: Partial<Frame> = {}): string[] {
  const state = new LayoutState();
  const painter = new GraphPainter();

  painter.add(appendCommits(state, commits));
  painter.add(finishLayout(state));

  const surface = recorder();

  painter.draw(surface, frame(over));

  return surface.calls;
}

test('the canvas is set up before anything is drawn on it', () => {
  const calls = painted(HISTORY, { devicePixelRatio: 2 });

  assert.deepEqual(calls.slice(0, 5), [
    'setTransform(2, 0, 0, 2, 0, 0)',
    'clearRect(0, 0, 100, 240)',
    'lineWidth = 1.5',
    'lineJoin = round',
    'lineCap = round',
  ]);
});

test('lanes, then arcs, then dots', () => {
  /*
   * An arc joins two lanes and has to be seen over them; a dot is what an arc leaves from, and a
   * line drawn across it would read as passing through. Getting this backwards still draws a graph,
   * which is exactly why it is worth pinning.
   */
  const calls = painted(HISTORY);

  const lastLine = calls.findLastIndex((call) => call.startsWith('lineTo('));
  const arc = calls.findIndex((call) => call.startsWith('quadraticCurveTo('));
  const firstDot = calls.findIndex((call) => call.startsWith('arc('));

  assert.ok(lastLine >= 0, 'no lane was drawn');
  assert.ok(arc >= 0, 'no merge arc was drawn');
  assert.ok(firstDot >= 0, 'no dot was drawn');

  assert.ok(lastLine < arc, 'an arc was drawn under the lanes it joins');
  assert.ok(arc < firstDot, 'a dot was drawn under the arc that leaves it');
});

test('a merge dot is hollow, and an ordinary one is not', () => {
  const calls = painted(HISTORY);
  const dots = calls.filter((call) => call.startsWith('arc(') || call.startsWith('fillStyle ='));

  assert.ok(
    dots.some((call, i) => call === 'fillStyle = #bg' && dots[i - 1]?.startsWith('arc(')),
    'the merge is filled with the panel background, which is what makes it read as a ring',
  );

  assert.ok(
    dots.some((call) => call.startsWith('fillStyle = #lane')),
    'and an ordinary commit is filled with its lane colour',
  );
});

test('every commit gets a dot of the right size', () => {
  const calls = painted(HISTORY);
  const radii = calls
    .filter((call) => call.startsWith('arc('))
    .map((call) => Number(call.split(', ')[2]));

  // One per commit, plus the wider ring HEAD is given.
  assert.ok(radii.length >= HISTORY.length, `only ${radii.length} dots for ${HISTORY.length} rows`);

  assert.ok(
    radii.every((r) => r === DOT_RADIUS || r === DOT_RADIUS + 1.5 || r === DOT_RADIUS + 4),
    `a dot was drawn at an unexpected radius: ${radii.join(', ')}`,
  );
});

test('what is off screen is not drawn', () => {
  /*
   * The whole reason the lanes are held in row order and the arcs are found by binary search. A
   * frame that draws all of a 78,000-commit history to show thirty rows of it still looks correct.
   */
  const long: GraphCommit[] = Array.from({ length: 400 }, (_, i) =>
    i === 399 ? c(`r${i}`) : c(`r${i}`, `r${i + 1}`),
  );

  const top = painted(long, { height: 240 }).length;
  const deep = painted(long, { height: 240, scrollTop: 24 * 200 }).length;
  const everything = painted(long, { height: 24 * 400 }).length;

  assert.ok(top < everything / 4, `a viewport of ten rows made ${top} calls against ${everything}`);
  assert.ok(
    Math.abs(top - deep) < top,
    'drawing the middle of a history should cost about what drawing the top does',
  );
});

test('the working tree is drawn only when there is a row for it', () => {
  const without = painted(HISTORY, { shift: 0 });
  const with_ = painted(HISTORY, { shift: 1 });

  assert.equal(
    without.filter((call) => call.startsWith('setLineDash([3')).length,
    0,
    'nothing hangs off HEAD when the working tree is clean',
  );

  assert.equal(
    with_.filter((call) => call.startsWith('setLineDash([3')).length,
    1,
    'and exactly one dashed stub when it is not',
  );

  assert.ok(
    with_[with_.length - 1] === 'setLineDash([])',
    'the dash is put back, or everything drawn after it is dashed too',
  );
});

test('the lanes are squeezed by the scale, and the dots are not', () => {
  /*
   * Scaling the context would squash the dots into ellipses and thin the strokes. So the scale is
   * applied to coordinates, and a dot keeps its radius wherever its centre lands.
   */
  const full = painted(HISTORY, { scale: 1 });
  const tight = painted(HISTORY, { scale: 0.5 });

  const centres = (calls: string[]): number[] =>
    calls.filter((call) => call.startsWith('arc(')).map((call) => Number(call.slice(4).split(', ')[0]));

  const radii = (calls: string[]): number[] =>
    calls.filter((call) => call.startsWith('arc(')).map((call) => Number(call.split(', ')[2]));

  assert.deepEqual(radii(tight), radii(full), 'a squeezed graph must not have squashed dots');

  assert.deepEqual(
    centres(tight),
    centres(full).map((x) => Number((x / 2).toFixed(2))),
    'but the centres move with the lanes they sit on',
  );
});

test('a painter that has been cleared draws nothing', () => {
  const state = new LayoutState();
  const painter = new GraphPainter();

  painter.add(appendCommits(state, HISTORY));
  painter.add(finishLayout(state));
  painter.clear();

  const surface = recorder();

  painter.draw(surface, frame());

  assert.equal(painter.headDot, null);
  assert.deepEqual(painter.rowWidths, []);
  assert.equal(
    surface.calls.filter((call) => call.startsWith('arc(') || call.startsWith('lineTo(')).length,
    0,
    'a reload starts from an empty canvas, not from the last history',
  );
});
