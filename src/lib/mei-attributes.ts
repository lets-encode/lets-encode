// Attributes over elements: where MEI offers an attribute for what a child
// element says, the child is written as that attribute of its parent.
//
//   <note><accid accid="f"/></note>         → <note accid="f"/>
//   <note><artic artic="stacc"/></note>     → <note artic="stacc"/> (chords too;
//                                             several become one list)
//   <staffDef><clef shape="G" line="2"/>    → clef.shape, clef.line, clef.dis, clef.dis.place
//   <scoreDef|staffDef><keySig sig="2s"/>   → keysig
//   <scoreDef|staffDef><meterSig …/>        → meter.count, meter.unit, meter.sym
//
// A child stays an element when it says more than the attribute can: any
// other attribute (accid@func, accid@enclose, keySig@mode, artic@place …),
// content of its own, an xml:id something in the document points to, or a
// parent that already sets the attribute. A note with more than one <accid>,
// and a parent with more than one <clef>, <keySig> or <meterSig>, keep theirs.
// A clef change inside a layer has no attribute form and is not touched.
// Pure string handling, no DOM.

import { elementsNamed, tagsIn, type TagAt } from "./mei-xml.ts";

interface Child {
  name: string;
  start: number;
  end: number;
  /** An empty-element tag: the child has no content. */
  empty: boolean;
  attributes: Map<string, string> | null;
}

/** The child elements of an element's content, in order. */
function childrenOf(inner: string): Child[] {
  const children: Child[] = [];
  let depth = 0;
  let open: TagAt | null = null;
  for (const tag of tagsIn(inner)) {
    if (tag.kind === "empty") {
      if (depth === 0)
        children.push({
          name: tag.name,
          start: tag.start,
          end: tag.end,
          empty: true,
          attributes: tag.attributes,
        });
    } else if (tag.kind === "start") {
      if (depth === 0) open = tag;
      depth++;
    } else if (--depth === 0 && open) {
      children.push({
        name: open.name,
        start: open.start,
        end: tag.end,
        empty: false,
        attributes: open.attributes,
      });
      open = null;
    }
  }
  return children;
}

/** The ids the document's attribute values point to ("#id"). */
function referencedIds(xml: string): Set<string> {
  const ids = new Set<string>();
  for (const tag of tagsIn(xml))
    for (const value of tag.attributes?.values() ?? [])
      for (const token of value.split(/\s+/))
        if (token.startsWith("#")) ids.add(token.slice(1));
  return ids;
}

/**
 * A child's attributes renamed for its parent by `names` (child attribute →
 * parent attribute), or null when the child says more than they can.
 */
function asParentAttributes(
  child: Child,
  names: Record<string, string>,
  referenced: Set<string>,
): [string, string][] | null {
  if (!child.empty || !child.attributes) return null;
  const out: [string, string][] = [];
  for (const [name, value] of child.attributes) {
    if (name === "xml:id") {
      if (referenced.has(value)) return null;
    } else if (names[name]) out.push([names[name], value]);
    else return null;
  }
  return out;
}

type Rule = {
  child: string;
  names: Record<string, string>;
  /** Several such children merge into one space-separated value. */
  list?: boolean;
};

const ACCID: Rule = {
  child: "accid",
  names: { accid: "accid", "accid.ges": "accid.ges" },
};
const ARTIC: Rule = { child: "artic", names: { artic: "artic" }, list: true };
const CLEF: Rule = {
  child: "clef",
  names: {
    shape: "clef.shape",
    line: "clef.line",
    dis: "clef.dis",
    "dis.place": "clef.dis.place",
  },
};
const KEY: Rule = { child: "keySig", names: { sig: "keysig" } };
const METER: Rule = {
  child: "meterSig",
  names: { count: "meter.count", unit: "meter.unit", sym: "meter.sym" },
};

/** Each `parent` element of `xml` with the children `rules` cover moved into its start tag. */
function moveChildren(
  xml: string,
  parent: string,
  rules: Rule[],
  referenced: Set<string>,
): string {
  let out = "";
  let read = 0;
  for (const element of elementsNamed(xml, parent, true)) {
    if (element.tag.endsWith("/>")) continue;
    const own = tagsIn(element.tag).next().value?.attributes;
    if (!own) continue;
    const children = childrenOf(element.inner);
    const removed: Child[] = [];
    const added: [string, string][] = [];
    for (const rule of rules) {
      const matching = children.filter((c) => c.name === rule.child);
      if (!matching.length || (!rule.list && matching.length > 1)) continue;
      const moved = matching.map((c) =>
        asParentAttributes(c, rule.names, referenced),
      );
      if (moved.some((m) => m === null)) continue;
      const pairs = moved.flat() as [string, string][];
      const targets = new Set(pairs.map(([name]) => name));
      if ([...targets].some((name) => own.has(name))) continue;
      for (const name of targets)
        added.push([
          name,
          pairs
            .filter(([n]) => n === name)
            .map(([, v]) => v)
            .join(" "),
        ]);
      removed.push(...matching);
    }
    if (!removed.length) continue;
    let inner = "";
    let at = 0;
    for (const child of removed.sort((a, b) => a.start - b.start)) {
      inner += element.inner.slice(at, child.start).replace(/\s+$/, "");
      at = child.end;
    }
    inner += element.inner.slice(at);
    const attributes = added.map(([n, v]) => ` ${n}="${v}"`).join("");
    const startTag = element.tag.replace(/\s*>$/, `${attributes}>`);
    const end = `</${parent}>`;
    out +=
      xml.slice(read, element.start) +
      (inner.trim() ? startTag + inner + end : startTag.replace(/>$/, "/>"));
    read = element.end;
  }
  return read ? out + xml.slice(read) : xml;
}

/** `xml` with the child elements described above written as attributes. */
export function preferAttributes(xml: string): string {
  const referenced = referencedIds(xml);
  let out = moveChildren(xml, "note", [ACCID, ARTIC], referenced);
  out = moveChildren(out, "chord", [ARTIC], referenced);
  out = moveChildren(out, "staffDef", [CLEF, KEY, METER], referenced);
  return moveChildren(out, "scoreDef", [KEY, METER], referenced);
}
