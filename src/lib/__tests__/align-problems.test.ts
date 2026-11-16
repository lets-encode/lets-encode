import { test } from "node:test";
import assert from "node:assert/strict";

import { alignmentProblems } from "../align/problems.ts";
import type { AlignedEncoding } from "../encoding-merge.ts";

const measures = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ label: String(i + 1) }));

/** An aligned encoding with nothing to report, changed by `over`. */
const aligned = (over: Record<string, unknown> = {}): AlignedEncoding =>
  ({
    summary: { kind: "complete" },
    layout: measures(4),
    file: measures(4),
    alignment: { ambiguous: [], conflicts: [null, null, null, null] },
    staffMap: [1, 2],
    staffCount: 2,
    merged: {
      movedEvents: 0,
      crossStaffRemoved: 0,
      neighbourRemoved: 0,
      droppedGroups: 0,
    },
    problems: [],
    ...over,
  }) as unknown as AlignedEncoding;

const all = new Set([0, 1, 2, 3]);

test("alignmentProblems reports nothing for a clean alignment", () => {
  assert.deepEqual(alignmentProblems(aligned(), all), []);
});

test("alignmentProblems reports nothing for another piece", () => {
  assert.deepEqual(
    alignmentProblems(
      aligned({
        summary: { kind: "different" },
        problems: [{ text: "x", measure: 0 }],
      }),
      new Set(),
    ),
    [],
  );
});

test("alignmentProblems lists uncertain, differing and unplaced measures with their layout measures", () => {
  const out = alignmentProblems(
    aligned({
      alignment: { ambiguous: [1, 2], conflicts: [null, null, null, {}] },
    }),
    new Set([0, 1, 2]),
  );
  assert.deepEqual(
    out.map((p) => [p.text, p.measures]),
    [
      ["Measures 2–3: placement not certain", [1, 2]],
      ["Measure 4: differs from the file", [3]],
      ["File measure 4: no place on the pages", []],
    ],
  );
});

test("alignmentProblems counts the staves, the moved marks, the cross-staff notes and the braces", () => {
  const out = alignmentProblems(
    aligned({
      staffMap: [1, 2, 3],
      merged: {
        movedEvents: 1,
        crossStaffRemoved: 1,
        neighbourRemoved: 1,
        droppedGroups: 2,
      },
      problems: [
        { text: "Staff 3 is named but missing", measure: null },
        { text: "Measure 2 names a missing element", measure: 1 },
      ],
    }),
    all,
  );
  assert.deepEqual(
    out.map((p) => [p.text, p.measures]),
    [
      ["The file has 3 staves, the pages 2", []],
      ["1 mark moved to the first staff from the file", []],
      ["2 cross-staff notes returned to their own staff", []],
      ["2 braces or brackets left out", []],
      ["Staff 3 is named but missing", []],
      ["Measure 2 names a missing element", [1]],
    ],
  );
});
