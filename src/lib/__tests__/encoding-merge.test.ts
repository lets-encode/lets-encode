import { test } from "node:test";
import assert from "node:assert/strict";

import { alignMeasures, mapStaves, readMeasures } from "../encoding-align.ts";
import {
  alignEncoding,
  alignmentMessage,
  layoutSkeleton,
  mergeEncoding,
  UPLOAD_APPLICATION,
} from "../encoding-merge.ts";
import { parseFacsimileMei, parseScoreDef } from "../mei-facsimile.ts";
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
