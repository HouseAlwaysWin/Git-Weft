/**
 * The geometry of a chart over time, worked out without a page: the top of the scale, the lines across,
 * which bars get a label along the bottom, how a stacked bar is cut so its pieces make it exactly, and how
 * a bar's room is shared out when the bands stand side by side instead.
 *
 * Numbers in and numbers out, so all of it is tested in Node rather than trusted from a look.
 */

import type { Unit } from './calendar.ts';
import { monthOf, tickLabel, yearOf } from './calendar.ts';

/** The least room between two labels along the bottom, in pixels: "Sep 2025" and a gap after it. */
export const TICK_GAP = 56;

/** How many months or weeks apart labels may be: steps a year divides into, so labels keep to the calendar. */
const MONTH_STEPS: readonly number[] = [1, 2, 3, 6, 12, 24, 60, 120];
const WEEK_STEPS: readonly number[] = [1, 2, 4, 8, 13, 26, 52, 104];

/**
 * The top of the scale: the tallest bar rounded up to a whole number of steps, each step the smallest 1, 2
 * or 5 times a power of ten of which five or fewer reach it. A scale ending at 1,170 is one more number to
 * read, and one ending at 2,000 leaves the top two-fifths of the chart empty; 1,500, in steps of 500, is
 * neither.
 */
export function ceiling(tallest: number): number {
  for (let power = 1; ; power *= 10) {
    for (const step of [power, 2 * power, 5 * power]) {
      const steps = Math.ceil(tallest / step);

      if (steps <= 5) {
        return Math.max(1, steps) * step;
      }
    }
  }
}

/** The lines across: from 0 to `top` in steps of 1, 2 or 5 times a power of ten, five steps or fewer. */
export function gridLines(top: number): number[] {
  for (let power = 1; ; power *= 10) {
    for (const step of [power, 2 * power, 5 * power]) {
      if (step > top) {
        return [0, top];
      }

      if (top % step === 0 && top / step <= 5) {
        return Array.from({ length: top / step + 1 }, (_, i) => i * step);
      }
    }
  }
}

/** One piece of a stacked bar, in pixels down from the top of the chart. */
export interface Piece {
  readonly y: number;
  readonly height: number;
}

/**
 * A stacked bar cut into its pieces, the first piece at the bottom.
 *
 * The cuts are rounded rather than the pieces. Rounding each piece on its own lets a stack of nine come
 * out several pixels taller or shorter than the bar it is meant to make, and a stack that does not reach
 * the height of the total beside it reads as numbers that do not add up. Rounding where each piece ends -
 * the running total - puts every edge on a whole pixel and the last one exactly where the bar ends.
 */
export function columns(counts: readonly number[], top: number, height: number): Piece[] {
  const scale = top > 0 ? height / top : 0;
  let below = 0;

  return counts.map((count) => {
    const lower = Math.round(below * scale);
    below += count;
    const upper = Math.round(below * scale);

    return { y: height - upper, height: upper - lower };
  });
}

/** One band's own bar inside the room a bar has: where it starts, across, and how wide it is. */
export interface Slot {
  readonly x: number;
  readonly width: number;
}

/**
 * Where each of `bands` bars goes across the room one bar would have had, side by side.
 *
 * Cut at rounded edges, the way a stacked bar is cut, so the slots tile the room exactly however awkwardly
 * it divides: nine people in twenty-five pixels are bars of three and two rather than nine of two with
 * four pixels of the month left over. None is thinner than a pixel, which is the one case - a room too
 * small for its bands - where they overlap rather than disappear.
 */
export function beside(bands: number, room: number): Slot[] {
  const slots: Slot[] = [];

  for (let band = 0; band < bands; band++) {
    const from = Math.round((room * band) / bands);
    const to = Math.round((room * (band + 1)) / bands);

    slots.push({ x: from, width: Math.max(1, to - from) });
  }

  return slots;
}

/**
 * How tall each count stands on a scale of `top`, each from the baseline rather than on the one below it.
 *
 * A count that is not zero is a pixel at least. Stacked, a piece that rounds to no height is still part of
 * a bar the reader can see; standing on its own it would be a month with no bar at all, which reads as
 * nobody rather than as somebody quiet.
 */
export function heights(counts: readonly number[], top: number, plot: number): number[] {
  const scale = top > 0 ? plot / top : 0;

  return counts.map((count) => (count === 0 || scale === 0 ? 0 : Math.max(1, Math.round(count * scale))));
}

/** A label along the bottom: the bar it sits under, and what it says. */
export interface Tick {
  readonly index: number;
  readonly label: string;
}

/**
 * Which bars carry a label along the bottom, and what each one says.
 *
 * As many as fit TICK_GAP apart at this width, a whole number of months or weeks apart - three months,
 * never every 2.7 bars - and for months on the months that step divides a year into, so quarters start in
 * January, April, July and October at every width that shows quarters. A label says its year when it is
 * the first, or the first of a new year.
 */
export function ticks(starts: readonly number[], unit: Unit, width: number): Tick[] {
  if (starts.length === 0 || width <= 0) {
    return [];
  }

  const room = width / starts.length;
  const steps = unit === 'month' ? MONTH_STEPS : WEEK_STEPS;
  const every = steps.find((step) => step * room >= TICK_GAP) ?? steps.at(-1) ?? 1;
  const labels: Tick[] = [];
  let year = 0;

  for (const [index, start] of starts.entries()) {
    const due = unit === 'month' ? (yearOf(start) * 12 + monthOf(start) - 1) % every === 0 : index % every === 0;

    if (due) {
      labels.push({ index, label: tickLabel(start, unit, yearOf(start) !== year) });
      year = yearOf(start);
    }
  }

  // A span too short to reach a month the step lands on still needs to say when it is.
  const first = starts[0];

  if (labels.length === 0 && first !== undefined) {
    labels.push({ index: 0, label: tickLabel(first, unit, true) });
  }

  return labels;
}
