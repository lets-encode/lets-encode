import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addedFileMeasureId,
  alignMeasures,
  applyFileEdits,
  editedFileIds,
  fileEditsOf,
  mapStaves,
  pinsOf,
  readMeasures,
  scoreStavesOf,
  shiftPins,
} from "../encoding-align.ts";
import {
  alignEncoding,
  alignmentMessage,
  checkScore,
  layoutSkeleton,
  mergeEncoding,
  UPLOAD_APPLICATION,
} from "../encoding-merge.ts";
import {
  parseFacsimileMei,
  parseScoreDef,
  replaceScoreDef,
} from "../mei-facsimile.ts";
import { addXmlIds } from "../mei-ids.ts";
import { correctedLayoutJson } from "../omr-layout.ts";
import { elementsNamed } from "../mei-xml.ts";
import { measure, skeleton, staff, upload } from "./encoding-fixture.ts";

const RESP = 'resp="#app-uploaded-encoding"';

/** Align and merge with staves mapped by position. */
function merge(layoutMei: string, fileMei: string, staffCount = 1) {
  const alignment = alignMeasures(
    readMeasures(layoutMei),
    readMeasures(fileMei),
  );
  const fileStaves = parseScoreDef(fileMei).staves.length;
  return mergeEncoding(
    layoutMei,
    fileMei,
    alignment,
    mapStaves(Array(fileStaves).fill(""), staffCount),
    staffCount,
  );
}

const measuresOf = (mei: string) => [...elementsNamed(mei, "measure")];

test("a complete file fills every layout measure and keeps the layout's structure", () => {
  const layout = skeleton([2, 1], 1, { 1: { rptEnd: true } });
  const result = merge(layout, upload(measure(1) + measure(2) + measure(3)));
  const measures = measuresOf(result.mei);
  assert.equal(measures.length, 3);
  assert.deepEqual(
    measures.map((m) => /facs="([^"]*)"/.exec(m.tag)?.[1]),
    ["#zone-1-1", "#zone-1-2", "#zone-1-3"],
  );
  assert.match(measures[1].tag, /right="rptend"/);
  for (const m of measures) {
    assert.match(m.inner, /<note\b/);
    assert.match(m.inner, new RegExp(`<staff [^>]*${RESP}`));
  }
  assert.match(result.mei, /<sb\b/);
  assert.match(result.mei, /<pb\b[^>]*facs="#surface-1"/);
  assert.deepEqual([result.filled, result.empty], [[0, 1, 2], []]);
  assert.match(
    result.mei,
    new RegExp(
      `<application xml:id="app-uploaded-encoding">\\s*<name\\b[^>]*>${UPLOAD_APPLICATION}</name>`,
    ),
  );
});

test("the file's score definition replaces the skeleton's", () => {
  const result = merge(skeleton([1]), upload(measure(1)));
  const scoreDef = parseScoreDef(result.mei);
  assert.deepEqual(
    [scoreDef.keysig, scoreDef.meterCount, scoreDef.meterUnit],
    ["2s", "3", "4"],
  );
});

test("layout measures without a file measure, and empty staves, stay empty without resp", () => {
  const fileMei = upload(
    `<measure n="1">${staff(1)}${staff(2, true)}</measure>` + measure(2, 2),
    `<scoreDef><staffGrp><staffDef n="1" lines="5" clef.shape="G" clef.line="2"/><staffDef n="2" lines="5" clef.shape="F" clef.line="4"/></staffGrp></scoreDef>`,
  );
  const result = merge(skeleton([3], 2), fileMei, 2);
  const measures = measuresOf(result.mei);
  const staves = (m: number) => [...elementsNamed(measures[m].inner, "staff")];
  assert.match(staves(0)[0].tag, new RegExp(RESP));
  assert.doesNotMatch(staves(0)[1].tag, /resp=/);
  assert.match(staves(0)[1].inner, /<layer\b[^>]*\/>/);
  assert.equal(staves(2).length, 2);
  assert.ok(staves(2).every((s) => !/resp=/.test(s.tag)));
  assert.deepEqual([result.filled, result.empty], [[0, 1], [2]]);
});

test("file measures without a place are dropped and counted", () => {
  const result = merge(
    skeleton([2]),
    upload(measure(1) + measure(2) + measure(3)),
  );
  assert.equal(measuresOf(result.mei).length, 2);
  assert.equal(result.droppedMeasures, 1);
});

test("a file staff goes to the layout staff mapStaves gives it", () => {
  const layout = skeleton([1], 2);
  const fileMei = upload(measure(1));
  const result = mergeEncoding(
    layout,
    fileMei,
    alignMeasures(readMeasures(layout), readMeasures(fileMei)),
    [2],
    2,
  );
  const staves = [...elementsNamed(measuresOf(result.mei)[0].inner, "staff")];
  assert.match(staves[0].tag, /n="1"/);
  assert.doesNotMatch(staves[0].tag, /resp=/);
  assert.match(staves[1].tag, /n="2"/);
  assert.match(staves[1].tag, new RegExp(RESP));
  assert.match(staves[1].inner, /<note\b/);
});

test("control events keep their ends, are mapped to their staff, or are dropped", () => {
  const fileMei = upload(
    `<measure n="1"><staff n="1"><layer n="1"><note xml:id="a" pname="c" oct="4" dur="4"/></layer></staff>` +
      `<slur startid="#a" endid="#b"/><dynam staff="1" tstamp="1">p</dynam></measure>` +
      `<measure n="2"><staff n="1"><layer n="1"><note xml:id="b" pname="d" oct="4" dur="4"/></layer></staff>` +
      `<slur startid="#b" endid="#c"/></measure>` +
      `<measure n="3"><staff n="1"><layer n="1"><note xml:id="c" pname="e" oct="4" dur="4"/></layer></staff></measure>`,
  );
  const result = merge(skeleton([2]), fileMei);
  const [first, second] = measuresOf(result.mei);
  assert.match(first.inner, /<slur\b[^>]*startid="#a"[^>]*endid="#b"/);
  assert.match(first.inner, /<dynam\b[^>]*staff="1"/);
  assert.doesNotMatch(
    second.inner,
    /<slur\b/,
    "its end is in a dropped measure",
  );
  assert.equal(result.droppedEvents, 1);
});

test("ids the skeleton already uses are renamed in the file, with their references", () => {
  const fileMei = upload(
    `<measure xml:id="measure-1" n="1"><staff n="1"><layer n="1">` +
      `<note xml:id="staff-1" pname="c" oct="4" dur="4"/><note xml:id="n2" pname="d" oct="4" dur="4"/>` +
      `</layer></staff><slur startid="#staff-1" endid="#n2"/></measure>`,
  );
  const result = merge(skeleton([1]), fileMei);
  const ids = [...result.mei.matchAll(/xml:id="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "every id once");
  assert.match(result.mei, /<note xml:id="u-staff-1"/);
  assert.match(result.mei, /<slur\b[^>]*startid="#u-staff-1"/);
});

test("score-definition changes between measures go before their layout measure", () => {
  const fileMei = upload(
    measure(1) + `<scoreDef meter.count="2" meter.unit="4"/>` + measure(2),
  );
  const result = merge(skeleton([1, 1]), fileMei);
  assert.match(
    result.mei,
    /<sb\b[^>]*\/>\s*<scoreDef\b[^>]*meter\.count="2"[^>]*\/>\s*<measure\b[^>]*n="2"/,
  );
  assert.equal(result.droppedDefinitions, 0);
});

test("a multi-measure rest fills each of its layout measures with a measure rest", () => {
  const fileMei = upload(
    `<measure n="1"><staff n="1"><layer n="1"><multiRest num="2"/></layer></staff></measure>`,
  );
  const result = merge(skeleton([2]), fileMei);
  for (const m of measuresOf(result.mei)) assert.match(m.inner, /<mRest\b/);
  assert.deepEqual(result.filled, [0, 1]);
});

test("the file's final barline is kept, its repeats are not", () => {
  const result = merge(
    skeleton([3]),
    upload(
      measure(1, 1, ' left="rptstart"') +
        `<measure n="2" right="end"><staff n="1"><layer n="1"><multiRest num="2"/></layer></staff></measure>`,
    ),
  );
  const tags = measuresOf(result.mei).map((m) => m.tag);
  assert.doesNotMatch(tags[0], /left=/);
  assert.doesNotMatch(tags[1], /right=/);
  assert.match(tags[2], /right="end"/);
});

test("a final barline is kept only on the last measure of a movement", () => {
  const end = (n: number) => measure(n, 1, ' right="end"');
  // A file that stops early ends without a final barline.
  const partial = merge(skeleton([4, 4]), upload(measure(1) + end(2)));
  assert.ok(measuresOf(partial.mei).every((m) => !/right=/.test(m.tag)));
  // Two movements keep a final barline each.
  const movements = merge(
    skeleton([2, 2], 1, { 2: { mdiv: true, label: "1" }, 3: { label: "2" } }),
    upload(measure(1) + end(2) + measure(1) + end(2)),
  );
  assert.deepEqual(
    measuresOf(movements.mei).map((m) => /right="end"/.test(m.tag)),
    [false, true, false, true],
  );
});

test("the skeleton rebuilt from a merged score merges into the same score", () => {
  const layout = skeleton([2, 2], 1, { 1: { rptEnd: true } });
  const fileMei = upload(
    measure(1) +
      measure(2) +
      `<scoreDef meter.count="2" meter.unit="4"/>` +
      measure(3),
  );
  const first = merge(layout, fileMei);
  const again = layoutSkeleton(first.mei, null, false);
  assert.doesNotMatch(again, /<note\b/, "the rebuilt skeleton is empty");
  assert.equal(merge(again, fileMei).mei, first.mei);
});

test("keepScoreDef leaves the skeleton's score definition as it is", () => {
  const layout = skeleton([1]);
  const fileMei = upload(measure(1));
  const result = mergeEncoding(
    layout,
    fileMei,
    alignMeasures(readMeasures(layout), readMeasures(fileMei)),
    [1],
    1,
    { keepScoreDef: true },
  );
  assert.deepEqual(parseScoreDef(result.mei), parseScoreDef(layout));
});

test("alignmentMessage names the filled and empty measures and the dropped ones", () => {
  const gap = merge(
    skeleton([4]),
    upload(["1", "2", "4"].map((n) => measure(n)).join("")),
  );
  assert.equal(
    alignmentMessage("P0002", readMeasures(gap.mei), gap),
    "Align the uploaded encoding (P0002): measures 1–2, 4 from the file, 3 empty",
  );
  const extra = merge(
    skeleton([2]),
    upload(measure(1) + measure(2) + measure(3)),
  );
  assert.equal(
    alignmentMessage("P0002", readMeasures(extra.mei), extra),
    "Align the uploaded encoding (P0002): measures 1–2 from the file, 1 file measure dropped",
  );
});

test("alignEncoding merges along the fixed links and records them", () => {
  const fileMei = upload(measure(1) + measure(2));
  const aligned = alignEncoding({
    current: skeleton([3]),
    corrected: null,
    upload: fileMei,
    preparation: "measure-detection",
    pins: [{ box: 2, slot: { measure: 1, part: 0 } }],
  });
  assert.deepEqual(aligned.merged.filled, [0, 2]);
  assert.equal(aligned.summary.kind, "partial");
  assert.deepEqual(JSON.parse(aligned.record).pins, [[2, [1, 0]]]);
  assert.deepEqual(aligned.problems, []);
});

test("an omr-instruments piece keeps its score definition and pairs staves by clef", () => {
  const current = skeleton([1], 2);
  const fileMei = upload(
    `<measure n="1">${staff(1)}</measure>`,
    `<scoreDef><staffGrp><staffDef n="1" lines="5" clef.shape="G" clef.line="2"/></staffGrp></scoreDef>`,
  );
  const aligned = alignEncoding({
    current,
    corrected: correctedLayoutJson(parseFacsimileMei(current).pages),
    upload: fileMei,
    preparation: "omr-instruments",
    pins: [],
  });
  assert.deepEqual(parseScoreDef(aligned.merged.mei), parseScoreDef(current));
  assert.equal(aligned.staffCount, 2);
  assert.deepEqual(aligned.staffMap, [1]);
});

/**
 * A score definition with one staff per clef ("G2", "F4" …); `groups` are
 * [start, end, symbol] runs, outer groups first and not nested otherwise.
 */
function scoreDefXml(
  clefs: string[],
  groups: [number, number, string][] = [],
): string {
  const def = (n: number) =>
    `<staffDef n="${n}" lines="5" clef.shape="${clefs[n - 1][0]}" clef.line="${clefs[n - 1][1]}"/>`;
  const run = (
    from: number,
    to: number,
    inside?: [number, number, string],
  ): string => {
    let out = "";
    for (let n = from; n <= to; ) {
      const group = groups.find(
        (g) => g !== inside && g[0] === n && g[1] <= to,
      );
      if (group) {
        out += `<staffGrp symbol="${group[2]}">${run(group[0], group[1], group)}</staffGrp>`;
        n = group[1] + 1;
      } else out += def(n++);
    }
    return out;
  };
  return `<scoreDef keysig="0" meter.count="4" meter.unit="4"><staffGrp>${run(1, clefs.length)}</staffGrp></scoreDef>`;
}

/** A note with an xml:id and extra attributes. */
const note = (id: string, attrs = "") =>
  `<note xml:id="${id}" pname="c" oct="4" dur="4"${attrs}/>`;

/** A staff `n` holding the given layer content. */
const staffWith = (n: number, content: string) =>
  `<staff n="${n}"><layer n="1">${content}</layer></staff>`;

/** Merge a one-measure-per-measure file with an explicit staff map. */
function mergeWith(
  layoutMei: string,
  fileMei: string,
  staffMap: (number | null)[],
  staffCount: number,
  options: { layoutGroups?: boolean } = {},
) {
  return mergeEncoding(
    layoutMei,
    fileMei,
    alignMeasures(readMeasures(layoutMei), readMeasures(fileMei)),
    staffMap,
    staffCount,
    options,
  );
}

const firstMeasure = (mei: string) => measuresOf(mei)[0].inner;

test("rule 1: @staff inside a staff is mapped, or removed and counted when its staff is left out", () => {
  const fileMei = upload(
    `<measure n="1">${staffWith(1, note("a", ' staff="2"'))}${staffWith(2, note("b"))}</measure>`,
    scoreDefXml(["G2", "F4"]),
  );
  const swapped = mergeWith(skeleton([1], 2), fileMei, [2, 1], 2);
  assert.match(firstMeasure(swapped.mei), /<note xml:id="a"[^>]*staff="1"/);
  assert.equal(swapped.crossStaffRemoved, 0);
  const alone = mergeWith(skeleton([1], 1), fileMei, [1, null], 1);
  assert.match(firstMeasure(alone.mei), /<note xml:id="a"/);
  assert.doesNotMatch(firstMeasure(alone.mei), /<note xml:id="a"[^>]*staff=/);
  assert.equal(alone.crossStaffRemoved, 1);
});

test("rule 2: @beam.with and @stem.with stay only while the neighbouring staff stays", () => {
  const fileMei = upload(
    `<measure n="1">${staffWith(1, note("a"))}${staffWith(2, note("b", ' beam.with="above" stem.with="below"'))}${staffWith(3, note("c"))}</measure>`,
    scoreDefXml(["G2", "G2", "F4"]),
  );
  const same = mergeWith(skeleton([1], 3), fileMei, [1, 2, 3], 3);
  assert.match(firstMeasure(same.mei), /beam\.with="above" stem\.with="below"/);
  assert.equal(same.neighbourRemoved, 0);
  const below = mergeWith(skeleton([1], 3), fileMei, [1, 2, null], 3);
  assert.match(firstMeasure(below.mei), /beam\.with="above"/);
  assert.doesNotMatch(firstMeasure(below.mei), /stem\.with/);
  assert.equal(below.neighbourRemoved, 1);
  const moved = mergeWith(skeleton([1], 3), fileMei, [2, 1, 3], 3);
  assert.doesNotMatch(firstMeasure(moved.mei), /beam\.with|stem\.with/);
  assert.equal(moved.neighbourRemoved, 2);
});

test("rule 3: an event on several staves keeps the staves that remain", () => {
  const fileMei = upload(
    `<measure n="1">${staffWith(1, note("a"))}${staffWith(2, note("b"))}` +
      `<hairpin staff="1 2" tstamp="1" tstamp2="0m+3" form="cres"/></measure>`,
    scoreDefXml(["G2", "F4"]),
  );
  const result = mergeWith(skeleton([1], 1), fileMei, [1, null], 1);
  assert.match(firstMeasure(result.mei), /<hairpin\b[^>]*staff="1"/);
  assert.deepEqual([result.droppedEvents, result.movedEvents], [0, 0]);
});

test("rule 4: events without a pointer move to the first staff from the file, others are dropped", () => {
  const fileMei = upload(
    `<measure n="1">${staffWith(1, note("a") + note("a2"))}${staffWith(2, note("b"))}` +
      `<tempo staff="1" tstamp="1">Allegro</tempo><dynam staff="1" tstamp="1">p</dynam>` +
      `<slur staff="1" startid="#a" endid="#a2"/><dir staff="1" startid="#b">dolce</dir></measure>`,
    scoreDefXml(["G2", "F4"]),
  );
  // File staff 1 is left out; score staff 1 stays empty, file staff 2 is score staff 2.
  const result = mergeWith(skeleton([1], 2), fileMei, [null, 2], 2);
  const inner = firstMeasure(result.mei);
  assert.match(inner, /<tempo\b[^>]*staff="2"/);
  assert.match(inner, /<dynam\b[^>]*staff="2"/);
  assert.doesNotMatch(inner, /<slur\b|<dir\b/);
  assert.deepEqual([result.movedEvents, result.droppedEvents], [2, 2]);
});

test("rule 5: staff definitions in a score definition change are renumbered or dropped", () => {
  const change = (defs: string) =>
    addXmlIds(
      upload(
        measure(1, 3) +
          `<scoreDef meter.count="2" meter.unit="4"><staffGrp>${defs}</staffGrp></scoreDef>` +
          measure(2, 3) +
          `<scoreDef><staffGrp><staffDef n="2" clef.shape="F" clef.line="4"/></staffGrp></scoreDef>` +
          measure(3, 3),
        scoreDefXml(["G2", "G2", "F4"]),
      ),
      "u-",
    );
  const fileMei = change(
    `<staffDef n="2" clef.shape="C" clef.line="3"/><staffDef n="3" clef.shape="G" clef.line="2"/>`,
  );
  const result = mergeWith(skeleton([3], 2), fileMei, [1, null, 2], 2);
  const [, second, third] = measuresOf(result.mei);
  const before = (m: { tag: string }) =>
    result.mei.slice(0, result.mei.indexOf(m.tag));
  assert.match(
    before(second),
    /<scoreDef\b[^>]*meter\.count="2"[^>]*>\s*<staffGrp\b[^>]*>\s*<staffDef\b[^>]*n="2"[^>]*clef\.shape="G"[^>]*\/>\s*<\/staffGrp>\s*<\/scoreDef>\s*$/,
  );
  assert.doesNotMatch(
    result.mei.slice(
      result.mei.indexOf(second.tag),
      result.mei.indexOf(third.tag),
    ),
    /<scoreDef\b/,
    "the second change held only the left-out staff",
  );
  assert.equal(result.droppedDefinitions, 2);
});

test("rule 6: file groups that survive are carried, renumbered; the others are dropped", () => {
  // A bracket over all four staves, a brace over staves 2 and 3.
  const fileMei = upload(
    measure(1, 4),
    scoreDefXml(
      ["G2", "G2", "F4", "C3"],
      [
        [1, 4, "bracket"],
        [2, 3, "brace"],
      ],
    ),
  );
  const moved = mergeWith(skeleton([1], 3), fileMei, [3, 1, 2, null], 3);
  assert.deepEqual(
    parseScoreDef(moved.mei).groups.map((g) => [g.start, g.end, g.symbol]),
    [[1, 2, "brace"]],
  );
  assert.equal(moved.droppedGroups, 1);
  const reversed = mergeWith(skeleton([1], 4), fileMei, [1, 3, 2, 4], 4);
  assert.deepEqual(parseScoreDef(reversed.mei).groups, []);
  assert.equal(reversed.droppedGroups, 2);
  const layout = mergeWith(skeleton([1], 3), fileMei, [3, 1, 2, null], 3, {
    layoutGroups: true,
  });
  assert.deepEqual(parseScoreDef(layout.mei).groups, []);
  assert.equal(layout.droppedGroups, 0);
});

test("rule 7: an ossia's staves are renumbered, or the ossia is dropped with its staff", () => {
  const fileMei = upload(
    `<measure n="1">${staffWith(1, note("a"))}${staffWith(2, note("b"))}` +
      `<ossia>${staffWith(2, note("o"))}</ossia></measure>`,
    scoreDefXml(["G2", "F4"]),
  );
  const swapped = mergeWith(skeleton([1], 2), fileMei, [2, 1], 2);
  assert.match(
    firstMeasure(swapped.mei),
    /<ossia\b[^>]*>\s*<staff\b[^>]*n="1"[^>]*>\s*<layer\b[^>]*>\s*<note xml:id="o"/,
  );
  const alone = mergeWith(skeleton([1], 1), fileMei, [1, null], 1);
  assert.doesNotMatch(firstMeasure(alone.mei), /<ossia\b/);
  assert.equal(alone.droppedEvents, 1);
});

test("rule 8: checkScore names staves out of range and pointers to missing elements", () => {
  const mei = upload(
    `<measure n="1">${staffWith(1, note("a"))}</measure>` +
      `<measure n="2">${staffWith(1, note("b"))}<dynam staff="3" tstamp="1">f</dynam>` +
      `<slur startid="#b" endid="#gone"/></measure>`,
  );
  assert.deepEqual(checkScore(mei, 1), [
    { measure: 1, text: "Measure 2: <dynam> names staff 3, the score has 1" },
    {
      measure: 1,
      text: "Measure 2: <slur> points to #gone, which is not in the score",
    },
  ]);
  assert.deepEqual(checkScore(upload(measure(1)), 1), []);
});

test("alignEncoding takes the chosen score staves, adds empty ones and records the list", () => {
  const fileMei = upload(
    `<measure n="1">${staffWith(1, note("a"))}${staffWith(2, note("b"))}</measure>`,
    scoreDefXml(["G2", "F4"]),
  );
  const input = {
    current: skeleton([1]),
    corrected: null,
    upload: fileMei,
    preparation: "measure-detection",
    pins: [],
  };
  const aligned = alignEncoding({ ...input, scoreStaves: [2, null, 1] });
  assert.equal(aligned.staffCount, 3);
  assert.deepEqual(aligned.staffMap, [3, 1]);
  assert.deepEqual(aligned.scoreStaves, [2, null, 1]);
  assert.deepEqual(
    aligned.fileStaves.map((s) => [s.n, s.clefShape, s.clefLine]),
    [
      [1, "G", 2],
      [2, "F", 4],
    ],
  );
  assert.equal(aligned.layoutStaffNames, null);
  assert.deepEqual(
    parseScoreDef(aligned.merged.mei).staves.map((s) => s.clefShape),
    ["F", "G", "G"],
  );
  assert.deepEqual(JSON.parse(aligned.record).scoreStaves, [2, null, 1]);
  assert.deepEqual(scoreStavesOf(aligned.record), [2, null, 1]);
  assert.deepEqual(aligned.problems, []);
  // A list that names a file staff twice or one out of range is ignored.
  for (const scoreStaves of [[1, 1], [3], []]) {
    const automatic = alignEncoding({ ...input, scoreStaves });
    assert.deepEqual(automatic.scoreStaves, [1, 2]);
    assert.equal(scoreStavesOf(automatic.record), undefined);
  }
});

test("an OMR piece takes a chosen list only with the layout's staff count, and names its staves", () => {
  const plain = skeleton([1], 2);
  const def = parseScoreDef(plain);
  const current = replaceScoreDef(plain, {
    ...def,
    staves: def.staves.map((s, i) => ({ ...s, label: ["Violin", ""][i] })),
    groups: [
      {
        start: 2,
        end: 2,
        symbol: "bracket",
        label: "Viola",
        barThru: false,
        oneInstrument: false,
      },
    ],
  });
  const input = {
    current,
    corrected: correctedLayoutJson(parseFacsimileMei(current).pages),
    upload: upload(`<measure n="1">${staff(1)}</measure>`),
    preparation: "omr-instruments",
    pins: [],
  };
  assert.deepEqual(
    alignEncoding({ ...input, scoreStaves: [null, 1] }).staffMap,
    [2],
  );
  const ignored = alignEncoding({ ...input, scoreStaves: [1] });
  assert.deepEqual(ignored.staffMap, [1]);
  assert.deepEqual(ignored.scoreStaves, [1, null]);
  assert.deepEqual(ignored.layoutStaffNames, ["Violin", "Viola"]);
});

test("addXmlIds gives the same upload the same file measure ids", () => {
  const fileMei = upload(measure(1) + measure(2));
  assert.equal(addXmlIds(fileMei, "u-"), addXmlIds(fileMei, "u-"));
  assert.deepEqual(
    readMeasures(addXmlIds(fileMei, "u-")).map((m) => m.id),
    ["u-measure-1", "u-measure-2"],
  );
});

test("a removed file measure is left out; the following ones move into place and none is unplaced", () => {
  const fileEdits = { removed: ["u-measure-3"], added: [] };
  const aligned = alignEncoding({
    current: skeleton([3]),
    corrected: null,
    upload: upload(measure(1) + measure(2) + measure(9) + measure(3)),
    preparation: "measure-detection",
    pins: [],
    fileEdits,
  });
  assert.deepEqual(
    aligned.file.map((m) => m.label),
    ["1", "2", "3"],
  );
  assert.equal(aligned.summary.kind, "complete");
  assert.deepEqual(
    [aligned.summary.unplaced, aligned.merged.droppedMeasures],
    [0, 0],
  );
  assert.deepEqual(aligned.fileRemoved, [{ id: "u-measure-3", label: "9" }]);
  assert.deepEqual(aligned.fileIds, [
    "u-measure-1",
    "u-measure-2",
    "u-measure-3",
    "u-measure-4",
  ]);
});

test("an added file measure is empty; the layout measure holding it stays empty and later ones shift", () => {
  const fileEdits = {
    removed: [],
    added: [{ after: "u-measure-1", id: "added-measure-1" }],
  };
  const fileMei = upload(
    measure(1, 2) + measure(3, 2),
    scoreDefXml(["G2", "F4"]),
  );
  const aligned = alignEncoding({
    current: skeleton([3], 2),
    corrected: null,
    upload: fileMei,
    preparation: "measure-detection",
    pins: [],
    fileEdits,
  });
  assert.deepEqual(
    aligned.file.map((m) => [m.id, m.label, [...m.events.keys()]]),
    [
      ["u-measure-1", "1", [1, 2]],
      ["added-measure-1", "", [1, 2]],
      ["u-measure-2", "3", [1, 2]],
    ],
  );
  assert.deepEqual(
    aligned.alignment.matches.map((slot) => slot?.measure ?? null),
    [0, 1, 2],
  );
  assert.deepEqual(
    [aligned.merged.filled, aligned.merged.empty],
    [[0, 2], [1]],
  );
  const merged = measuresOf(aligned.merged.mei);
  assert.doesNotMatch(merged[1].inner, /<note\b|resp=/);
  assert.match(merged[2].inner, /<note\b/);
  assert.deepEqual(aligned.fileAdded, fileEdits.added);
});

test("removing and adding together; additions after one measure keep their order", () => {
  const fileEdits = {
    removed: ["u-measure-2"],
    added: [
      { after: "u-measure-2", id: "added-measure-1" },
      { after: "u-measure-2", id: "added-measure-2" },
      { after: "added-measure-1", id: "added-measure-3" },
      { after: null, id: "added-measure-4" },
    ],
  };
  const ids = ["u-measure-1", "u-measure-2", "u-measure-3"];
  const expected = [
    "added-measure-4",
    "u-measure-1",
    "added-measure-1",
    "added-measure-3",
    "added-measure-2",
    "u-measure-3",
  ];
  assert.deepEqual(editedFileIds(ids, fileEdits), expected);
  const edited = applyFileEdits(
    addXmlIds(upload(measure(1) + measure(2) + measure(3)), "u-"),
    fileEdits,
  );
  assert.deepEqual(
    readMeasures(edited).map((m) => m.id),
    expected,
  );
  assert.equal(addedFileMeasureId(fileEdits), "added-measure-5");
});

test("shiftPins moves the pins' file measures with an edit and drops a pin on a removed one", () => {
  const ids = ["u-measure-1", "u-measure-2", "u-measure-3"];
  const none = { removed: [], added: [] };
  const pins = [
    { box: 0, slot: { measure: 0, part: 0 } },
    { box: 1, slot: { measure: 1, part: 0 } },
    { box: 2, slot: { measure: 2, part: 0 } },
    { box: 3, slot: null },
  ];
  const removed = { removed: ["u-measure-2"], added: [] };
  assert.deepEqual(shiftPins(pins, ids, none, removed), [
    { box: 0, slot: { measure: 0, part: 0 } },
    { box: 2, slot: { measure: 1, part: 0 } },
    { box: 3, slot: null },
  ]);
  const added = {
    removed: ["u-measure-2"],
    added: [{ after: null, id: "added-measure-1" }],
  };
  assert.deepEqual(
    shiftPins(shiftPins(pins, ids, none, removed), ids, removed, added),
    [
      { box: 0, slot: { measure: 1, part: 0 } },
      { box: 2, slot: { measure: 2, part: 0 } },
      { box: 3, slot: null },
    ],
  );
});

test("the record keeps the file measure edits and the pins on the edited file", () => {
  const fileEdits = {
    removed: ["u-measure-1"],
    added: [{ after: "u-measure-2", id: "added-measure-1" }],
  };
  const pins = [{ box: 2, slot: { measure: 1, part: 0 } }];
  const aligned = alignEncoding({
    current: skeleton([3]),
    corrected: null,
    upload: upload(measure(1) + measure(2) + measure(3)),
    preparation: "measure-detection",
    pins,
    fileEdits,
  });
  assert.deepEqual(JSON.parse(aligned.record).fileMeasures, fileEdits);
  assert.deepEqual(fileEditsOf(aligned.record), fileEdits);
  assert.deepEqual(pinsOf(aligned.record), pins);
  assert.equal(scoreStavesOf(aligned.record), undefined);
  const plain = alignEncoding({
    current: skeleton([1]),
    corrected: null,
    upload: upload(measure(1)),
    preparation: "measure-detection",
    pins: [],
  });
  assert.equal(JSON.parse(plain.record).fileMeasures, undefined);
  assert.deepEqual(fileEditsOf(plain.record), { removed: [], added: [] });
  assert.deepEqual(fileEditsOf(null), { removed: [], added: [] });
  assert.throws(
    () => fileEditsOf(`{"fileMeasures":{"removed":[1]}}`),
    /cannot be read/,
  );
  assert.throws(() => scoreStavesOf(`{"scoreStaves":["1"]}`), /cannot be read/);
  assert.throws(() => fileEditsOf("not json"), /could not be read/);
});
