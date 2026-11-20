// Re-indenting an MEI document: each element on a line of its own, nested
// elements three spaces deeper (indent()). An element whose content holds
// text or a CDATA section, or that sets xml:space="preserve", is kept exactly
// as written and only moved to its line's indentation: whitespace inside it
// is part of its text. Comments and processing instructions between elements
// each take a line of their own. Tags are kept as written.
//
// A document the tokenizer cannot read through (a tag that does not end or
// does not match, a DOCTYPE, text outside the root) is returned unchanged.
// Pure string handling in linear time, no DOM: the coordinator formats every
// score it accepts.

import { preferAttributes } from "./mei-attributes.ts";
import { indent, tagsIn, type TagAt } from "./mei-xml.ts";

interface Element {
  start: TagAt;
  end: TagAt | null;
  /** Child elements, and comments and processing instructions as written. */
  children: (Element | string)[];
  /** Written out as it stands: holds text, or preserves its whitespace. */
  verbatim: boolean;
}

/**
 * The comments and processing instructions between two tags, and whether
 * text or a CDATA section lies there too; null for anything else that starts
 * with "<" (a DOCTYPE, or a tag the tokenizer could not read).
 */
function between(gap: string): { misc: string[]; text: boolean } | null {
  const misc: string[] = [];
  let text = false;
  for (let at = 0; at < gap.length; ) {
    const lt = gap.indexOf("<", at);
    if (gap.slice(at, lt < 0 ? gap.length : lt).trim()) text = true;
    if (lt < 0) break;
    const closer = gap.startsWith("<!--", lt)
      ? "-->"
      : gap.startsWith("<?", lt)
        ? "?>"
        : gap.startsWith("<![CDATA[", lt)
          ? "]]>"
          : null;
    if (!closer) return null;
    const close = gap.indexOf(closer, lt + 2);
    if (close < 0) return null;
    if (closer === "]]>") text = true;
    else misc.push(gap.slice(lt, close + closer.length));
    at = close + closer.length;
  }
  return { misc, text };
}

/** `xml` re-indented as described above, ending with a newline. */
export function formatMei(xml: string): string {
  const top: Element[] = [];
  const document: (Element | string)[] = [];
  const parentChildren = () =>
    top.length ? top[top.length - 1].children : document;
  let read = 0;
  for (const tag of tagsIn(xml)) {
    const gap = between(xml.slice(read, tag.start));
    if (!gap) return xml;
    if (gap.text) {
      if (!top.length) return xml;
      top[top.length - 1].verbatim = true;
    }
    parentChildren().push(...gap.misc);
    if (tag.kind === "end") {
      const element = top.pop();
      if (!element || element.start.name !== tag.name) return xml;
      element.end = tag;
    } else {
      const element: Element = {
        start: tag,
        end: null,
        children: [],
        verbatim: tag.attributes?.get("xml:space") === "preserve",
      };
      parentChildren().push(element);
      if (tag.kind === "start") top.push(element);
    }
    read = tag.end;
  }
  const rest = between(xml.slice(read));
  if (!rest || rest.text || top.length) return xml;
  document.push(...rest.misc);
  if (document.every((node) => typeof node === "string")) return xml;

  const lines: string[] = [];
  const write = (node: Element | string, depth: number): void => {
    if (typeof node === "string") {
      lines.push(indent(depth) + node);
      return;
    }
    const { start, end, children } = node;
    const startTag = xml.slice(start.start, start.end);
    if (!end) lines.push(indent(depth) + startTag);
    else if (node.verbatim)
      lines.push(indent(depth) + xml.slice(start.start, end.end));
    else if (!children.length)
      lines.push(indent(depth) + startTag + xml.slice(end.start, end.end));
    else {
      lines.push(indent(depth) + startTag);
      for (const child of children) write(child, depth + 1);
      lines.push(indent(depth) + xml.slice(end.start, end.end));
    }
  };
  for (const node of document) write(node, 0);
  return lines.join("\n") + "\n";
}

/** `xml` with attributes preferred over elements (preferAttributes), then re-indented. */
export const tidyMei = (xml: string): string =>
  formatMei(preferAttributes(xml));
