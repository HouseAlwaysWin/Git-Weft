/**
 * The geometry of the charts over time: the top of the scale, the lines across, the labels along the
 * bottom, and stacked bars whose pieces make the bar to the pixel.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bucketStarts } from '../src/stats/calendar.ts';
import { TICK_GAP, beside, ceiling, columns, gridLines, heights, ticks } from '../src/stats/chart.ts';

test('the scale tops out a whole number of even steps above the tallest bar, five steps or fewer', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 7, 12, 20, 21, 310, 1170, 8263].map(ceiling),
    [1, 1, 2, 3, 8, 15, 20, 25, 400, 1500, 10_000],
  );

  // And the lines across end on it, in the steps it was counted in.
  for (let tallest = 0; tallest <= 3000; tallest += 7) {
    const top = ceiling(tallest);
    const lines = gridLines(top);

    assert.ok(top >= tallest, `${tallest} fits under ${top}`);
    assert.equal(lines.at(-1), top, `${tallest}: the last line is the top`);
    assert.ok(lines.length >= 2 && lines.length <= 6, `${tallest}: ${lines.join(', ')}`);
  }
});

test('the lines across go up in whole, even steps, five of them or fewer', () => {
  assert.deepEqual(gridLines(1), [0, 1]);
  assert.deepEqual(gridLines(5), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(gridLines(10), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(gridLines(20), [0, 5, 10, 15, 20]);
  assert.deepEqual(gridLines(500), [0, 100, 200, 300, 400, 500]);
  assert.deepEqual(gridLines(10_000), [0, 2000, 4000, 6000, 8000, 10_000]);
});

test('a stacked bar is cut where its running total falls, so its pieces make the bar to the pixel', () => {
  const stacks = [
    [1, 1, 1],
    [7, 3, 9, 1, 1, 13, 2, 5, 4],
    [1, 0, 2, 0, 0, 1],
    [0, 0, 0],
  ];

  for (const counts of stacks) {
    for (const height of [100, 137, 13]) {
      const total = counts.reduce((sum, count) => sum + count, 0);
      const top = ceiling(total);
      const pieces = columns(counts, top, height);

      assert.equal(
        pieces.reduce((sum, piece) => sum + piece.height, 0),
        Math.round((total / top) * height),
        `${counts.join('+')} at ${height}px`,
      );

      // Touching: every piece starts where the one beneath it ends, and the first stands on the baseline.
      let bottom = height;

      for (const piece of pieces) {
        assert.equal(piece.y + piece.height, bottom, `${counts.join('+')} at ${height}px`);
        bottom = piece.y;
      }
    }
  }
});

test('labels along the bottom keep apart at any width, a whole number of months or weeks apart', () => {
  const months = bucketStarts(20190915, 20260503, 'month');
  const weeks = bucketStarts(20250106, 20260222, 'week');

  for (const [starts, unit] of [
    [months, 'month'],
    [weeks, 'week'],
  ] as const) {
    for (const width of [300, 1400]) {
      const labels = ticks(starts, unit, width);
      const room = width / starts.length;

      assert.ok(labels.length >= 2, `${starts.length} ${unit}s at ${width}px have labels`);

      for (let i = 1; i < labels.length; i++) {
        const apart = ((labels[i]?.index ?? 0) - (labels[i - 1]?.index ?? 0)) * room;
        assert.ok(apart >= TICK_GAP, `${unit}s at ${width}px: two labels ${apart.toFixed(1)}px apart`);
      }
    }
  }
});

test('a label says its year when it is the first, or the first of a new year', () => {
  const labels = ticks(bucketStarts(20190915, 20260503, 'month'), 'month', 1400).map((tick) => tick.label);

  assert.match(labels[0] ?? '', / 20\d\d$/, 'the first');
  assert.ok(
    labels.filter((label) => label.startsWith('Jan')).every((label) => / 20\d\d$/.test(label)),
    `every January: ${labels.join(', ')}`,
  );
  assert.ok(
    labels.slice(1).filter((label) => !label.startsWith('Jan')).every((label) => !/\d{4}$/.test(label)),
    `nothing else: ${labels.join(', ')}`,
  );
});

test('one bar is labelled, a short span still says when it is, and no bars need nothing', () => {
  assert.deepEqual(ticks([20260302], 'week', 600), [{ index: 0, label: '2 Mar 2026' }]);
  // Two months so narrow that labels would be six months apart, and neither is a month six divides a year at.
  assert.deepEqual(ticks(bucketStarts(20260201, 20260331, 'month'), 'month', 30), [{ index: 0, label: 'Feb 2026' }]);
  assert.deepEqual(ticks([], 'month', 600), []);
  assert.deepEqual(columns([], 10, 100), []);
});

test('side by side, the bands share out the room one bar would have had, none of them thinner than a pixel', () => {
  for (const bands of [1, 2, 3, 5, 9]) {
    for (const room of [1, 2, 7, 25, 25.4, 100]) {
      const slots = beside(bands, room);
      const where = `${bands} bands in ${room}px`;

      assert.equal(slots.length, bands, where);

      for (const slot of slots) {
        assert.ok(slot.width >= 1, `${where}: a slot is ${slot.width}px`);
      }

      // Tiled: each starts where the one before ended, and the last ends where the single bar would have.
      if (room >= bands) {
        for (const [index, slot] of slots.entries()) {
          const before = slots[index - 1];

          assert.equal(slot.x, before === undefined ? 0 : before.x + before.width, `${where}: slot ${index}`);
        }

        const last = slots.at(-1);

        assert.equal((last?.x ?? 0) + (last?.width ?? 0), Math.round(room), `${where}: the slots fill the room`);
      }
    }
  }

  assert.deepEqual(beside(0, 20), []);
});

test('side by side, each count stands its own height, and a count that is not zero is a pixel at least', () => {
  assert.deepEqual(heights([0, 1, 2, 5], 10, 100), [0, 10, 20, 50]);

  // One commit against a scale of a thousand: a pixel, where a piece of a stack could round away to nothing.
  assert.deepEqual(heights([1, 0, 400], 1000, 190), [1, 0, 76]);
  assert.deepEqual(heights([3, 4], 0, 100), [0, 0]);
  assert.deepEqual(heights([], 10, 100), []);
});
