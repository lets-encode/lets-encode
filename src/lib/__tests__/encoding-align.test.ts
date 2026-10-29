import { test } from "node:test";
import assert from "node:assert/strict";

import {
  alignMeasures,
  alignmentRecord,
  pinsOf,
  encodingSize,
  labelRanges,
  mapStaves,
  readMeasures,
  summariseAlignment,
} from "../encoding-align.ts";
import { measure, skeleton, staff, upload } from "./encoding-fixture.ts";

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Per layout measure, the matched file measure index (null for none). */
const matched = (layoutMei: string, fileMei: string) =>
  alignMeasures(readMeasures(layoutMei), readMeasures(fileMei)).matches.map(
    (slot) => slot?.measure ?? null,
  );

test("readMeasures reads breaks, repeats, endings, pickups, rests and events", () => {
  const measures = readMeasures(
    upload(
      `<measure n="0" metcon="false">${staff(1)}</measure>` +
        `<measure n="1" right="rptboth">${staff(1)}${staff(2, true)}</measure>` +
        `<sb/><scoreDef meter.count="2" meter.unit="4"/>` +
        `<ending n="1"><measure n="2">${staff(1)}</measure></ending>` +
        `<pb/><measure n="3"><staff n="1"><layer n="1"><multiRest num="4"/></layer></staff></measure>`,
    ),
  );
  assert.deepEqual(
    measures.map((m) => [
      m.label,
      m.systemStart,
      m.pageStart,
      m.rptStart,
      m.rptEnd,
      m.ending,
      m.pickup,
      m.span,
    ]),
    [
      ["0", true, true, false, false, null, true, 1],
      ["1", false, false, false, true, null, false, 1],
      ["2", true, false, true, false, "1", false, 1],
      ["3", true, true, false, false, null, false, 4],
    ],
  );
  assert.deepEqual(
    [...measures[1].events],
    [
      [1, 1],
      [2, 0],
    ],
  );
  assert.deepEqual(measures[2].leading, [
    `<scoreDef meter.count="2" meter.unit="4"/>`,
  ]);
  assert.equal(measures[0].leading.length, 1, "the main scoreDef");
});

test("readMeasures reads a layout skeleton's systems and empty measures", () => {
  const measures = readMeasures(skeleton([2, 2], 2, { 1: { rptEnd: true } }));
  assert.deepEqual(
    measures.map((m) => [m.label, m.systemStart, m.rptEnd]),
    [
      ["1", true, false],
      ["2", false, true],
      ["3", true, false],
      ["4", false, false],
    ],
  );
  assert.deepEqual(
    [...measures[0].events],
    [
      [1, 0],
      [2, 0],
    ],
  );
});

test("a file with every measure is aligned one to one and complete", () => {
  const file = readMeasures(
    upload(
      range(1, 6)
        .map((n) => measure(n))
        .join(""),
    ),
  );
  const alignment = alignMeasures(readMeasures(skeleton([3, 3])), file);
  assert.deepEqual(
    alignment.matches.map((slot) => slot?.measure),
    range(0, 5),
  );
  assert.deepEqual(alignment.ambiguous, []);
  assert.deepEqual(summariseAlignment(file, alignment), {
    kind: "complete",
    filled: 6,
    empty: 0,
    unplaced: 0,
    conflicts: 0,
  });
});

test("a file that stops early fills the first measures, and the placement is ambiguous", () => {
  const file = readMeasures(
    upload(
      range(1, 3)
        .map((n) => measure(n))
        .join(""),
    ),
  );
  const alignment = alignMeasures(readMeasures(skeleton([5])), file);
  assert.deepEqual(
    alignment.matches.map((slot) => slot?.measure ?? null),
    [0, 1, 2, null, null],
  );
  assert.deepEqual(alignment.ambiguous, range(0, 4));
  assert.equal(summariseAlignment(file, alignment).kind, "partial");
});

test("labels with a jump place the missing measures", () => {
  assert.deepEqual(
    matched(
      skeleton([5]),
      upload(["1", "2", "5"].map((n) => measure(n)).join("")),
    ),
    [0, 1, null, null, 2],
  );
});

test("the file's system breaks place the missing measures", () => {
  // Layout systems 1–3 | 4–6; the file lacks measure 3.
  assert.deepEqual(
    matched(
      skeleton([3, 3]),
      upload(
        measure(1) +
          measure(2) +
          "<sb/>" +
          range(4, 6)
            .map((n) => measure(n))
            .join(""),
      ),
    ),
    [0, 1, null, 2, 3, 4],
  );
});

test("a repeat barline places the measures after it; the gap before it stays ambiguous", () => {
  const alignment = alignMeasures(
    readMeasures(skeleton([5], 1, { 3: { rptEnd: true } })),
    readMeasures(
      upload(
        measure(1) + measure(2) + measure(3, 1, ' right="rptend"') + measure(4),
      ),
    ),
  );
  assert.deepEqual(
    alignment.matches.map((slot) => slot?.measure ?? null),
    [0, 1, null, 2, 3],
  );
  assert.deepEqual(alignment.ambiguous, [0, 1, 2]);
});

test("a multi-measure rest takes as many layout measures as it stands for", () => {
  const file = readMeasures(
    upload(
      measure(1) +
        `<measure n="2"><staff n="1"><layer n="1"><multiRest num="3"/></layer></staff></measure>` +
        measure(5),
    ),
  );
  const alignment = alignMeasures(readMeasures(skeleton([5])), file);
  assert.deepEqual(alignment.matches, [
    { measure: 0, part: 0 },
    { measure: 1, part: 0 },
    { measure: 1, part: 1 },
    { measure: 1, part: 2 },
    { measure: 2, part: 0 },
  ]);
  assert.equal(summariseAlignment(file, alignment).kind, "complete");
});

test("a file with many more measures than the layout is a different version", () => {
  const file = readMeasures(
    upload(
      range(1, 12)
        .map((n) => measure(n))
        .join(""),
    ),
  );
  const alignment = alignMeasures(readMeasures(skeleton([4, 4])), file);
  assert.equal(alignment.unplaced.length, 4);
  assert.equal(summariseAlignment(file, alignment).kind, "different");
});

test("empty file measures count as empty", () => {
  const file = readMeasures(
    upload(
      measure(1) + `<measure n="2">${staff(1, true)}</measure>` + measure(3),
    ),
  );
  const summary = summariseAlignment(
    file,
    alignMeasures(readMeasures(skeleton([3])), file),
  );
  assert.deepEqual(
    [summary.kind, summary.filled, summary.empty],
    ["partial", 2, 1],
  );
});

test("mapStaves pairs by position without layout clefs", () => {
  assert.deepEqual(mapStaves(["G2", "F4"], 3), [1, 2]);
  assert.deepEqual(mapStaves(["G2", "G2", "F4"], 2), [1, 2, null]);
});

test("mapStaves pairs equal clefs in order and fills between them", () => {
  // A voice and piano file onto a layout with a violin above them.
  assert.deepEqual(
    mapStaves(["G2", "G2", "F4"], 4, ["G2", "G2", "G2", "F4"]),
    [1, 2, 4],
  );
  assert.deepEqual(mapStaves(["C3", "F4"], 2, ["G2", "F4"]), [1, 2]);
});

test("labelRanges joins neighbouring measures", () => {
  const layout = readMeasures(skeleton([6]));
  assert.equal(labelRanges(layout, [0, 1, 2, 4]), "1–3, 5");
  assert.equal(labelRanges(layout, []), "");
});

test("encodingSize counts measures, multi-measure rests included, and staves", () => {
  assert.deepEqual(
    encodingSize(
      upload(
        measure(1) +
          `<measure n="2"><staff n="1"><layer n="1"><multiRest num="3"/></layer></staff></measure>`,
      ),
    ),
    { measures: 4, staves: 1, withEmptyStaff: 0 },
  );
});

test("a pinned link holds, and the measures on either side align around it", () => {
  const layout = readMeasures(skeleton([5]));
  const file = readMeasures(
    upload(
      range(1, 3)
        .map((n) => measure(n))
        .join(""),
    ),
  );
  // Unpinned, the gap goes to the end; the pin puts file measure 3 last.
  const alignment = alignMeasures(layout, file, [
    { box: 4, slot: { measure: 2, part: 0 } },
  ]);
  assert.deepEqual(
    alignment.matches.map((slot) => slot?.measure ?? null),
    [0, 1, null, null, 2],
  );
  assert.deepEqual(alignment.ambiguous, [0, 1, 2, 3]);
});

test("a box pinned empty takes no file measure", () => {
  const layout = readMeasures(skeleton([3]));
  const file = readMeasures(
    upload(
      range(1, 3)
        .map((n) => measure(n))
        .join(""),
    ),
  );
  const alignment = alignMeasures(layout, file, [{ box: 0, slot: null }]);
  assert.deepEqual(
    alignment.matches.map((slot) => slot?.measure ?? null),
    [null, 0, 1],
  );
  assert.equal(alignment.unplaced.length, 1);
});

test("a pin out of order with an earlier one is ignored", () => {
  const layout = readMeasures(skeleton([3]));
  const file = readMeasures(
    upload(
      range(1, 3)
        .map((n) => measure(n))
        .join(""),
    ),
  );
  const alignment = alignMeasures(layout, file, [
    { box: 0, slot: { measure: 2, part: 0 } },
    { box: 2, slot: { measure: 0, part: 0 } },
  ]);
  assert.deepEqual(
    alignment.matches.map((slot) => slot?.measure ?? null),
    [2, null, null],
  );
});

test("the alignment record keeps the pins", () => {
  const layout = readMeasures(skeleton([2]));
  const file = readMeasures(upload(measure(1) + measure(2)));
  const pins = [
    { box: 0, slot: null },
    { box: 1, slot: { measure: 1, part: 0 } },
  ];
  const record = alignmentRecord(pins, alignMeasures(layout, file, pins), [1]);
  assert.deepEqual(pinsOf(record), pins);
  assert.deepEqual(JSON.parse(record).matches, [null, [1, 0]]);
  assert.deepEqual(pinsOf("not json"), []);
  assert.deepEqual(pinsOf(null), []);
});

test("encodingSize counts the measures that leave a staff empty", () => {
  assert.deepEqual(
    encodingSize(
      upload(
        `<measure n="1">${staff(1)}${staff(2)}</measure>` +
          `<measure n="2">${staff(1)}${staff(2, true)}</measure>` +
          `<measure n="3">${staff(1)}</measure>`,
        `<scoreDef><staffGrp><staffDef n="1" lines="5" clef.shape="G" clef.line="2"/><staffDef n="2" lines="5" clef.shape="F" clef.line="4"/></staffGrp></scoreDef>`,
      ),
    ),
    { measures: 3, staves: 2, withEmptyStaff: 2 },
  );
});
