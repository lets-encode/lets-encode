import { test } from "node:test";
import assert from "node:assert/strict";

import { systemRegion } from "../system-thumbs.ts";

const page = { width: 1000, height: 1400 };

test("systemRegion adds a margin and cuts three times as wide as tall", () => {
  const region = systemRegion(page, { ulx: 100, uly: 200, lrx: 900, lry: 300 });
  assert.deepEqual(region, { ulx: 100, uly: 188, lrx: 472, lry: 312 });
});

test("systemRegion stays inside the page", () => {
  const region = systemRegion(page, { ulx: 800, uly: 0, lrx: 1000, lry: 400 });
  assert.deepEqual(region, { ulx: 800, uly: 0, lrx: 1000, lry: 448 });
});

test("systemRegion is null for an empty box", () => {
  assert.equal(
    systemRegion(page, { ulx: 100, uly: 200, lrx: 900, lry: 200 }),
    null,
  );
});
