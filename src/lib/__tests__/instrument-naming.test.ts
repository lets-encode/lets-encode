import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assignUnit,
  firstNamingPage,
  instrumentScoreDef,
  NO_INSTRUMENTS,
  nameUnit,
  namingProblem,
  namingUnits,
  parseParts,
  printedName,
  pruneInstruments,
  splitLabel,
  suggestFirstPage,
  suggestFromList,
  unitBoxes,
  unitName,
  type NamingPage,
  type NamingUnit,
} from "../instrument-naming.ts";
import type { LayoutInstruments } from "../omr-layout.ts";
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
  assert.equal(firstNamingPage([{ zones: [] }, ...pages]), 1);
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

test("suggestFirstPage: printed names with trailing part names make one instrument with parts", () => {
  const pages = [pageA()];
  const s = suggestFirstPage(pages, NO_INSTRUMENTS, [
    [
      ["Flauto I.", "Flauto II.", "Mezzosopran.) Klavier."],
      ["", "", ""],
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

test("suggestFromList: the first page's later systems follow its first one", () => {
  const pages = [pageA()];
  const named = nameAll(pages, [
    [0, "Flauto", "I"],
    [1, "Flauto", "II"],
    [2, "Klavier", ""],
  ]);
  const s = suggestFromList(pages, named, [], (p) => p === 0);
  assert.deepEqual(
    s.map((x) => [x.unit.system, x.unit.staves, x.instrument, x.parts]),
    [
      [1, [4], "i1", [0]],
      [1, [5], "i1", [1]],
      [1, [6, 7], "i2", []],
    ],
  );
});
