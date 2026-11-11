import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_INSTRUMENTS } from "../instrument-naming.ts";
import type { OmrPipeline } from "../omr-client.ts";
import type { EditPage, Layer } from "../zones/edit-pages.ts";
import {
  draftInput,
  layoutSubmission,
  pagesWord,
  rawLayoutRecord,
  submitBlock,
  type SubmitState,
  type ZoneWork,
} from "../zones/submission.ts";

const model = { name: "layout", version: "1" } as unknown as OmrPipeline;

const page = (
  image: string,
  boxes: { zones?: number; staves?: number } = {},
): EditPage => ({
  image,
  width: 100,
  height: 100,
  url: "",
  failed: false,
  zones: Array.from({ length: boxes.zones ?? 0 }, (_, i) => ({
    box: { ulx: i * 10, uly: 0, lrx: i * 10 + 10, lry: 10 },
    override: null,
    label: String(i + 1),
    sb: false,
    sbOverride: null,
    mdiv: false,
    pickup: false,
  })),
  staves: Array.from({ length: boxes.staves ?? 0 }, (_, i) => ({
    box: { ulx: 0, uly: i * 20, lrx: 100, lry: i * 20 + 10 },
  })),
  grandstaves: [],
  regions: [],
});

const seen = (s: Partial<Record<Layer, number[]>> = {}) => ({
  staves: [],
  grandstaves: [],
  measures: [],
  ...s,
});

const state = (s: Partial<SubmitState>): SubmitState => ({
  omr: false,
  naming: false,
  pages: [],
  seen: seen(),
  named: NO_INSTRUMENTS,
  shownNamed: NO_INSTRUMENTS,
  namingModels: [],
  runningKey: null,
  recognisedKey: "",
  staffKey: "",
  ...s,
});

const work = (w: Partial<ZoneWork>): ZoneWork => ({
  omr: false,
  naming: false,
  pages: [],
  rawLayouts: {},
  named: NO_INSTRUMENTS,
  recognition: null,
  ...w,
});

test("pagesWord names one page or several", () => {
  assert.equal(pagesWord([0]), "page 1");
  assert.equal(pagesWord([1, 3]), "pages 2, 4");
});

test("a measure correction waits for every page with measures to be shown", () => {
  const pages = [page("a", { zones: 2 }), page("b"), page("c", { zones: 1 })];
  assert.equal(
    submitBlock(state({ pages, seen: seen({ measures: [0] }) })),
    "Show page 3 before submitting.",
  );
  assert.equal(
    submitBlock(state({ pages, seen: seen({ measures: [0, 2] }) })),
    null,
  );
});

test("a layout task waits for each step's pages, then for measures on every page with staves", () => {
  const pages = [page("a", { staves: 2 }), page("b", { staves: 1, zones: 1 })];
  assert.equal(
    submitBlock(state({ omr: true, pages, seen: seen({ staves: [0] }) })),
    "Show page 2 in step 1 before submitting.",
  );
  assert.equal(
    submitBlock(
      state({
        omr: true,
        pages,
        seen: seen({ staves: [0, 1], measures: [1] }),
      }),
    ),
    "Page 1 has staff boxes but no measures.",
  );
});

test("a naming layout task waits for the other systems and the transcription", () => {
  const pages = [page("a", { staves: 1, zones: 1 })];
  const all = seen({ staves: [0], measures: [0] });
  const base = { omr: true, naming: true, pages, seen: all };
  assert.equal(
    submitBlock(state(base)),
    "Name the other systems in step 4 (Other systems) before submitting.",
  );
  const fixed = { ...NO_INSTRUMENTS, fixed: true };
  assert.equal(
    submitBlock(state({ ...base, named: fixed, runningKey: "k" })),
    "Wait until the staves are transcribed before submitting.",
  );
  assert.equal(
    submitBlock(state({ ...base, named: fixed, staffKey: "k" })),
    "The staves have to be transcribed before submitting.",
  );
  assert.equal(
    submitBlock(
      state({ ...base, named: fixed, staffKey: "k", recognisedKey: "k" }),
    ),
    null,
  );
});

test("the raw layouts go with the work only when every page was detected", () => {
  const pages = [page("a"), page("b")];
  const layout = { annotations: [] };
  assert.equal(
    rawLayoutRecord(work({ pages, rawLayouts: { 0: layout } }), model),
    undefined,
  );
  const record = rawLayoutRecord(
    work({ pages, rawLayouts: { 0: layout, 1: layout } }),
    model,
  );
  assert.deepEqual(
    record?.pages.map((p) => p.image),
    ["a", "b"],
  );
});

test("the draft of a measure correction holds only its pages; a layout task's marks the layout", () => {
  const pages = [page("a", { zones: 1, staves: 1 })];
  const plain = draftInput(work({ pages }), model);
  assert.deepEqual(Object.keys(plain), ["pages"]);
  assert.equal(plain.pages?.[0].staves, undefined);
  const layout = draftInput(work({ omr: true, pages }), model);
  assert.deepEqual(Object.keys(layout), ["pages", "layout", "rawLayout"]);
  assert.equal(layout.layout, true);
  assert.equal(layout.pages?.[0].staves?.length, 1);
  const named = draftInput(work({ omr: true, naming: true, pages }), model);
  assert.deepEqual(named.instruments, NO_INSTRUMENTS);
});

test("a layout task's submission carries its pages and raw layout", () => {
  const pages = [page("a", { zones: 1 })];
  const input = layoutSubmission(work({ omr: true, pages }), model);
  assert.deepEqual(Object.keys(input), ["pages", "layout"]);
  assert.equal(input.layout, undefined);
});
