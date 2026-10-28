import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SCORE_DEF,
  type PageModel,
  type ScoreDefModel,
} from "../mei-facsimile.ts";
import type { LayoutInstruments } from "../omr-layout.ts";
import type { OmrRecord } from "../omr-record.ts";
import { namedPieceStaves, pageChecks } from "../omr-page-checks.ts";
import { staffPlan } from "../instrument-naming.ts";

const G = "<clef><sign>G</sign><line>2</line></clef>";
const F = "<clef><sign>F</sign><line>4</line></clef>";
const staffXml = (clef: string, key = "") =>
  `<score-partwise version="3.1"><part id="P1"><measure><attributes><divisions>1</divisions>${key}${clef}</attributes><note><rest measure="yes"/><duration>4</duration></note></measure></part></score-partwise>`;

const named: LayoutInstruments = {
  instruments: [
    {
      id: "a",
      name: "Flöte",
      abbr: "",
      grand: false,
      parts: [],
      staves: [{ id: "a-1", parts: [] }],
    },
    {
      id: "b",
      name: "Horn",
      abbr: "",
      grand: false,
      parts: [],
      staves: [{ id: "b-1", parts: [] }],
    },
    {
      id: "v",
      name: "Violine",
      abbr: "",
      grand: false,
      parts: [{ name: "I" }, { name: "II" }],
      staves: [
        { id: "v-1", parts: [0, 1] },
        { id: "v-2", parts: [0] },
        { id: "v-3", parts: [1] },
      ],
    },
  ],
  groups: [],
  fixed: true,
};
/** The pages' staff plan, and a score definition of its staves. */
function planned(pages: PageModel[]) {
  const plan = staffPlan(named, pages);
  const scoreDef: ScoreDefModel = {
    ...DEFAULT_SCORE_DEF,
    staves: plan.staves.map((s) => ({
      ...DEFAULT_SCORE_DEF.staves[0],
      id: s.id,
    })),
  };
  return { plan, scoreDef };
}

/** Pages of one system each: per page, each staff box's staff id and what it reads. */
function piece(systems: { staff?: string; xml: string }[][]) {
  const box = (i: number) => ({
    ulx: 100,
    uly: 100 + i * 100,
    lrx: 900,
    lry: 160 + i * 100,
  });
  const pages: PageModel[] = systems.map((staves, p) => ({
    image: `img/${p + 1}.jpg`,
    width: 1000,
    height: 1000,
    zones: [
      {
        box: { ulx: 100, uly: 80, lrx: 900, lry: 180 + staves.length * 100 },
        label: String(p + 1),
        pb: true,
        sb: false,
        mdiv: false,
      },
    ],
    staves: staves.map((s, i) => ({ ...box(i), staff: s.staff })),
  }));
  const record: OmrRecord = {
    cropMargin: 0.9,
    staffPipeline: { name: "mzk-staff", version: "1" },
    ocr: { engine: "tesseract.js", version: "7.0.0", language: "deu+eng" },
    pages: systems.map((staves, p) => ({
      n: p + 1,
      image: `img/${p + 1}.jpg`,
      staves: staves.map((s, i) => ({
        zone: `staff-zone-${p + 1}-${i + 1}`,
        box: box(i),
        label: "",
        musicxml: s.xml,
        error: "",
      })),
    })),
    clefs: [],
  };
  return { pages, record };
}

const key2 = "<key><fifths>2</fifths></key>";

test("each staff box is placed on its instrument's score staff in the system; a box without a name on none", () => {
  const { pages, record } = piece([
    [
      { staff: "a-1", xml: staffXml(G) },
      { staff: "v-1", xml: staffXml(G) },
    ],
    [
      { staff: "v-2", xml: staffXml(G) },
      { xml: staffXml(G) },
      { staff: "b-1", xml: staffXml(G) },
    ],
  ]);
  // Flöte, Horn and one violin staff: Violine prints one staff at once.
  const { plan, scoreDef } = planned(pages);
  assert.deepEqual(
    plan.staves.map((s) => s.id),
    ["a-staff1", "b-staff1", "v-staff1"],
  );
  const staves = namedPieceStaves({ pages, scoreDef }, record, plan);
  assert.deepEqual(
    staves.map((p) => p.assigned),
    [[[1, 3]], [[3, 0, 2]]],
  );
});

test("pageChecks: an instrument first named, one on other staves, a clef and a key change", () => {
  const { pages, record } = piece([
    [
      { staff: "a-1", xml: staffXml(G) },
      { staff: "v-1", xml: staffXml(G) },
    ],
    [
      { staff: "a-1", xml: staffXml(G) },
      { staff: "b-1", xml: staffXml(G) },
      { staff: "v-2", xml: staffXml(G) },
      { staff: "v-3", xml: staffXml(G) },
    ],
    [
      { staff: "a-1", xml: staffXml(F, key2) },
      { staff: "b-1", xml: staffXml(G, key2) },
      { staff: "v-2", xml: staffXml(G, key2) },
      { staff: "v-3", xml: staffXml(G, key2) },
    ],
  ]);
  const { plan, scoreDef } = planned(pages);
  const parsed = { pages, scoreDef };
  assert.deepEqual(
    pageChecks(parsed, namedPieceStaves(parsed, record, plan), plan),
    [
      [],
      [
        "First named on this page: Horn.",
        "On other staves than in the system before: Violine.",
      ],
      ["The clef changes on Flöte.", "The key changes in system 1."],
    ],
  );
});

test("a staff read in another clef than the score definition's is read in the definition's", () => {
  const e4 =
    "<note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration></note>";
  const withNote = (clef: string) =>
    staffXml(clef).replace("<note>", `${e4}<note>`);
  const { pages, record } = piece([
    [
      { staff: "a-1", xml: withNote(G) },
      { staff: "v-1", xml: withNote(G) },
    ],
    [
      { staff: "a-1", xml: withNote(G) },
      { staff: "v-1", xml: withNote(G) },
    ],
  ]);
  // The definition has the shared violin staff in the bass clef.
  const { plan, scoreDef } = planned(pages);
  const def: ScoreDefModel = {
    ...scoreDef,
    staves: scoreDef.staves.map((s) =>
      s.id === "v-staff1" ? { ...s, clefShape: "F", clefLine: 4 } : s,
    ),
  };
  const parsed = { pages, scoreDef: def };
  const staves = namedPieceStaves(parsed, record, plan);
  for (const p of staves) {
    assert.match(p.transcriptions[0][1]!, /<sign>F<\/sign>/);
    // E4 on the bottom line of a treble staff is G2 in the bass clef.
    assert.match(p.transcriptions[0][1]!, /<step>G<\/step><octave>2<\/octave>/);
    assert.match(p.transcriptions[0][0]!, /<step>E<\/step><octave>4<\/octave>/);
  }
  assert.deepEqual(pageChecks(parsed, staves, plan), [[], []]);
});
