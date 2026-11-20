import { test } from "node:test";
import assert from "node:assert/strict";

import { formatMei } from "../mei-format.ts";

test("formatMei puts each element on its own line, three spaces deeper per level", () => {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<?xml-model href="x"?>\n' +
    '<mei><meiHead/><music><body><mdiv>\n<score>\n      <section><measure n="1"><staff n="1"><layer>' +
    '<note pname="c" />\n<chord><note pname="e"/></chord></layer></staff></measure>' +
    "<pubStmt>\n   </pubStmt></section></score></mdiv></body></music></mei>";
  assert.equal(
    formatMei(xml),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<?xml-model href="x"?>',
      "<mei>",
      "   <meiHead/>",
      "   <music>",
      "      <body>",
      "         <mdiv>",
      "            <score>",
      "               <section>",
      '                  <measure n="1">',
      '                     <staff n="1">',
      "                        <layer>",
      '                           <note pname="c" />',
      "                           <chord>",
      '                              <note pname="e"/>',
      "                           </chord>",
      "                        </layer>",
      "                     </staff>",
      "                  </measure>",
      "                  <pubStmt></pubStmt>",
      "               </section>",
      "            </score>",
      "         </mdiv>",
      "      </body>",
      "   </music>",
      "</mei>",
      "",
    ].join("\n"),
  );
});

test("formatMei keeps elements with text, CDATA or xml:space='preserve' as written", () => {
  const mixed = "<p>Text <rend fontstyle='italic'>in</rend>  two\n  lines</p>";
  const cdata = "<annot><![CDATA[ a < b ]]></annot>";
  const kept = '<lg xml:space="preserve">\n  <l>x</l>\n</lg>';
  const xml = `<mei><meiHead><notesStmt>${mixed}${cdata}\n${kept}</notesStmt></meiHead></mei>`;
  assert.equal(
    formatMei(xml),
    [
      "<mei>",
      "   <meiHead>",
      "      <notesStmt>",
      `         ${mixed}`,
      `         ${cdata}`,
      `         ${kept}`,
      "      </notesStmt>",
      "   </meiHead>",
      "</mei>",
      "",
    ].join("\n"),
  );
});

test("formatMei gives comments and processing instructions lines of their own", () => {
  const xml =
    "<!-- before --><mei><!-- in <mei> --><music><?pi x?><body/></music></mei><!-- after -->";
  assert.equal(
    formatMei(xml),
    [
      "<!-- before -->",
      "<mei>",
      "   <!-- in <mei> -->",
      "   <music>",
      "      <?pi x?>",
      "      <body/>",
      "   </music>",
      "</mei>",
      "<!-- after -->",
      "",
    ].join("\n"),
  );
});

test("formatMei returns a document it cannot read through unchanged", () => {
  for (const xml of [
    "<mei><music></body></mei>",
    "<mei><music></mei>",
    "<mei><music>",
    '<!DOCTYPE mei [<!ENTITY x "y">]><mei/>',
    "text<mei/>",
    "<mei/>text",
    "<mei><music attr='>'",
    "<!-- only a comment -->",
    "",
  ])
    assert.equal(formatMei(xml), xml, xml);
});

test("formatMei is idempotent", () => {
  const xml =
    '<?xml version="1.0"?>\n<mei><meiHead><fileDesc><titleStmt><title>T <rend>x</rend></title></titleStmt></fileDesc></meiHead><music/></mei>';
  const once = formatMei(xml);
  assert.equal(formatMei(once), once);
});

test("formatMei runs in linear time", () => {
  const measures =
    '<measure n="1"><staff><layer><note/></layer></staff></measure>'.repeat(
      50_000,
    );
  const xml = `<mei><music><section>${measures}</section></music></mei>`;
  const started = performance.now();
  const out = formatMei(xml);
  const elapsed = performance.now() - started;
  assert.equal(out.split("\n").length, 50_000 * 7 + 7);
  assert.ok(elapsed < 2000, `took ${Math.round(elapsed)} ms`);
});
