// Read-only view of a score's <meiHead>, for display in the campaign console.
// Same conventions as mei-facsimile.ts: pure regex/string parsing, no DOM,
// filesystem or network access.

import {
  elementsNamedAny,
  firstElementNamed,
  tagAttribute,
  textOf,
} from "./mei-xml.ts";
import { parseSourceHead } from "./source-metadata.ts";

/** One named person from the header, with the role the header assigns them. */
export interface HeaderPerson {
  name: string;
  role: string;
}

/** The header fields the console displays. */
export interface MeiHeader {
  title: string;
  composer: string;
  /** persName/corpName entries other than the composer. */
  contributors: HeaderPerson[];
}

// How specific a role is, for keeping one entry per person. A named role
// (editor, encoder, …) beats the generic "contributor", which beats a
// persName carrying no role at all.
function roleRank(role: string): number {
  if (role === "composer") return 3;
  if (role === "contributor") return 1;
  return role ? 2 : 0;
}

/**
 * Parse the display fields out of a score's <meiHead>. Returns null when the
 * text has no header. The title and the composer are read as the metadata
 * form reads them (parseSourceHead). People are collected from every
 * persName/corpName element in the header — a header names the same person
 * in several places (title statement, manifestation, revisionDesc changes),
 * so entries are deduplicated by name, each person keeping their most
 * specific role; everyone but the composer is a contributor.
 */
export function parseMeiHeader(mei: string): MeiHeader | null {
  const head = firstElementNamed(mei, "meiHead")?.inner;
  if (head === undefined) return null;

  const { title, composer } = parseSourceHead(mei);

  const people: HeaderPerson[] = [];
  const byName = new Map<string, HeaderPerson>();
  for (const element of elementsNamedAny(head, ["persName", "corpName"])) {
    const role = tagAttribute(element.tag, "role") ?? "";
    const name = textOf(element.inner);
    if (!name) continue;
    const known = byName.get(name);
    if (!known) {
      const person = { name, role };
      byName.set(name, person);
      people.push(person);
    } else if (roleRank(role) > roleRank(known.role)) {
      known.role = role;
    }
  }

  const contributors = people.filter((person) => person.name !== composer);
  return { title, composer, contributors };
}
