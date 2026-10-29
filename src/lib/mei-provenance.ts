// Provenance of an accepted contribution, written into a score's <meiHead>:
// a <change> in <revisionDesc>, the contributor among the file's
// responsibility statements, and the editing application in <appInfo>.
//
// Applied by the campaign coordinator to the assembled MEI before the schema
// check, so a header this module writes is held to the same standard as the
// rest of the file. Same conventions as source-metadata.ts: pure regex and
// string handling, no DOM, filesystem or network access.

import {
  elementsNamed,
  escapeRegex,
  firstElementNamed,
  indent,
  startTags,
  stripTags,
  xmlEscape,
  xmlUnescape,
} from "./mei-xml.ts";

/** One accepted contribution, as recorded in the header. */
export interface Contribution {
  /** The contributor's name, e.g. a GitHub login. */
  name: string;
  /** What changed, one line — e.g. a commit message's first line. */
  message: string;
  /** When, as an ISO 8601 date or timestamp. */
  isodate: string;
  /** The editing application's name, when known. */
  application?: string;
}

/** Insert `addition` into `xml` directly before the first `closer`. */
function insertBefore(xml: string, closer: string, addition: string): string {
  const at = xml.indexOf(closer);
  return xml.slice(0, at) + addition + xml.slice(at);
}

/** The contributor among the file's responsibility statements, added once. */
function withContributor(head: string, name: string): string {
  const fileDesc = firstElement(head, "fileDesc");
  if (!fileDesc) return head;
  const titleStmt = firstElement(fileDesc.text, "titleStmt");
  if (!titleStmt) return head;

  // Already named in the file's title statement (in any role): nothing to add.
  const named = [...elementsNamed(titleStmt.text, "persName")].some(
    (persName) =>
      stripTags(persName.inner).replace(/\s+/g, " ").trim() === name,
  );
  if (named) return head;

  const entry = `${indent(5)}<persName role="contributor">${xmlEscape(name)}</persName>\n`;
  const updated = titleStmt.text.includes("</respStmt>")
    ? insertBefore(titleStmt.text, "</respStmt>", entry)
    : insertBefore(
        titleStmt.text,
        "</titleStmt>",
        `${indent(4)}<respStmt>\n${entry}${indent(4)}</respStmt>\n${indent(3)}`,
      );
  // The title statement's own place: an identical copy may come earlier, in
  // a comment.
  const at = fileDesc.index + titleStmt.index;
  return head.slice(0, at) + updated + head.slice(at + titleStmt.text.length);
}

/** The xml:id an application called `name` gets in <appInfo>. */
export function applicationId(name: string): string {
  return `app-${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unnamed"
  }`;
}

/** The application among <appInfo>'s entries, added once (matched by name). */
function withApplication(head: string, name: string): string {
  // Present: some <name> start tag followed by the name and an end tag.
  const recorded = new RegExp(`\\s*${escapeRegex(name)}\\s*</name>`, "y");
  for (const { start, tag } of startTags(head, "name")) {
    recorded.lastIndex = start + tag.length;
    if (recorded.test(head)) return head;
  }

  const application =
    `${indent(4)}<application xml:id="${applicationId(name)}">\n` +
    `${indent(5)}<name>${xmlEscape(name)}</name>\n` +
    `${indent(4)}</application>\n`;

  if (head.includes("</appInfo>"))
    return insertBefore(head, "</appInfo>", application);
  const appInfo = `${indent(3)}<appInfo>\n${application}${indent(3)}</appInfo>\n`;
  const encodingDesc = /<encodingDesc\b[^>]*>/.exec(head);
  // <appInfo> is <encodingDesc>'s first child. Without an <encodingDesc>, one
  // is added at its place among <meiHead>'s children: right after <fileDesc>.
  if (encodingDesc) {
    const at = encodingDesc.index + encodingDesc[0].length;
    return head.slice(0, at) + `\n${appInfo}${indent(2)}` + head.slice(at);
  }
  // Function replacement: `appInfo` carries user text, which must not be read for $-patterns.
  return head.replace(
    "</fileDesc>",
    () =>
      `</fileDesc>\n${indent(2)}<encodingDesc>\n${appInfo}${indent(2)}</encodingDesc>`,
  );
}

/** A <change> appended to <revisionDesc>, numbered after the existing ones. */
function withChange(head: string, c: Contribution): string {
  const n = [...head.matchAll(/<change\b/g)].length + 1;
  const change =
    `${indent(3)}<change n="${n}" isodate="${xmlEscape(c.isodate)}">\n` +
    `${indent(4)}<respStmt>\n` +
    `${indent(5)}<persName>${xmlEscape(c.name)}</persName>\n` +
    `${indent(4)}</respStmt>\n` +
    `${indent(4)}<changeDesc>\n` +
    `${indent(5)}<p>${xmlEscape(c.message)}</p>\n` +
    `${indent(4)}</changeDesc>\n` +
    `${indent(3)}</change>\n`;
  if (head.includes("</revisionDesc>"))
    return insertBefore(head, "</revisionDesc>", change);
  // <revisionDesc> is <meiHead>'s last child.
  return insertBefore(
    head,
    "</meiHead>",
    `${indent(2)}<revisionDesc>\n${change}${indent(2)}</revisionDesc>\n${indent(1)}`,
  );
}

/**
 * The first element called `name`, with its offset, found in linear time
 * (firstElementNamed): scores come from forks.
 */
function firstElement(
  xml: string,
  name: string,
): { index: number; text: string } | null {
  const element = firstElementNamed(xml, name);
  return element
    ? { index: element.start, text: xml.slice(element.start, element.end) }
    : null;
}

/** The application names a document's header records in <appInfo>, in order. */
export function applicationNamesIn(mei: string): string[] {
  const head = firstElement(mei, "meiHead")?.text ?? "";
  const appInfo = firstElement(head, "appInfo")?.text ?? "";
  return [...elementsNamed(appInfo, "application")].flatMap((application) => {
    // The first <name> of each application, when it holds only text.
    const name = firstElementNamed(application.inner, "name")?.inner;
    return name === undefined || name.includes("<")
      ? []
      : [xmlUnescape(name.trim())];
  });
}

/**
 * Record applications in the score's <appInfo>, each once, matched by name.
 * The score is returned unchanged when it has no <meiHead>.
 */
export function recordApplications(mei: string, names: string[]): string {
  const match = firstElement(mei, "meiHead");
  if (!match) return mei;
  let head = match.text;
  for (const name of names)
    if (name.trim()) head = withApplication(head, name.trim());
  return (
    mei.slice(0, match.index) +
    head +
    mei.slice(match.index + match.text.length)
  );
}

/**
 * Record a contribution in the score's header. The score is returned unchanged
 * when it has no <meiHead>.
 */
export function recordContribution(mei: string, c: Contribution): string {
  const match = firstElement(mei, "meiHead");
  if (!match) return mei;
  const name = c.name.trim();
  const message = (
    c.message.split("\n", 1)[0] || "Contribution accepted."
  ).trim();

  let head = match.text;
  if (name) head = withContributor(head, name);
  if (c.application?.trim()) head = withApplication(head, c.application.trim());
  head = withChange(head, { ...c, name, message });
  return (
    mei.slice(0, match.index) +
    head +
    mei.slice(match.index + match.text.length)
  );
}
