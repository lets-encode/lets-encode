import { test } from "node:test";
import assert from "node:assert/strict";

import { preferAttributes } from "../mei-attributes.ts";

test("preferAttributes moves accid and artic children into their note or chord", () => {
  const xml =
    '<layer><note xml:id="n1" pname="c" oct="5" dur="4">\n  <accid xml:id="a1" accid="f" />\n  <artic xml:id="t1" artic="stacc" />\n  <artic artic="acc"/>\n</note>' +
    '<chord xml:id="c1" dur="4"><note pname="e" oct="4"><accid accid.ges="s"/></note><artic artic="ten"/></chord></layer>';
  assert.equal(
    preferAttributes(xml),
    '<layer><note xml:id="n1" pname="c" oct="5" dur="4" accid="f" artic="stacc acc"/>' +
      '<chord xml:id="c1" dur="4" artic="ten"><note pname="e" oct="4" accid.ges="s"/></chord></layer>',
  );
});

test("preferAttributes moves clef, keySig and meterSig into staffDef and scoreDef", () => {
  const xml =
    '<scoreDef xml:id="sd"><keySig sig="4f"/><meterSig count="3" unit="4"/><staffGrp>' +
    '<staffDef n="1" lines="5"><label>Vl.</label><clef shape="F" line="4" dis="8" dis.place="below"/><keySig sig="1s"/></staffDef>' +
    "</staffGrp></scoreDef>" +
    '<section><scoreDef><meterSig sym="common"/></scoreDef></section>';
  assert.equal(
    preferAttributes(xml),
    '<scoreDef xml:id="sd" keysig="4f" meter.count="3" meter.unit="4"><staffGrp>' +
      '<staffDef n="1" lines="5" clef.shape="F" clef.line="4" clef.dis="8" clef.dis.place="below" keysig="1s"><label>Vl.</label></staffDef>' +
      "</staffGrp></scoreDef>" +
      '<section><scoreDef meter.sym="common"/></section>',
  );
});

test("preferAttributes keeps an element that says more than the attribute can", () => {
  for (const xml of [
    // Another attribute: a cautionary accidental, an articulation's place, a key's mode.
    '<note pname="b"><accid accid="n" func="caution"/></note>',
    '<note pname="b"><artic artic="stacc" place="above"/><artic artic="acc"/></note>',
    '<scoreDef><keySig sig="1f" mode="minor"/></scoreDef>',
    // Content of its own.
    '<scoreDef><keySig><keyAccid accid="s" pname="f"/></keySig></scoreDef>',
    // An id something points to.
    '<note pname="b"><accid xml:id="a1" accid="f"/></note><annot plist="#x #a1"/>',
    // A parent that sets the attribute already, or more than one such child.
    '<note pname="b" accid="s"><accid accid="f"/></note>',
    '<note pname="b"><accid accid="f"/><accid accid="s"/></note>',
    // A clef change inside a layer.
    '<layer><clef shape="F" line="4"/><note pname="b"/></layer>',
  ])
    assert.equal(preferAttributes(xml), xml, xml);
});

test("preferAttributes leaves a document without such children unchanged", () => {
  const xml = '<mei><note pname="c"/><note pname="d"><dot/></note></mei>';
  assert.equal(preferAttributes(xml), xml);
});
