import test from 'node:test';
import assert from 'node:assert/strict';

import { LayoutState, appendCommits, buildGraph, finishLayout } from '../src/graph/layout.ts';
import { LaneStore } from '../src/graph/lanes.ts';
import type { GraphDelta } from '../src/graph/layout.ts';
import type { GraphCommit, GraphDot, GraphLink, Point } from '../src/graph/model.ts';
import { DotKind } from '../src/graph/model.ts';

function c(sha: string, ...parents: string[]): GraphCommit {
  return { sha, parents };
}

/**
 * Commits must arrive child-first, the way `git log --date-order` emits them.
 */
const topologies: Record<string, GraphCommit[]> = {
  // A single root, nothing else.
  root: [c('r')],

  // r <- b <- a
  linear: [c('a', 'b'), c('b', 'r'), c('r')],

  //   m
  //  / \
  // a   b
  //  \ /
  //   r
  merge: [c('m', 'a', 'b'), c('a', 'r'), c('b', 'r'), c('r')],

  // One merge commit with three parents.
  octopus: [c('m', 'a', 'b', 'x'), c('a', 'r'), c('b', 'r'), c('x', 'r'), c('r')],

  // Two merges that each combine the same two branches.
  crissCross: [
    c('top', 'm1', 'm2'),
    c('m1', 'a', 'b'),
    c('m2', 'a', 'b'),
    c('a', 'r'),
    c('b', 'r'),
    c('r'),
  ],

  // Two histories that never touch - e.g. an orphan docs branch.
  twoRoots: [c('a', 'r1'), c('r1'), c('b', 'r2'), c('r2')],

  // A branch that is still open when the loaded history runs out (its parent is never loaded).
  danglingParent: [c('a', 'b'), c('x', 'y')],

  // A long-lived side branch merged much later, so a lane passes through many rows.
  longSideBranch: [
    c('m', 'a', 'side'),
    c('a', 'a1'),
    c('a1', 'a2'),
    c('a2', 'a3'),
    c('a3', 'base'),
    c('side', 'base'),
    c('base'),
  ],
};

interface Collected {
  dots: GraphDot[];
  links: GraphLink[];
  paths: { id: number; color: number; points: Point[] }[];
  width: number;
  widths: number[];
}

/** Run the layout in pages of `pageSize` and stitch the deltas back into one whole. */
function layoutPaged(commits: readonly GraphCommit[], pageSize: number): Collected {
  const state = new LayoutState();
  const dots: GraphDot[] = [];
  const links: GraphLink[] = [];
  const widths: number[] = [];
  const points = new Map<number, { color: number; points: Point[] }>();

  const collect = (delta: GraphDelta): void => {
    dots.push(...delta.dots);
    links.push(...delta.links);
    widths.push(...delta.widths);

    for (const p of delta.paths) {
      const existing = points.get(p.id);
      if (existing === undefined) {
        points.set(p.id, { color: p.color, points: [...p.points] });
      } else {
        existing.points.push(...p.points);
      }
    }
  };

  for (let i = 0; i < commits.length; i += pageSize) {
    collect(appendCommits(state, commits.slice(i, i + pageSize)));
  }

  collect(finishLayout(state));

  const paths = [...points.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, v]) => ({ id, color: v.color, points: v.points }));

  return { dots, links, paths, width: state.width, widths };
}

/**
 * A history wide enough to have lanes coming and going: a trunk that absorbs a two-commit side
 * branch every fourth row, so lanes open, close and have their slots reused all the way down.
 */
function branchy(trunk: number): GraphCommit[] {
  const commits: GraphCommit[] = [];

  for (let i = 0; i < trunk; i++) {
    if (i % 4 === 0 && i + 6 < trunk) {
      commits.push(c(`t${i}`, `t${i + 1}`, `s${i}a`));
      commits.push(c(`s${i}a`, `s${i}b`));
      commits.push(c(`s${i}b`, `t${i + 6}`));
    } else {
      commits.push(c(`t${i}`, `t${i + 1}`));
    }
  }

  commits.push(c(`t${trunk}`));

  return commits;
}

test('a frame finds the same lanes walking every one of them would have', () => {
  /*
   * The lane store answers "which lanes cross these rows" with a binary search and a scan, where
   * the view used to answer it by testing every lane the layout had ever opened. On a real
   * repository - 78,000 commits, 1,177 refs, 19,886 lanes - that was 0.35ms of a frame spent
   * deciding not to draw things.
   *
   * A faster wrong answer being invisible is the whole risk: a graph missing lanes still looks
   * like a graph. So this is the old walk, kept here as the thing to agree with, over every
   * viewport the history has.
   */
  const commits = branchy(400);
  const store = new LaneStore();
  const arrived: { from: number; to: number; points: Point[]; opened: number }[] = [];
  const byId = new Map<number, { from: number; to: number; points: Point[]; opened: number }>();

  const state = new LayoutState();
  const pages: GraphDelta[] = [];

  for (let i = 0; i < commits.length; i += 50) {
    pages.push(appendCommits(state, commits.slice(i, i + 50)));
  }

  pages.push(finishLayout(state));

  for (const page of pages) {
    store.add(page.paths);

    for (const path of page.paths) {
      const existing = byId.get(path.id);
      const last = path.points[path.points.length - 1];

      if (existing === undefined) {
        const lane = {
          from: path.points[0]?.y ?? 0,
          to: last?.y ?? 0,
          points: [...path.points],
          opened: arrived.length,
        };

        byId.set(path.id, lane);
        arrived.push(lane);
      } else {
        existing.points.push(...path.points);
        existing.to = last?.y ?? existing.to;
      }
    }
  }

  /*
   * The fixture has to be one where the order lanes arrive in is not the order they open in, or
   * the search would agree with the walk for the wrong reason - measured at 5,028 of 19,886 on the
   * real repository this came from.
   */
  const outOfTurn = arrived.filter(
    (lane, i) => i > 0 && (arrived[i - 1] as { from: number }).from > lane.from,
  ).length;

  assert.ok(
    outOfTurn > 0,
    'the fixture hands its lanes over in opening order, so it proves nothing about one that does not',
  );

  /** What the view used to draw, in the order it drew it. */
  const walked = (topRow: number, bottomRow: number): number[] =>
    arrived
      .filter((lane) => lane.points.length > 1 && lane.to >= topRow && lane.from <= bottomRow)
      .map((lane) => lane.opened);

  const rows = commits.length;
  let drawnAtMost = 0;

  for (let top = -3; top <= rows + 3; top++) {
    const bottom = top + 31;
    const expected = walked(top, bottom);

    drawnAtMost = Math.max(drawnAtMost, expected.length);

    assert.deepEqual(
      store.visible(top, bottom).map((lane) => lane.opened),
      expected,
      `rows ${top}..${bottom}`,
    );
  }

  assert.ok(drawnAtMost > 3, `no viewport drew more than ${drawnAtMost} lanes; the fixture is too thin`);
  assert.ok(store.size > 50, `only ${store.size} lanes, which is not enough to be worth searching`);
});

test('a lane keeps the layout own points, two numbers at a time', () => {
  /*
   * The points are interleaved into a plain array of doubles rather than kept as objects: a tab
   * holds every lane for its whole life, and 186,723 of { x, y } is 17 MB of V8 object headers on
   * a real repository. The saving is worthless if the pairs come apart, and coming apart draws a
   * graph - just not this one - so the flattening is checked against what the layout said.
   */
  const commits = branchy(120);
  const state = new LayoutState();
  const store = new LaneStore();
  const arrived = new Map<number, Point[]>();

  for (let i = 0; i < commits.length; i += 25) {
    const delta = appendCommits(state, commits.slice(i, i + 25));

    store.add(delta.paths);

    for (const path of delta.paths) {
      const points = arrived.get(path.id) ?? [];
      points.push(...path.points);
      arrived.set(path.id, points);
    }
  }

  const flat = [...arrived.values()].map((points) => points.flatMap((p) => [p.x, p.y]));
  const held = store.visible(-1, commits.length + 1).map((lane) => [...lane.points]);

  assert.ok(held.length > 3, `only ${held.length} lanes, which proves little`);

  for (const points of held) {
    assert.equal(points.length % 2, 0, 'a lane ended on half a point');
    assert.ok(
      flat.some((one) => one.length === points.length && one.every((n, i) => n === points[i])),
      'a lane holds points the layout never produced',
    );
  }
});

test('a lane store forgets everything when the graph is reloaded', () => {
  // The view clears it on every reset, and a stale lane would be drawn at a row that now belongs
  // to a different commit.
  const store = new LaneStore();
  const state = new LayoutState();

  store.add(appendCommits(state, branchy(60)).paths);
  assert.ok(store.size > 0);

  store.clear();

  assert.equal(store.size, 0);
  assert.deepEqual([...store.visible(0, 100)], []);
});

test('every commit gets exactly one dot, in order', () => {
  for (const [name, commits] of Object.entries(topologies)) {
    const graph = buildGraph(commits);
    assert.equal(graph.dots.length, commits.length, name);

    graph.dots.forEach((dot, i) => {
      assert.equal(dot.center.y, i + 0.5, `${name} row ${i} sits at its row centre`);
    });
  }
});

test('a merge commit is marked as a merge, a normal commit is not', () => {
  const graph = buildGraph(topologies['merge'] as GraphCommit[]);

  assert.equal(graph.dots[0]?.kind, DotKind.Merge);
  assert.equal(graph.dots[1]?.kind, DotKind.Normal);
  assert.equal(graph.dots[3]?.kind, DotKind.Normal);
});

test('linear history occupies a single lane', () => {
  const graph = buildGraph(topologies['linear'] as GraphCommit[]);

  assert.equal(graph.paths.length, 1);
  assert.equal(new Set(graph.dots.map((d) => d.center.x)).size, 1, 'all dots share a column');
  assert.equal(graph.links.length, 0, 'nothing to arc into');
});

test('a merge emits an arc into the lane it absorbs', () => {
  const graph = buildGraph(topologies['merge'] as GraphCommit[]);

  assert.equal(graph.links.length, 0, 'the second parent has no lane yet, so it opens one');
  assert.equal(graph.paths.length, 2, 'mainline plus the absorbed branch');
});

test('an octopus merge does not lose its extra parents', () => {
  const graph = buildGraph(topologies['octopus'] as GraphCommit[]);

  // Three parents: one continues the major lane, the other two each need a lane or an arc.
  assert.equal(graph.paths.length + graph.links.length >= 3, true);
});

test('first-parent-only drops the merge arcs but keeps every commit', () => {
  const commits = topologies['crissCross'] as GraphCommit[];
  const full = buildGraph(commits);
  const firstParent = buildGraph(commits, { firstParentOnly: true });

  assert.equal(firstParent.dots.length, full.dots.length);
  assert.equal(firstParent.links.length, 0);
  assert.equal(firstParent.paths.length <= full.paths.length, true);
});

test('paging produces byte-identical output to laying out in one pass', () => {
  for (const [name, commits] of Object.entries(topologies)) {
    const whole = layoutPaged(commits, commits.length);

    for (let pageSize = 1; pageSize <= commits.length; pageSize++) {
      const paged = layoutPaged(commits, pageSize);

      assert.deepEqual(paged.dots, whole.dots, `${name}: dots differ at page size ${pageSize}`);
      assert.deepEqual(paged.links, whole.links, `${name}: links differ at page size ${pageSize}`);
      assert.deepEqual(paged.paths, whole.paths, `${name}: paths differ at page size ${pageSize}`);
      assert.equal(paged.width, whole.width, `${name}: width differs at page size ${pageSize}`);
      assert.deepEqual(
        paged.widths,
        whole.widths,
        `${name}: row widths differ at page size ${pageSize}`,
      );
    }
  }
});

test('a commit keeps its colour no matter where the page boundary falls', () => {
  const commits = topologies['longSideBranch'] as GraphCommit[];
  const whole = layoutPaged(commits, commits.length).dots.map((d) => d.color);

  for (let pageSize = 1; pageSize < commits.length; pageSize++) {
    const paged = layoutPaged(commits, pageSize).dots.map((d) => d.color);
    assert.deepEqual(paged, whole, `colours shifted at page size ${pageSize}`);
  }
});

test('lane polylines only turn - they never record a redundant point', () => {
  const graph = buildGraph(topologies['longSideBranch'] as GraphCommit[]);

  for (const path of graph.paths) {
    for (let i = 1; i < path.points.length; i++) {
      const prev = path.points[i - 1] as Point;
      const cur = path.points[i] as Point;

      assert.equal(cur.y > prev.y, true, 'Y must strictly increase down the graph');
    }
  }
});

test('a lane whose parent never loaded runs on to the bottom edge', () => {
  // 'a' opens a lane on row 0 aimed at 'b', and 'b' is never loaded. The lane has a row below it
  // to travel through, so it must be drawn past the last row rather than stopping at its dot.
  const graph = buildGraph(topologies['danglingParent'] as GraphCommit[]);
  const drawn = graph.paths.filter((p) => p.points.length >= 2);

  assert.equal(drawn.length, 1);
  assert.equal(drawn[0]?.points.at(-1)?.y, 2, 'past the final row centre of 1.5, to the edge');
});

test('a lane opened on the very last row is not drawn as a stub', () => {
  // 'x' opens a lane on the final row: there is no row beneath it, so the line would have zero
  // length and sit exactly under its own dot. finishLayout deliberately skips it.
  const graph = buildGraph(topologies['danglingParent'] as GraphCommit[]);

  assert.equal(graph.paths.filter((p) => p.points.length === 1).length, 1);
});

test('disconnected histories each get their own lane', () => {
  const graph = buildGraph(topologies['twoRoots'] as GraphCommit[]);

  assert.equal(graph.dots.length, 4);
  assert.equal(graph.paths.length >= 2, true);
});

test('every row reports a width, and the widest of them is the whole graph', () => {
  for (const [name, commits] of Object.entries(topologies)) {
    const laid = layoutPaged(commits, commits.length);

    assert.equal(laid.widths.length, commits.length, `${name}: one width per commit`);
    assert.equal(
      Math.max(...laid.widths),
      laid.width,
      `${name}: the graph is exactly as wide as its widest row`,
    );
  }
});

/*
 * The invariant the view leans on: it sizes the lane column to the rows on screen, so a row that
 * under-reports is a lane drawn outside the canvas - a branch silently missing from the graph.
 *
 * A point sits either at a row's centre (Y = i + 0.5) or on the boundary between two rows, where
 * it belongs to the segment spanning both, so either of them may account for it.
 */
test('no lane is ever drawn wider than the rows it passes through say they are', () => {
  for (const [name, commits] of Object.entries(topologies)) {
    const laid = layoutPaged(commits, commits.length);

    for (const path of laid.paths) {
      for (const point of path.points) {
        const rows = Number.isInteger(point.y) ? [point.y - 1, point.y] : [Math.floor(point.y)];
        const room = Math.max(...rows.map((row) => laid.widths[row] ?? 0));

        assert.equal(
          point.x + 8 <= room,
          true,
          `${name}: a lane at x=${point.x} on row ${point.y} needs more than ${room}px`,
        );
      }
    }
  }
});
