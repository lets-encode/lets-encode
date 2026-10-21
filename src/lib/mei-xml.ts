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

/** A start tag startTags found: where it is and its text. */
export interface StartTag {
  /** Offset of the "<". */
  start: number;
  /** "<name …>", up to the first ">". */
  tag: string;
}

/**
 * The start tags of the elements called `name` in `xml` from offset `from`,
 * in document order, as the pattern `<name\b[^>]*>` matches them globally,
 * found in linear time.
 */
export function* startTags(
  xml: string,
  name: string,
  from = 0,
): Generator<StartTag> {
  const open = new RegExp(`<${escapeRegex(name)}\\b`, "g");
  open.lastIndex = from;
  for (let m = open.exec(xml); m; m = open.exec(xml)) {
    const tagEnd = xml.indexOf(">", m.index);
    if (tagEnd < 0) return;
    yield { start: m.index, tag: xml.slice(m.index, tagEnd + 1) };
    open.lastIndex = tagEnd + 1;
  }
}

/** A tag tagsIn found: its name and kind, where it is, and its attributes. */
export interface TagAt {
  /** The element name as written, a prefix included. */
  name: string;
  /** "empty" for an empty-element tag, "<name …/>". */
  kind: "start" | "end" | "empty";
  /** Offset of the "<". */
  start: number;
  /** Offset just after the ">". */
  end: number;
  /**
   * The attributes by name, values as written (entities not resolved); null
   * when the tag holds anything but name="value" and name='value' pairs.
   */
  attributes: Map<string, string> | null;
}

const ATTRIBUTE = /\s*([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

function attributesOf(text: string): Map<string, string> | null {
  const attributes = new Map<string, string>();
  let read = 0;
  ATTRIBUTE.lastIndex = 0;
  for (let m = ATTRIBUTE.exec(text); m; m = ATTRIBUTE.exec(text)) {
    attributes.set(m[1], m[2] ?? m[3]);
    read = ATTRIBUTE.lastIndex;
  }
  return text.slice(read).trim() === "" ? attributes : null;
}

/**
 * The tags of `xml` from offset `from`, in document order, found in linear
 * time. Comments, CDATA sections, processing instructions and declarations
 * hold no tags; a tag ends at the first ">" outside quotes. The scan stops at
 * a comment, section or tag that does not end.
 */
export function* tagsIn(xml: string, from = 0): Generator<TagAt> {
  for (let at = xml.indexOf("<", from); at >= 0; ) {
    const skipTo = xml.startsWith("<!--", at)
      ? "-->"
      : xml.startsWith("<![CDATA[", at)
        ? "]]>"
        : xml.startsWith("<?", at)
          ? "?>"
          : xml.startsWith("<!", at)
            ? ">"
            : null;
    if (skipTo) {
      const close = xml.indexOf(skipTo, at + 2);
      if (close < 0) return;
      at = xml.indexOf("<", close + skipTo.length);
      continue;
    }
    let end = at + 1;
    for (let quote = ""; end < xml.length; end++) {
      const c = xml[end];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (end >= xml.length) return;
    const text = xml.slice(at + 1, end);
    const kind = text.startsWith("/")
      ? "end"
      : text.endsWith("/")
        ? "empty"
        : "start";
    const body =
      kind === "end"
        ? text.slice(1)
        : kind === "empty"
          ? text.slice(0, -1)
          : text;
    const name = /^[^\s/>]*/.exec(body)![0];
    yield {
      name,
      kind,
      start: at,
      end: end + 1,
      attributes:
        kind === "end" ? new Map() : attributesOf(body.slice(name.length)),
    };
    at = xml.indexOf("<", end + 1);
  }
}

/**
 * The elements called any of `names`, in document order, as a global pattern
 * such as `<(a|b)\b[^>]*>[\s\S]*?</\1>` matches them: each start tag with the
 * first end tag of its own name after it, scanning on after that end tag.
 * Found in linear time.
 */
export function elementsNamedAny(xml: string, names: string[]): ElementAt[] {
  const open = new RegExp(`<(${names.map(escapeRegex).join("|")})\\b`, "g");
  // A name with no end tag after some point has none after any later point.
  const unclosed = new Set<string>();
  const elements: ElementAt[] = [];
  let tagEnd = -1;
  for (let m = open.exec(xml); m; m = open.exec(xml)) {
    const name = m[1];
    if (unclosed.has(name)) continue;
    if (tagEnd < m.index) tagEnd = xml.indexOf(">", m.index);
    if (tagEnd < 0) break;
    const close = `</${name}>`;
    const closeAt = xml.indexOf(close, tagEnd + 1);
    if (closeAt < 0) {
      unclosed.add(name);
      continue;
    }
    const end = closeAt + close.length;
    elements.push({
      start: m.index,
      end,
      tag: xml.slice(m.index, tagEnd + 1),
      inner: xml.slice(tagEnd + 1, closeAt),
    });
    open.lastIndex = end;
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
