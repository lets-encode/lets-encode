import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assignUnit,
  doubleNamings,
  mergeInstrument,
  firstNamingSystem,
  inSystem,
  instrumentScoreDef,
  NO_INSTRUMENTS,
  nameUnit,
  namingProblem,
  namingUnits,
  openingTranscriptions,
  parseParts,
  partsLabel,
  printedName,
  pruneInstruments,
  splitLabel,
  suggestFirstSystem,
  suggestFromList,
  unitBoxes,
  unitName,
  unprintedStaves,
  type NamingPage,
  type NamingUnit,
} from "../instrument-naming.ts";
import type { LayoutInstruments } from "../omr-layout.ts";
import type { OmrRecord } from "../omr-record.ts";
import {
  buildFacsimileMei,
  DEFAULT_SCORE_DEF,
  parseScoreDef,
} from "../mei-facsimile.ts";

const box = (uly: number, lry: number) => ({ ulx: 100, uly, lrx: 900, lry });
const zone = (uly: number, lry: number, pb: boolean, sb: boolean) => ({
  box: { ulx: 100, uly, lrx: 500, lry },
  label: "1",
  pb,
  sb,
  mdiv: false,
});

// Two systems: Fl. I, Fl. II, then a grand staff (piano).
const pageA = (): NamingPage => ({
  zones: [zone(100, 500, true, false), zone(600, 1000, false, true)],
  staves: [
    box(110, 170),
    box(210, 270),
    box(310, 370),
    box(410, 470),
    box(610, 670),
    box(710, 770),
    box(810, 870),
    box(910, 970),
  ],
  grandstaves: [
    { ulx: 90, uly: 300, lrx: 900, lry: 480 },
    { ulx: 90, uly: 800, lrx: 900, lry: 980 },
  ],
});
// A later page: one system, the flutes on one staff, then the piano.
const pageB = (): NamingPage => ({
  zones: [zone(100, 400, true, false)],
  staves: [box(110, 170), box(210, 270), box(310, 370)],
  grandstaves: [{ ulx: 90, uly: 200, lrx: 900, lry: 380 }],
});

/** Give a unit's boxes the staff ids a naming returned. */
const apply = (
  pages: NamingPage[],
  unit: NamingUnit,
  staves: (string | undefined)[],
) =>
  unit.staves.forEach(
    (i, k) => (pages[unit.page].staves![i].staff = staves[k]),
  );

/** Name units in order. */
function nameAll(
  pages: NamingPage[],
  names: [number, string, string][],
  start: LayoutInstruments = NO_INSTRUMENTS,
): LayoutInstruments {
  const units = namingUnits(pages);
  let named = start;
  for (const [u, n, parts] of names) {
    const r = nameUnit(named, units[u].staves.length, n, parts);
    named = r.named;
    apply(pages, units[u], r.staves);
  }
  return named;
}

test("namingUnits and unitBoxes: single staves and a grand staff per system", () => {
  const pages = [pageA()];
  assert.deepEqual(
    namingUnits(pages).map((u) => [u.system, u.staves]),
    [
      [0, [0]],
      [0, [1]],
      [0, [2, 3]],
      [1, [4]],
      [1, [5]],
      [1, [6, 7]],
    ],
  );
  assert.deepEqual(unitBoxes(pages)[0][0][2], {
    ulx: 100,
    uly: 310,
    lrx: 900,
    lry: 470,
  });
  assert.deepEqual(firstNamingSystem([{ zones: [] }, ...pages]), {
    page: 1,
    system: 0,
  });
  assert.equal(firstNamingSystem([{ zones: [] }]), null);
});

test("parseParts, splitLabel and printedName", () => {
  assert.deepEqual(parseParts("1.2.3"), ["1", "2", "3"]);
  assert.deepEqual(parseParts("I.II"), ["I", "II"]);
  assert.deepEqual(parseParts("Vc., Cb."), ["Vc.", "Cb."]);
  assert.deepEqual(parseParts(" "), []);
  assert.deepEqual(splitLabel("Flauto II"), { name: "Flauto", parts: "II" });
  assert.deepEqual(splitLabel("Pos. 1.2.3"), { name: "Pos", parts: "1.2.3" });
  assert.deepEqual(splitLabel("Klavier"), { name: "Klavier", parts: "" });
  assert.equal(printedName("Mezzosopran.) Klavier."), "Klavier");
  assert.equal(printedName("Singstimme. (Bariton oder"), "Singstimme");
});

test("nameUnit: the same name with different parts is one instrument with parts", () => {
  let r = nameUnit(NO_INSTRUMENTS, 1, "Flauto", "I");
  assert.deepEqual(r.staves, ["i1-1"]);
  r = nameUnit(r.named, 1, "Flauto", "II");
  assert.deepEqual(r.staves, ["i1-2"]);
  r = nameUnit(r.named, 2, "Pianoforte");
  assert.deepEqual(r.staves, ["i2-1", "i2-2"]);
  const [flute, piano] = r.named.instruments;
  assert.deepEqual(flute.parts, [{ name: "I" }, { name: "II" }]);
  assert.deepEqual(flute.staves, [
    { id: "i1-1", parts: [0] },
    { id: "i1-2", parts: [1] },
  ]);
  assert.equal(flute.grand, false);
  assert.equal(piano.grand, true);
  // Both parts on one staff is the whole staff.
  const both = nameUnit(r.named, 1, "Flauto", "I.II");
  assert.deepEqual(both.staves, ["i1-3"]);
  assert.deepEqual(both.named.instruments[0].staves[2], {
    id: "i1-3",
    parts: [0, 1],
  });
  // No parts named is all of them.
  assert.deepEqual(nameUnit(both.named, 1, "Flauto").staves, ["i1-3"]);
  // A new instrument on a later page is marked with its page.
  assert.equal(
    nameUnit(r.named, 1, "Tamburo", "", 3).named.instruments[2].added,
    3,
  );
});

test("assignUnit: a staff combination is made the first time it is chosen", () => {
  let named = nameUnit(NO_INSTRUMENTS, 1, "Posaune", "1.2.3").named;
  assert.deepEqual(named.instruments[0].staves, [
    { id: "i1-1", parts: [0, 1, 2] },
  ]);
  const r = assignUnit(named, 1, "i1", [1, 2]);
  assert.deepEqual(r.staves, ["i1-2"]);
  named = r.named;
  assert.deepEqual(assignUnit(named, 1, "i1", [2, 1]).staves, ["i1-2"]);
  assert.deepEqual(assignUnit(named, 1, "i1", [0, 1, 2]).staves, ["i1-1"]);
});

test("namingProblem: unnamed staves, and a part on two staves of a system", () => {
  const pages = [pageA()];
  const units = namingUnits(pages);
  let named = nameAll(pages, [
    [0, "Flauto", "I"],
    [1, "Flauto", "II"],
    [2, "Pianoforte", ""],
  ]);
  assert.match(
    namingProblem(named, pages)!,
    /^Name every staff: 3 staves are unnamed on page 1\.$/,
  );
  // The first system alone is complete.
  const first = firstNamingSystem(pages);
  assert.equal(
    namingProblem(named, pages, (u) => inSystem(first, u)),
    null,
  );
  named = nameAll(
    pages,
    [
      [3, "Flauto", "I"],
      [4, "Flauto", "I.II"],
      [5, "Pianoforte", ""],
    ],
    named,
  );
  assert.equal(
    namingProblem(named, pages),
    "Page 1, system 2: Flauto is named on two staves with the same part.",
  );
  named = nameAll(pages, [[4, "Flauto", "II"]], named);
  assert.equal(namingProblem(named, pages), null);
  assert.deepEqual(unitName(named, pages[0], units[4])?.staff, {
    id: "i1-2",
    parts: [1],
  });
});

test("pruneInstruments drops unused staves and instruments and moves groups inward", () => {
  const pages = [pageA()];
  let named = nameAll(pages, [
    [0, "Flauto", "I"],
    [1, "Flauto", "II"],
    [2, "Pianoforte", ""],
  ]);
  named = nameUnit(named, 1, "Flauto", "I.II").named;
  named = nameUnit(named, 1, "Tromba").named;
  named = {
    ...named,
    groups: [
      {
        id: "g1",
        first: "i1",
        last: "i3",
        symbol: "bracket",
        label: "",
        barThru: false,
      },
    ],
  };
  const pruned = pruneInstruments(named, pages);
  assert.deepEqual(
    pruned.instruments.map((i) => [i.name, i.staves.map((s) => s.id)]),
    [
      ["Flauto", ["i1-1", "i1-2"]],
      ["Pianoforte", ["i2-1", "i2-2"]],
    ],
  );
  assert.deepEqual(
    pruned.groups.map((g) => [g.first, g.last]),
    [["i1", "i2"]],
  );
});

test("instrumentScoreDef: parts as a bracket of one instrument, a grand staff as a brace, names and layers", () => {
  let named = nameUnit(NO_INSTRUMENTS, 1, "Flauto", "I").named;
  named = nameUnit(named, 1, "Flauto", "II").named;
  named = nameUnit(named, 1, "Flauto", "I.II").named;
  named = nameUnit(named, 2, "Pianoforte").named;
  named = nameUnit(named, 1, "Voce").named;
  named = {
    ...named,
    instruments: named.instruments.map((i) =>
      i.id === "i1"
        ? { ...i, abbr: "Fl." }
        : i.id === "i3"
          ? { ...i, abbr: "V." }
          : i,
    ),
  };
  const def = instrumentScoreDef(named, {
    ...DEFAULT_SCORE_DEF,
    staves: [
      {
        ...DEFAULT_SCORE_DEF.staves[0],
        id: "i3-1",
        clefShape: "C",
        clefLine: 1,
      },
    ],
  });
  assert.deepEqual(
    def.staves.map((s) => [
      s.id,
      s.label,
      s.labelAbbr,
      (s.layers ?? []).join(" "),
      `${s.clefShape}${s.clefLine}`,
    ]),
    [
      ["i1-3", "I.II", "I.II", "I II", "G2"],
      ["i1-1", "I", "I", "", "G2"],
      ["i1-2", "II", "II", "", "G2"],
      ["i2-1", "", "", "", "G2"],
      ["i2-2", "", "", "", "F4"],
      ["i3-1", "Voce", "V.", "", "C1"],
    ],
  );
  assert.deepEqual(
    def.groups.map((g) => [
      g.id,
      g.start,
      g.end,
      g.symbol,
      g.label,
      g.labelAbbr,
    ]),
    [
      ["i1", 1, 3, "bracket", "Flauto", "Fl."],
      ["i2", 4, 5, "brace", "Pianoforte", ""],
    ],
  );
  // The definition survives the score and a parse.
  const mei = buildFacsimileMei(
    {
      headXml: "<meiHead/>",
      scoreDef: def,
      pages: [{ image: "p.jpg", width: 10, height: 10, zones: [] }],
    },
    { withBreaks: true },
  );
  const parsed = parseScoreDef(mei);
  assert.deepEqual(parsed.staves[0].layers, ["I", "II"]);
  assert.equal(parsed.staves[0].label, "I.II");
  assert.equal(parsed.staves[5].labelAbbr, "V.");
  assert.deepEqual(
    parsed.groups.map((g) => [g.label, g.labelAbbr ?? "", g.oneInstrument]),
    [
      ["Flauto", "Fl.", true],
      ["Pianoforte", "", true],
    ],
  );
});

test("suggestFirstSystem: printed names with trailing part names make one instrument with parts", () => {
  const pages = [pageA()];
  // The second system's labels are not read: it chooses from the list.
  const s = suggestFirstSystem(pages, NO_INSTRUMENTS, [
    [
      ["Flauto I.", "Flauto II.", "Mezzosopran.) Klavier."],
      ["Fl. I", "Fl. II", "Kl."],
    ],
  ]);
  assert.deepEqual(
    s.map((x) => [x.unit.staves, x.name, x.parts]),
    [
      [[0], "Flauto", "I"],
      [[1], "Flauto", "II"],
      [[2, 3], "Klavier", ""],
    ],
  );
});

test("suggestFromList: a shared staff by its short name, the rest by place", () => {
  const pages = [pageA(), pageB()];
  let named = nameAll(pages, [
    [0, "Flauto", "I"],
    [1, "Flauto", "II"],
    [2, "Klavier", ""],
    [3, "Flauto", "I"],
    [4, "Flauto", "II"],
    [5, "Klavier", ""],
  ]);
  // The shared staff exists once someone chose it.
  named = assignUnit(named, 1, "i1", []).named;
  named = {
    ...named,
    fixed: true,
    instruments: named.instruments.map((i) =>
      i.id === "i1" ? { ...i, abbr: "Fl." } : i,
    ),
  };
  const s = suggestFromList(pages, named, [[], [["Fl.", ""]]]);
  assert.deepEqual(
    s.map((x) => [x.unit.page, x.unit.staves, x.instrument, x.parts]),
    [
      [1, [0], "i1", [0, 1]],
      [1, [1, 2], "i2", []],
    ],
  );
});

test("suggestFromList: the first page's later systems follow the first system", () => {
  const pages = [pageA()];
  const named = nameAll(pages, [
    [0, "Flauto", "I"],
    [1, "Flauto", "II"],
    [2, "Klavier", ""],
  ]);
  const s = suggestFromList(pages, named, []);
  assert.deepEqual(
    s.map((x) => [x.unit.system, x.unit.staves, x.instrument, x.parts]),
    [
      [1, [4], "i1", [0]],
      [1, [5], "i1", [1]],
      [1, [6, 7], "i2", []],
    ],
  );
});

test("instrumentScoreDef with opening transcriptions: clefs where each staff first appears, key and meter from the first system", () => {
  const pages = [pageA()];
  const named = nameAll(pages, [
    [0, "Flauto", "I"],
    [1, "Flauto", "II"],
    [2, "Pianoforte", ""],
    [3, "Flauto", "I"],
    [4, "Flauto", "II"],
    [5, "Pianoforte", ""],
  ]);
  const xml = (sign: string, line: number, fifths: number, time = "") =>
    `<score-partwise version="3.1"><part id="P1"><measure><attributes><divisions>1</divisions><key><fifths>${fifths}</fifths></key>${time}<clef><sign>${sign}</sign><line>${line}</line></clef></attributes></measure></part></score-partwise>`;
  const threeFour = "<time><beats>3</beats><beat-type>4</beat-type></time>";
  // Per staff box: its transcription, null for a failed one.
  const transcribed: (string | null)[] = [
    null, // Fl. I, first system: failed, so the second system's box counts
    xml("G", 2, -2),
    xml("G", 2, -2, threeFour),
    xml("F", 4, -2),
    xml("G", 2, 0), // Fl. I, second system: its own key
    xml("C", 3, -2), // Fl. II again: not its opening
    xml("G", 2, -2),
    xml("F", 4, -2),
  ];
  const staves = pages[0].staves!;
  const record: OmrRecord = {
    cropMargin: 0.9,
    staffPipeline: { name: "mzk-staff", version: "1" },
    ocr: { engine: "tesseract.js", version: "7.0.0", language: "deu+eng" },
    pages: [
      {
        n: 1,
        image: "p.jpg",
        staves: staves.map((b, k) => ({
          zone: `staff-zone-1-${k + 1}`,
          // A record of other corners describes another box.
          box: k === 7 ? { ...b, lry: b.lry + 5 } : b,
          label: "",
          musicxml: transcribed[k],
          error: "",
        })),
      },
    ],
    clefs: [],
  };
  const opening = openingTranscriptions(pages, record);
  assert.equal(opening.firstSystem.length, 4);
  assert.equal(opening.firstSystem[0], null);
  const base = {
    ...DEFAULT_SCORE_DEF,
    staves: [
      {
        ...DEFAULT_SCORE_DEF.staves[0],
        id: "i1-2",
        clefShape: "C",
        clefLine: 1,
      },
    ],
  };
  const def = instrumentScoreDef(named, base, opening);
  assert.deepEqual(
    def.staves.map((s) => [s.id, `${s.clefShape}${s.clefLine}`, s.keysig]),
    [
      ["i1-1", "G2", "0"],
      ["i1-2", "G2", undefined],
      ["i2-1", "G2", undefined],
      ["i2-2", "F4", undefined],
    ],
  );
  assert.equal(def.keysig, "2f");
  assert.deepEqual(
    [def.meterCount, def.meterUnit, def.meterSym],
    ["3", "4", ""],
  );
  // Without transcriptions the staves keep the score's values.
  const unread = instrumentScoreDef(named, base, {
    byStaff: new Map(),
    firstSystem: [],
  });
  assert.equal(
    `${unread.staves[1].clefShape}${unread.staves[1].clefLine}`,
    "C1",
  );
  assert.equal(unread.keysig, DEFAULT_SCORE_DEF.keysig);
});

test("doubleNamings: parts of one instrument named as instruments of their own", () => {
  let named = nameUnit(NO_INSTRUMENTS, 1, "Flöte", "I").named;
  named = nameUnit(named, 1, "Flöte", "II").named;
  named = nameUnit(named, 1, "Violoncello und Kontrabass", "Vc").named;
  named = nameUnit(named, 1, "Violoncello und Kontrabass", "Kb").named;
  named = nameUnit(named, 1, "Oboe I, II").named;
  named = nameUnit(named, 1, "Flöte I").named;
  named = nameUnit(named, 1, "Kontrabass").named;
  named = nameUnit(named, 1, "Viola").named;
  named = nameUnit(named, 1, "Oboe").named;
  named = nameUnit(named, 1, "Horn in F", "I.II").named;
  named = nameUnit(named, 1, "Horn in Es").named;
  const nameOf = (id: string) =>
    named.instruments.find((i) => i.id === id)!.name;
  assert.deepEqual(
    doubleNamings(named).map((d) => [
      nameOf(d.instrument),
      nameOf(d.like),
      d.how,
    ]),
    [
      ["Flöte I", "Flöte", "longer"],
      ["Kontrabass", "Violoncello und Kontrabass", "part"],
      ["Oboe I, II", "Oboe", "longer"],
    ],
  );
});

test("mergeInstrument: a part named as an instrument becomes a part again", () => {
  let named = nameUnit(NO_INSTRUMENTS, 1, "Flöte", "I").named;
  named = nameUnit(named, 1, "Flöte", "II").named;
  named = nameUnit(named, 1, "Violoncello und Kontrabass", "Vc").named;
  named = nameUnit(named, 1, "Violoncello und Kontrabass", "Kb").named;
  named = nameUnit(named, 1, "Oboe").named;
  let r = nameUnit(named, 1, "Flöte I");
  named = r.named;
  const fl1 = r.staves[0]!;
  r = nameUnit(named, 1, "Violoncello");
  named = r.named;
  const vc = r.staves[0]!;
  r = nameUnit(named, 1, "Oboe I, II");
  named = r.named;
  const ob = r.staves[0]!;
  named = {
    ...named,
    groups: [
      {
        id: "g1",
        first: named.instruments[0].id,
        last: named.instruments.find((i) => i.name === "Violoncello")!.id,
        symbol: "bracket",
        label: "",
        barThru: false,
      },
    ],
  };
  const byName = (n: LayoutInstruments, name: string) =>
    n.instruments.find((i) => i.name === name)!;
  for (const name of ["Flöte I", "Violoncello", "Oboe I, II"]) {
    const d = doubleNamings(named).find(
      (x) => x.instrument === byName(named, name).id,
    )!;
    const m = mergeInstrument(named, d)!;
    const staffId = { "Flöte I": fl1, Violoncello: vc, "Oboe I, II": ob }[
      name
    ]!;
    const to = m.staves.get(staffId)!;
    const like = m.named.instruments.find((i) =>
      i.staves.some((s) => s.id === to),
    )!;
    const staff = like.staves.find((s) => s.id === to)!;
    named = m.named;
    assert.deepEqual(
      [name, like.name, partsLabel(like, staff)],
      [
        name,
        {
          "Flöte I": "Flöte",
          Violoncello: "Violoncello und Kontrabass",
          "Oboe I, II": "Oboe",
        }[name],
        { "Flöte I": "I", Violoncello: "Vc", "Oboe I, II": "I.II" }[name],
      ],
    );
  }
  assert.equal(named.instruments.length, 3);
  assert.equal(doubleNamings(named).length, 0);
  // The group that ended at Violoncello ends at the instrument it joined.
  assert.equal(
    named.groups[0].last,
    byName(named, "Violoncello und Kontrabass").id,
  );
});

test("grand-staff instruments with parts: Harfe 1 and Harfe 2", () => {
  let r = nameUnit(NO_INSTRUMENTS, 2, "Harfe", "1");
  let named = r.named;
  const h1 = r.staves;
  r = nameUnit(named, 2, "Harfe", "2");
  named = r.named;
  const h2 = r.staves;
  assert.equal(named.instruments.length, 1);
  const harfe = named.instruments[0];
  assert.equal(harfe.grand, true);
  assert.deepEqual(
    harfe.parts.map((p) => p.name),
    ["1", "2"],
  );
  assert.equal(new Set([...h1, ...h2]).size, 4);
  // The same part again gives the same staves.
  assert.deepEqual(nameUnit(named, 2, "Harfe", "1").staves, h1);

  const def = instrumentScoreDef(named, DEFAULT_SCORE_DEF);
  assert.deepEqual(
    def.staves.map((s) => `${s.clefShape}${s.clefLine}`),
    ["G2", "F4", "G2", "F4"],
  );
  assert.deepEqual(
    def.groups.map((g) => [g.symbol, g.start, g.end, g.label]),
    [
      ["none", 1, 4, "Harfe"],
      ["brace", 1, 2, "1"],
      ["brace", 3, 4, "2"],
    ],
  );
  const mei = buildFacsimileMei(
    {
      headXml: "<meiHead/>",
      scoreDef: def,
      pages: [{ image: "p.jpg", width: 10, height: 10, zones: [] }],
    },
    { withBreaks: true },
  );
  assert.deepEqual(
    parseScoreDef(mei).groups.map((g) => [g.symbol, g.start, g.end]),
    [
      ["none", 1, 4],
      ["brace", 1, 2],
      ["brace", 3, 4],
    ],
  );

  // A separately named "Harfe 2" grand staff merges as part 2.
  let other = nameUnit(NO_INSTRUMENTS, 2, "Harfe", "1").named;
  const sep = nameUnit(other, 2, "Harfe 2");
  other = sep.named;
  const d = doubleNamings(other)[0];
  assert.equal(d.how, "longer");
  const m = mergeInstrument(other, d)!;
  assert.equal(m.named.instruments.length, 1);
  const merged = m.named.instruments[0];
  const to = sep.staves.map((id) => m.staves.get(id!)!);
  assert.equal(new Set(to).size, 2);
  assert.deepEqual(
    to.map((id) => partsLabel(merged, merged.staves.find((s) => s.id === id)!)),
    ["2", "2"],
  );
});

test("unprintedStaves: a resting part rests on the staff in force, other unprinted staves hold an mSpace", () => {
  // Posaune with parts 1, 2, 3 on staves "1.2.3", "1" and "2.3"; Violine;
  // Harfe on a grand staff.
  const named: LayoutInstruments = {
    instruments: [
      {
        id: "i1",
        name: "Posaune",
        abbr: "",
        grand: false,
        parts: [{ name: "1" }, { name: "2" }, { name: "3" }],
        staves: [
          { id: "i1-1", parts: [0, 1, 2] },
          { id: "i1-2", parts: [0] },
          { id: "i1-3", parts: [1, 2] },
        ],
      },
      {
        id: "i2",
        name: "Violine",
        abbr: "",
        grand: false,
        parts: [],
        staves: [{ id: "i2-1", parts: [] }],
      },
      {
        id: "i3",
        name: "Harfe",
        abbr: "",
        grand: true,
        parts: [],
        staves: [
          { id: "i3-1", parts: [] },
          { id: "i3-2", parts: [] },
        ],
      },
    ],
    groups: [],
    fixed: true,
  };
  const ids = ["i1-1", "i1-2", "i1-3", "i2-1", "i3-1", "i3-2"];
  // Violine alone; "1.2.3" with harp; "1" and "2.3"; Violine alone.
  const printed = [[4], [1, 4, 5, 6], [2, 3, 4], [4]].map((s) => new Set(s));
  const out = unprintedStaves(named, ids, printed).map((m) =>
    Object.fromEntries([...m].sort(([a], [b]) => a - b)),
  );
  assert.deepEqual(out, [
    // Before its first showing, Posaune rests where it first shows.
    { 1: [1, 2, 3], 2: "space", 3: "space", 5: [1], 6: [1] },
    { 2: "space", 3: "space" },
    { 1: "space", 5: [1], 6: [1] },
    // Parts 2 and 3 rest in their layers of "2.3".
    { 1: "space", 2: [1], 3: [1, 2], 5: [1], 6: [1] },
  ]);
});
