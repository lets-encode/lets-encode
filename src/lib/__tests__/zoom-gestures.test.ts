import { test } from "node:test";
import assert from "node:assert/strict";

import { wheelZoomFactor } from "../zoom-gestures.ts";

test("wheelZoomFactor zooms in scrolling up, out scrolling down, by equal factors", () => {
  assert.ok(wheelZoomFactor(-10) > 1);
  assert.ok(wheelZoomFactor(10) < 1);
  assert.ok(Math.abs(wheelZoomFactor(-10) * wheelZoomFactor(10) - 1) < 1e-12);
});

test("wheelZoomFactor caps a mouse notch and reads line deltas as pixels", () => {
  assert.equal(wheelZoomFactor(100), wheelZoomFactor(50));
  assert.equal(wheelZoomFactor(3, 1), wheelZoomFactor(48));
});
