/**
 * The lanes the view has been handed, and finding the ones a frame draws.
 *
 * The layout streams lanes in pages, keyed by id, a page at a time; a frame wants the handful
 * crossing thirty rows of viewport. Those are different questions, and the view used to answer the
 * second by walking the answer to the first - every lane the layout had ever opened, on every
 * frame. Measured on a 78,000-commit history with 1,177 refs: 19,886 lanes, 0.35ms a frame to find
 * the sixty-odd being drawn, which is a fifth of the frame spent deciding not to draw something.
 *
 * A lane covers a range of rows, so this is interval overlap, and the cheap half of it is free:
 * lanes open as the walk goes down, so held in order of the row each one opens on, the first that
 * opens below the fold rules out every lane after it. What opened above the fold still has to be
 * asked whether it reaches down into view, which is one number each.
 *
 * Kept out of the view because a `document` is not needed to answer any of it, and because an
 * optimisation nobody can run against the old one is not one anybody should trust.
 */

import type { PathDelta } from './layout.ts';
import type { Point } from './model.ts';

/** One lane, and the two rows a frame asks about it. */
export interface LanePath {
  readonly color: number;
  readonly points: readonly Point[];
  /** The row it opens on, which never moves. */
  readonly from: number;
  /** The row it reaches so far, which grows as the walk hands over more of it. */
  readonly to: number;
  /**
   * How many lanes were opened before it.
   *
   * So that a frame draws them in the order they were opened, which decides which of two crossing
   * lanes is on top. Holding them in row order instead would have quietly restyled every crossing
   * in the graph, and a faster drawing of a different picture is not a faster drawing.
   */
  readonly opened: number;
}

interface Mutable extends LanePath {
  points: Point[];
  to: number;
}

export class LaneStore {
  /** By id, because a page names a lane rather than counting them. */
  private readonly byId = new Map<number, Mutable>();

  /** The same lanes in order of the row each opens on. */
  private readonly order: Mutable[] = [];

  /** Reused, so that a frame finding its lanes allocates nothing. */
  private readonly onScreen: Mutable[] = [];

  /** How many lanes have been opened. */
  get size(): number {
    return this.order.length;
  }

  /** Take a page's worth: new lanes, and more of the ones already open. */
  add(paths: readonly PathDelta[]): void {
    for (const path of paths) {
      const existing = this.byId.get(path.id);
      const last = path.points[path.points.length - 1];

      if (existing !== undefined) {
        existing.points.push(...path.points);
        existing.to = last?.y ?? existing.to;
        continue;
      }

      const lane: Mutable = {
        color: path.color,
        points: [...path.points],
        from: path.points[0]?.y ?? 0,
        to: last?.y ?? 0,
        opened: this.order.length,
      };

      this.byId.set(path.id, lane);
      this.insert(lane);
    }
  }

  clear(): void {
    this.byId.clear();
    this.order.length = 0;
    this.onScreen.length = 0;
  }

  /**
   * The lanes crossing these rows, in the order they were opened.
   *
   * The array is reused between calls: read it, draw it, do not keep it.
   */
  visible(topRow: number, bottomRow: number): readonly LanePath[] {
    const below = this.firstBelow(bottomRow);
    const on = this.onScreen;

    on.length = 0;

    for (let i = 0; i < below; i++) {
      const lane = this.order[i] as Mutable;

      // A lane of one point draws nothing; it has only just opened.
      if (lane.to >= topRow && lane.points.length > 1) {
        on.push(lane);
      }
    }

    return on.sort(byOpened);
  }

  /**
   * Put a lane where its row says, rather than where it arrived.
   *
   * Lanes open as the walk goes down, so the order they open in *is* row order - but a page hands
   * them over lane by lane rather than row by row, and within one page those are not the same
   * thing. Measured on a 78,000-commit history: 5,028 of 19,886 lanes arrive a little out of turn,
   * by up to 546 rows. A search that assumed otherwise would stop early and leave lanes undrawn,
   * and a graph missing lanes still looks like a graph.
   *
   * A step or two backwards, because out of turn is all it ever is.
   */
  private insert(lane: Mutable): void {
    let at = this.order.length;

    while (at > 0 && (this.order[at - 1] as Mutable).from > lane.from) {
      at--;
    }

    this.order.splice(at, 0, lane);
  }

  /** One past the last lane that could be on screen, by binary search over the row each opens on. */
  private firstBelow(row: number): number {
    let low = 0;
    let high = this.order.length;

    while (low < high) {
      const mid = (low + high) >> 1;

      if ((this.order[mid] as Mutable).from <= row) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    return low;
  }
}

const byOpened = (a: LanePath, b: LanePath): number => a.opened - b.opened;
