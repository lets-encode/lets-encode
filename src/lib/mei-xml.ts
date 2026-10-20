// Shared string helpers for the MEI modules. Pure string handling, no DOM,
// filesystem or network access.

/**
 * Escape the minimum needed to keep substituted values well-formed XML, in
 * text and double-quoted attribute contexts.
 */
export function xmlEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Unescape the five predefined XML entities. `&amp;` last, so it never doubles. */
export function xmlUnescape(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * `text` with each tag (a "<" up to the next ">") replaced by a space, as
 * `/<[^>]*>/g` replaces them, in linear time: after the last ">" no "<" can
 * start a tag, and before it every "<" does.
 */
export function stripTags(text: string): string {
  const end = text.lastIndexOf(">") + 1;
  return text.slice(0, end).replace(/<[^>]*>/g, " ") + text.slice(end);
}

/** An element's readable text: nested tags stripped, whitespace collapsed. */
export const textOf = (inner: string): string =>
  xmlUnescape(stripTags(inner).replace(/\s+/g, " ").trim());

/** Indentation at `depth` levels of three spaces. */
export const indent = (depth: number): string => " ".repeat(depth * 3);

/** An element elementsNamed found: where it is, its start tag and its content. */
export interface ElementAt {
  /** Offset of the start tag's "<". */
  start: number;
  /** Offset just after the end tag, or after an empty-element tag's "/>". */
  end: number;
  /** The start tag, "<name …>" or "<name …/>". */
  tag: string;
  /** The text between the start tag and the end tag; "" for an empty tag. */
  inner: string;
}

/**
 * The elements called `name` in `xml`, in document order, found in linear
 * time: each start tag (`<name` at a word boundary, up to the next ">") and
 * the first `</name>` after it, as the lazy pattern
 * `<name\b[^>]*>[\s\S]*?</name>` matches them. With `emptyTags`, a start tag
 * ending in "/>" is an element of its own, as in `<name\b[^>]*\/>|…`. Scanning
 * resumes after each element. It stops at a start tag with no ">" after it,
 * and without `emptyTags` at one with no end tag after it; with `emptyTags`,
 * only empty-element tags are elements from there on.
 */
export function* elementsNamed(
  xml: string,
  name: string,
  emptyTags = false,
): Generator<ElementAt> {
  const open = new RegExp(`<${escapeRegex(name)}\\b`, "g");
  const close = `</${name}>`;
  let closed = true;
  // A start tag ends at the first ">" after its "<", so one search serves
  // every start tag before that ">".
  let tagEnd = -1;
  for (let m = open.exec(xml); m; m = open.exec(xml)) {
    if (tagEnd < m.index) tagEnd = xml.indexOf(">", m.index);
    if (tagEnd < 0) return;
    if (emptyTags && xml[tagEnd - 1] === "/") {
      const tag = xml.slice(m.index, tagEnd + 1);
      yield { start: m.index, end: tagEnd + 1, tag, inner: "" };
      open.lastIndex = tagEnd + 1;
    } else if (closed) {
      const closeAt = xml.indexOf(close, tagEnd + 1);
      if (closeAt < 0) {
        if (!emptyTags) return;
        closed = false;
        continue;
      }
      const end = closeAt + close.length;
      const tag = xml.slice(m.index, tagEnd + 1);
      yield { start: m.index, end, tag, inner: xml.slice(tagEnd + 1, closeAt) };
      open.lastIndex = end;
    }
  }
}

/**
 * The start tags of the elements called `name` in `xml`, in document order,
 * as the pattern `<name\b[^>]*>` matches them globally, found in linear time.
 */
export function* startTags(xml: string, name: string): Generator<string> {
  const open = new RegExp(`<${escapeRegex(name)}\\b`, "g");
  for (let m = open.exec(xml); m; m = open.exec(xml)) {
    const tagEnd = xml.indexOf(">", m.index);
    if (tagEnd < 0) return;
    yield xml.slice(m.index, tagEnd + 1);
    open.lastIndex = tagEnd + 1;
  }
}

/**
 * The elements called any of `names`, in document order, as a global pattern
 * such as `<(a|b)\b[^>]*>[\s\S]*?</\1>` matches them: one that starts inside
 * another is not counted. Found in linear time.
 */
export function elementsNamedAny(xml: string, names: string[]): ElementAt[] {
  const found = names
    .flatMap((name) => [...elementsNamed(xml, name)])
    .sort((a, b) => a.start - b.start);
  const elements: ElementAt[] = [];
  for (const element of found) {
    if (element.start >= (elements.at(-1)?.end ?? 0)) elements.push(element);
  }
  return elements;
}

/** The first element elementsNamed finds, or null. */
export function firstElementNamed(
  xml: string,
  name: string,
  emptyTags = false,
): ElementAt | null {
  for (const element of elementsNamed(xml, name, emptyTags)) return element;
  return null;
}

/** Escape a value so a RegExp built from it matches it literally. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
