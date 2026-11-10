import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOUBLE_TAP_MS,
  HISTORY_LIMIT,
  isDoubleTap,
  primaryOf,
  recorded,
  toggled,
  travelled,
} from "../box-editor-rules.ts";

const page = { width: 1000, height: 800 };

test("travelled measures the pointer's travel in screen pixels", () => {
  // The page is drawn at half its size: 6 page pixels are 3 on screen.
  assert.equal(travelled(6, 0, page, 500, 3), true);
  assert.equal(travelled(4, 0, page, 500, 3), false);
  assert.equal(travelled(3, 4, page, 1000, 5), true);
});

test("isDoubleTap needs the same thing within DOUBLE_TAP_MS", () => {
  const a = {};
  const b = {};
  assert.equal(isDoubleTap(null, a, 100), false);
  assert.equal(
    isDoubleTap({ on: a, t: 100 }, a, 100 + DOUBLE_TAP_MS - 1),
    true,
  );
  assert.equal(isDoubleTap({ on: a, t: 100 }, a, 100 + DOUBLE_TAP_MS), false);
  assert.equal(isDoubleTap({ on: a, t: 100 }, b, 150), false);
});

test("toggled adds an item at the end or takes it out", () => {
  assert.deepEqual(toggled([1, 2], 3), [1, 2, 3]);
  assert.deepEqual(toggled([1, 2, 3], 2), [1, 3]);
  assert.deepEqual(toggled([], 1), [1]);
});

test("primaryOf keeps the current box where the list holds it", () => {
  assert.equal(primaryOf([1, 2, 3], 2), 2);
  assert.equal(primaryOf([1, 2, 3], 5), 3);
  assert.equal(primaryOf([1, 2, 3], undefined), 3);
  assert.equal(primaryOf([], 1), undefined);
});

test("recorded appends a changed state and drops the redo steps", () => {
  assert.deepEqual(recorded([], -1, { a: 1 }), {
    history: [{ a: 1 }],
    index: 0,
  });
  assert.deepEqual(recorded([{ a: 1 }, { a: 2 }, { a: 3 }], 1, { a: 4 }), {
    history: [{ a: 1 }, { a: 2 }, { a: 4 }],
    index: 2,
  });
});

test("recorded keeps at most the limit, dropping the oldest", () => {
  const full = Array.from({ length: HISTORY_LIMIT }, (_, i) => i);
  const next = recorded(full, HISTORY_LIMIT - 1, HISTORY_LIMIT);
  assert.equal(next.history.length, HISTORY_LIMIT);
  assert.equal(next.history[0], 1);
  assert.equal(next.history[HISTORY_LIMIT - 1], HISTORY_LIMIT);
  assert.equal(next.index, HISTORY_LIMIT - 1);
});
