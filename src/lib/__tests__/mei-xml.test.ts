import { test } from "node:test";
import assert from "node:assert/strict";
import {
  elementsNamed,
  elementsNamedAny,
  escapeRegex,
  indent,
  startTags,
  stripTags,
  tagsIn,
  textOf,
  xmlEscape,
  xmlUnescape,
} from "../mei-xml.ts";

test("xmlEscape covers text and double-quoted attribute contexts", () => {
  assert.equal(
    xmlEscape(`a & <b> "c" d'un`),
    "a &amp; &lt;b&gt; &quot;c&quot; d'un",
  );
  assert.equal(xmlEscape(null), "");
  assert.equal(xmlEscape(42), "42");
});

test("xmlUnescape covers all five predefined entities", () => {
  assert.equal(
    xmlUnescape("&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;"),
    `<a> & "b" 'c'`,
  );
});

test("escape and unescape are inverse over markup-significant text", () => {
  const value = `<x a="1">&'"</x>`;
  assert.equal(xmlUnescape(xmlEscape(value)), value);
  // Already-escaped entities survive the round trip undoubled.
  assert.equal(xmlEscape(xmlUnescape("&amp;lt;")), "&amp;lt;");
});

test("textOf strips tags, collapses whitespace and unescapes", () => {
  assert.equal(
    textOf("  J. <hi>S.</hi>\n  Bach &amp; Co  "),
    "J. S. Bach & Co",
  );
});

test("indent is three spaces per depth", () => {
  assert.equal(indent(0), "");
  assert.equal(indent(2), "      ");
});

test("escapeRegex makes a value match itself literally", () => {
  const value = "a.b$c[d]";
  assert.ok(new RegExp(`^${escapeRegex(value)}$`).test(value));
});

test("elementsNamed goes on finding empty-element tags after a start tag with no end tag", () => {
  const xml = `<g><!-- one <a> each --><a n="1"/><a n="2"/></g>`;
  assert.deepEqual(
    [...elementsNamed(xml, "a", true)].map((a) => a.tag),
    ['<a n="1"/>', '<a n="2"/>'],
  );
  assert.deepEqual([...elementsNamed(xml, "a")], []);
});

test("elementsNamedAny counts an element inside another once, with the outer one", () => {
  const xml =
    "<x><corpName>A <persName>B</persName></corpName><persName>C</persName></x>";
  assert.deepEqual(
    elementsNamedAny(xml, ["persName", "corpName"]).map((e) => e.inner),
    ["A <persName>B</persName>", "C"],
  );
  // Each start tag takes the first end tag of its own name, as the pattern
  // <(persName|corpName)\b[^>]*>[\s\S]*?</\1> does.
  const nested =
    '<persName role="composer">A <corpName>B <persName>C</persName> D <corpName role="lyricist">E</corpName> F</corpName> G</persName>';
  assert.deepEqual(
    elementsNamedAny(nested, ["persName", "corpName"]).map((e) => e.inner),
    ["A <corpName>B <persName>C", "E"],
  );
});

test("tagsIn reads tags outside comments, in either quote style", () => {
  const xml = `<a x='1' y = "2"><!-- <b/> --><![CDATA[<c/>]]><d e=">"/></a>`;
  assert.deepEqual(
    [...tagsIn(xml)].map((t) => [
      t.name,
      t.kind,
      Object.fromEntries(t.attributes ?? []),
    ]),
    [
      ["a", "start", { x: "1", y: "2" }],
      ["d", "empty", { e: ">" }],
      ["a", "end", {}],
    ],
  );
  assert.equal([...tagsIn("<a x=1>")][0].attributes, null);
});

test("stripTags keeps a < that no > follows", () => {
  assert.equal(stripTags("a<b>c<d"), "a c<d");
});

test("the scanners take linear time on start tags that never close", () => {
  const run = (name: string) => `<${name} `.repeat(200_000);
  const started = performance.now();
  [...elementsNamed(run("a"), "a", true)];
  [...startTags(run("a"), "a")];
  elementsNamedAny(`${run("a")}>`, ["a", "b"]);
  stripTags(`${"<".repeat(1_000_000)}`);
  textOf(`${"<b ".repeat(200_000)}</b>`);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `took ${Math.round(elapsed)} ms`);
});
