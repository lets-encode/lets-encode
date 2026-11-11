import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sourceSummary,
  stepSummaries,
  uploadSummary,
  type SummarySource,
} from "../wizard/step-summaries.ts";
import { popupStyle } from "../wizard/popup-place.ts";

const base: SummarySource = {
  handle: "",
  title: "",
  license: "CC-BY-4.0",
  files: [],
  iiifManifestUrl: "",
  candidates: [],
  encodings: [],
  images: [],
  repo: null,
  source: { title: "", publisher: "", date: "" },
};

test("uploadSummary counts PDFs, other files, a manifest and pages", () => {
  assert.equal(uploadSummary(base), "no material");
  assert.equal(
    uploadSummary({
      ...base,
      files: [{ name: "a.PDF" }, { name: "b.png" }, { name: "c.jpg" }],
      iiifManifestUrl: " https://example.org/manifest ",
      candidates: [1, 2, 3],
    }),
    "1 PDF · 2 files · IIIF manifest · 3 pages",
  );
});

test("uploadSummary names encodings only when nothing else was uploaded", () => {
  assert.equal(uploadSummary({ ...base, encodings: [1] }), "1 encoding");
  assert.equal(uploadSummary({ ...base, encodings: [1, 2] }), "2 encodings");
  assert.equal(
    uploadSummary({ ...base, files: [{ name: "a.pdf" }], encodings: [1] }),
    "1 PDF",
  );
});

test("sourceSummary joins the title with publisher and date", () => {
  assert.equal(sourceSummary(base.source), "");
  assert.equal(
    sourceSummary({ title: "Lieder", publisher: "Schott", date: "1850" }),
    "Lieder · Schott, 1850",
  );
  assert.equal(
    sourceSummary({ title: "", publisher: "", date: "1850" }),
    "1850",
  );
});

test("stepSummaries reads each step's entries", () => {
  const s = stepSummaries(
    { ...base, handle: "songs", title: " ", repo: { name: "songs" } },
    "2 pieces",
  );
  assert.equal(s.name, "songs");
  assert.equal(s.license, "CC BY 4.0");
  assert.equal(s.pages, "no pages");
  assert.equal(s.pieces, "2 pieces");
  assert.equal(s.preparation, "");
  assert.equal(stepSummaries({ ...base, images: [1, 2] }, "").pages, "2 kept");
  assert.equal(stepSummaries(base, "").pages, "");
});

const anchor = { left: 100, right: 180, bottom: 400 };
const opts = {
  anchor,
  rail: null,
  width: 320,
  viewportWidth: 1200,
  viewportHeight: 480,
  besideRail: false,
};

test("popupStyle opens under the anchor, kept inside the window", () => {
  assert.equal(
    popupStyle({ ...opts, kind: "others" }),
    "left: 8px; top: 404px; width: 320px",
  );
  assert.equal(
    popupStyle({ ...opts, kind: "info" }),
    "left: 92px; top: 404px; width: 320px",
  );
  assert.equal(
    popupStyle({ ...opts, kind: "info", viewportWidth: 300 }),
    "left: 8px; top: 404px; width: 284px",
  );
});

test("popupStyle opens beside the compact rail, except the info popup", () => {
  const rail = { left: 0, right: 156, bottom: 480 };
  assert.equal(
    popupStyle({ ...opts, kind: "discard", rail, besideRail: true }),
    "left: 164px; bottom: 80px; width: 320px",
  );
  assert.equal(
    popupStyle({ ...opts, kind: "discard", besideRail: true }),
    "left: 188px; bottom: 80px; width: 320px",
  );
  assert.equal(
    popupStyle({ ...opts, kind: "info", rail, besideRail: true }),
    "left: 92px; top: 404px; width: 320px",
  );
});
