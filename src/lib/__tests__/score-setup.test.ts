import { test } from "node:test";
import assert from "node:assert/strict";

import type { PageModel, StaffModel } from "../mei-facsimile.ts";
import type { OmrRecord } from "../omr-record.ts";
import { withClefCorrections } from "../setup/clef-corrections.ts";
import { newGroup, plainStaff } from "../setup/score-def.ts";
import {
  groupText,
  symbolGlyph,
  symbolName,
  transText,
} from "../setup/setup-text.ts";
import { firstMeasureOf, staffMatch } from "../setup/source-frame.ts";

const staff = (change: Partial<StaffModel> = {}): StaffModel => ({
  ...plainStaff(),
  ...change,
});
const piano = [
  staff({ label: "Pianoforte" }),
  staff({ clefShape: "F", clefLine: 4 }),
];

test("a new staff is a five-line treble staff without a label, a fresh object each time", () => {
  assert.deepEqual(plainStaff(), {
    clefShape: "G",
    clefLine: 2,
    clefDis: "",
    clefDisPlace: "",
    lines: 5,
    notationType: "",
    label: "",
  });
  assert.notEqual(plainStaff(), plainStaff());
});

test("a new brace guesses one instrument from the staves; a bracket never does", () => {
  assert.deepEqual(newGroup(1, 2, "brace", piano), {
    start: 1,
    end: 2,
    symbol: "brace",
    label: "",
    barThru: true,
    oneInstrument: true,
  });
  assert.equal(newGroup(1, 2, "bracket", piano).oneInstrument, false);
});

test("a group's symbol and line as text", () => {
  assert.equal(symbolName("brace"), "Brace");
  assert.equal(symbolName("bracket"), "Bracket");
  assert.equal(symbolGlyph("brace"), "brace");
  assert.equal(symbolGlyph("line"), "bracket");
  assert.equal(
    groupText({ ...newGroup(1, 2, "brace", piano), label: " Pianoforte " }),
    "staves 1–2 · Pianoforte · one instrument · barlines through",
  );
  assert.equal(
    groupText({
      ...newGroup(3, 5, "bracket", piano),
      barThru: false,
    }),
    "staves 3–5 · barlines per staff",
  );
  assert.equal(
    groupText({ ...newGroup(1, 2, "brace", piano), oneInstrument: false }),
    "staves 1–2 · separate staves · barlines through",
  );
});

test("a staff's transposition as text names the pitch unless it is an octave of C", () => {
  assert.equal(transText(staff()), "");
  assert.equal(
    transText(staff({ transDiat: -1, transSemi: -2 })),
    "in B♭, sounds a major 2nd lower",
  );
  assert.equal(
    transText(staff({ transDiat: -7, transSemi: -12 })),
    "sounds an octave lower",
  );
});

const zone = (box: PageModel["zones"][number]["box"]) => ({
  box,
  label: "1",
  pb: true,
  sb: false,
  mdiv: false,
});
const page = (change: Partial<PageModel> = {}): PageModel => ({
  image: "img/1.jpg",
  width: 1000,
  height: 1400,
  zones: [],
  ...change,
});

test("the first measure is the first zone of the first page with zones", () => {
  assert.equal(firstMeasureOf(undefined), null);
  assert.equal(firstMeasureOf([page()]), null);
  const box = { ulx: 200, uly: 100, lrx: 400, lry: 300 };
  const fm = firstMeasureOf([page(), page({ zones: [zone(box)] })]);
  assert.deepEqual(fm, {
    page: 1,
    box,
    staves: null,
    anchor: { uly: 100, lry: 300 },
    // A tenth of the zone's height above and below, half that past its end.
    frame: { ulx: 0, uly: 80, lrx: 410, lry: 320 },
  });
});

test("with staff boxes the first measure's staves run over its system, framed within the page", () => {
  const box = { ulx: 200, uly: 20, lrx: 990, lry: 400 };
  const fm = firstMeasureOf([
    page({
      zones: [zone(box)],
      staves: [
        { ulx: 100, uly: 30, lrx: 990, lry: 80 },
        { ulx: 100, uly: 200, lrx: 990, lry: 250 },
      ],
    }),
  ]);
  assert.ok(fm);
  assert.equal(fm.staves?.length, 2);
  assert.deepEqual(fm.anchor, { uly: 30, lry: 250 });
  // 0.6 of a staff box's height (50): 30 above and below, 15 past the end,
  // clipped to the page.
  assert.deepEqual(fm.frame, { ulx: 0, uly: 0, lrx: 1000, lry: 280 });
});

test("the source's staves meet the preview's: first and last with as many, else at the preview's spacing", () => {
  const box = { ulx: 200, uly: 100, lrx: 400, lry: 300 };
  const zoneOnly = firstMeasureOf([page({ zones: [zone(box)] })])!;
  const span = { top: 50, lastTop: 150, bottom: 170, count: 3 };
  assert.deepEqual(staffMatch(span, zoneOnly), {
    uly: 100,
    lry: 300,
    top: 50,
    bottom: 170,
  });
  const twoStaves = firstMeasureOf([
    page({
      zones: [zone(box)],
      staves: [
        { ulx: 100, uly: 100, lrx: 990, lry: 140 },
        { ulx: 100, uly: 200, lrx: 990, lry: 240 },
      ],
    }),
  ])!;
  assert.deepEqual(staffMatch({ ...span, count: 2 }, twoStaves), {
    uly: 100,
    lry: 240,
    top: 50,
    bottom: 170,
  });
  // Three preview staves 50 apart against two source staves 100 apart: half
  // of the source's 140 from the first staff.
  assert.deepEqual(staffMatch(span, twoStaves), {
    uly: 100,
    lry: 240,
    top: 50,
    bottom: 120,
  });
});

const staffXml = (sign: string, line: number) =>
  `<score-partwise version="3.1"><part id="P1"><measure><attributes><divisions>1</divisions><clef><sign>${sign}</sign><line>${line}</line></clef></attributes><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration></note><note><rest measure="yes"/><duration>4</duration></note></measure></part></score-partwise>`;
/** One page with one system of one staff, which the record reads in `sign` on `line`. */
function piece(sign: string, line: number) {
  const box = { ulx: 100, uly: 100, lrx: 900, lry: 160 };
  const pages: PageModel[] = [
    page({
      zones: [zone({ ulx: 100, uly: 80, lrx: 900, lry: 180 })],
      staves: [box],
    }),
  ];
  const record: OmrRecord = {
    cropMargin: 0.9,
    staffPipeline: { name: "mzk-staff", version: "1" },
    ocr: { engine: "tesseract.js", version: "7.0.0", language: "deu+eng" },
    pages: [
      {
        n: 1,
        image: "img/1.jpg",
        staves: [
          {
            zone: "staff-zone-1-1",
            box,
            label: "",
            musicxml: staffXml(sign, line),
            error: "",
          },
        ],
      },
    ],
    clefs: [{ staff: 1, read: "C3", corrected: "G2" }],
  };
  return { pages, record };
}

test("a staff submitted in another clef than the one read is recorded as a correction", () => {
  const { pages, record } = piece("F", 4);
  assert.deepEqual(withClefCorrections({ pages }, [staff()], record).clefs, [
    { staff: 1, read: "F4", corrected: "G2" },
  ]);
  assert.deepEqual(
    withClefCorrections(
      { pages },
      [staff({ clefShape: "F", clefLine: 4 })],
      record,
    ).clefs,
    [],
  );
  // Without the score's pages nothing is read, so nothing is corrected.
  assert.deepEqual(withClefCorrections(undefined, [staff()], record).clefs, []);
});
