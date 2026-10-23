// Joining per-page encoding into the shared score. A facsimile campaign splits
// encoding into one task per page (locator `surface-N`); every volunteer edits
// a copy of the whole `sources/score.mei`, but a page task's accepted PR must
// contribute only that page's notation, leaving the other pages as they stand
// in the base file. Pure functions: MEI text in, MEI text out. No DOM,
// filesystem or network access.
//
// A page's extent is delimited by the `<pb/>` markers written at stage C
// (mei-facsimile.ts): the page's `<pb facs="#surface-N"/>` opens it and the
// next page's `<pb/>` (or the end of the enclosing element, on the last page)
// closes it. The join keeps the base file verbatim outside that span and takes
// the fork's span content wholesale, so everything the volunteer wrote inside
// their page — measures, a mid-piece <scoreDef>, added or removed measures —
// lands in the base. The base's own `<pb/>` markers stay authoritative: which
// surface follows the page comes from the base's page order, both spans are
// delimited by the same facs-matched `<pb>` elements, and the result is
// checked afterwards (assertSpliceIntegrity) so a fork that smuggles in a
// page break or a duplicate measure is rejected rather than merged.

import { tagsIn } from "./mei-xml.ts";
import {
  CHECKED_STAFF_FIELDS,
  parseScoreDef,
  replaceOpeningScoreDef,
  type ScoreDefModel,
  type StaffModel,
} from "./mei-facsimile.ts";

/**
 * The `<pb>` tags of `xml` from offset `from`, outside comments, with the
 * surface each names ("surface-N" from facs="#surface-N"), or null when it
 * names none or its attributes cannot be read.
 */
function* pageBreaks(
  xml: string,
  from = 0,
): Generator<{ start: number; end: number; surface: string | null }> {
  for (const tag of tagsIn(xml, from)) {
    if (tag.name !== "pb" || tag.kind === "end") continue;
    const facs = tag.attributes?.get("facs") ?? "";
    yield {
      start: tag.start,
      end: tag.end,
      surface: facs.startsWith("#") ? facs.slice(1) : null,
    };
  }
}

/** The first `<pb>` for `surfaceId` at or after `from`. */
function pbTagAt(
  xml: string,
  surfaceId: string,
  from = 0,
): { start: number; end: number } | null {
  for (const pb of pageBreaks(xml, from))
    if (pb.surface === surfaceId) return pb;
  return null;
}

/**
 * The page's span with its offsets: from `surfaceId`'s `<pb>` to
 * `nextSurfaceId`'s, or — for the last page (`nextSurfaceId` null) — to the
 * close of the enclosing element. Ending at the next surface's own marker
 * rather than at just any `<pb>` keeps a stray page break inside the span,
 * where the integrity checks see it, instead of silently truncating there.
 */
function pageSpanAt(
  xml: string,
  surfaceId: string,
  nextSurfaceId: string | null,
): { from: number; to: number } {
  const pb = pbTagAt(xml, surfaceId);
  if (!pb) throw new Error(`No page break found for ${surfaceId}.`);
  const from = pb.end;
  if (nextSurfaceId === null) return { from, to: closeOfEnclosure(xml, from) };
  const next = pbTagAt(xml, nextSurfaceId, from);
  if (!next) throw new Error(`No page break found for ${nextSurfaceId}.`);
  return { from, to: next.start };
}

// A span that runs to the end of the body must not swallow the enclosing
// section/score markup: it closes at the matching close of the element
// enclosing it. <section>/<mdiv> elements opened inside the span are tracked
// by depth, so a nested section's close does not end the span early.
function closeOfEnclosure(xml: string, from: number): number {
  let depth = 0;
  for (const tag of tagsIn(xml, from)) {
    if (tag.name !== "section" && tag.name !== "mdiv") continue;
    if (tag.kind === "start") depth++;
    else if (tag.kind === "empty") continue;
    else if (depth === 0) return tag.start;
    else depth--;
  }
  return xml.length;
}

/** Every `<pb>` facs target ("surface-N") in `xml`, in document order. */
function pbSurfaces(xml: string): string[] {
  return [...pageBreaks(xml)].flatMap((pb) =>
    pb.surface === null ? [] : [pb.surface],
  );
}

/** How many `<pb>` tags of `xml` name no surface. */
function unplacedPageBreaks(xml: string): number {
  return [...pageBreaks(xml)].filter((pb) => pb.surface === null).length;
}

/**
 * Assert the structural invariants a page splice must keep: the result carries
 * exactly the base's `<pb>` markers (one per surface, none smuggled in or
 * lost), and no measure xml:id appears twice document-wide. Throws a
 * descriptive Error on the first violation; the checks are what turn a fork
 * that would silently corrupt the score into a loud rejection.
 */
function assertSpliceIntegrity(
  baseMei: string,
  splicedMei: string,
  locator: string,
): void {
  const baseSurfaces = new Set(pbSurfaces(baseMei));
  const counts = new Map<string, number>();
  for (const surface of pbSurfaces(splicedMei)) {
    counts.set(surface, (counts.get(surface) ?? 0) + 1);
  }
  for (const [surface, count] of counts) {
    if (!baseSurfaces.has(surface)) {
      throw new Error(
        `Splicing ${locator} introduced a page break for ${surface} the base score does not have.`,
      );
    }
    if (count > 1) {
      throw new Error(
        `${count} page breaks for ${surface} after splicing ${locator}.`,
      );
    }
  }
  for (const surface of baseSurfaces) {
    if (!counts.has(surface)) {
      throw new Error(
        `The page break for ${surface} is missing after splicing ${locator}.`,
      );
    }
  }

  if (unplacedPageBreaks(splicedMei) > unplacedPageBreaks(baseMei)) {
    throw new Error(
      `Splicing ${locator} introduced a page break that names no surface.`,
    );
  }

  const measureIds = new Set<string>();
  for (const tag of tagsIn(splicedMei)) {
    if (tag.name !== "measure" || tag.kind === "end") continue;
    if (tag.attributes === null) {
      throw new Error(
        `A measure's attributes cannot be read after splicing ${locator}.`,
      );
    }
    const id = tag.attributes.get("xml:id");
    if (id === undefined) continue;
    if (measureIds.has(id)) {
      throw new Error(
        `Duplicate measure xml:id "${id}" after splicing ${locator}.`,
      );
    }
    measureIds.add(id);
  }
}

/** Replace the base's page span with the fork's, both delimited by `locator`'s `<pb>`. */
function spliceSpan(baseMei: string, forkMei: string, locator: string): string {
  // Which surface follows the page is the base's to say.
  const surfaces = pbSurfaces(baseMei);
  const at = surfaces.indexOf(locator);
  const nextSurface = at === -1 ? null : (surfaces[at + 1] ?? null);
  const base = pageSpanAt(baseMei, locator, nextSurface);
  const fork = pageSpanAt(forkMei, locator, nextSurface);
  const spliced =
    baseMei.slice(0, base.from) +
    forkMei.slice(fork.from, fork.to) +
    baseMei.slice(base.to);
  assertSpliceIntegrity(baseMei, spliced, locator);
  return spliced;
}

/**
 * The xml:id of the element to select when opening `locator`'s page
 * (`surface-N`): its first note, or its first measure if it has no note with an
 * xml:id. Null if the page has no `<pb>` or neither element.
 */
export function firstElementOfPage(
  mei: string,
  locator: string,
): string | null {
  const surfaces = pbSurfaces(mei);
  const at = surfaces.indexOf(locator);
  if (at === -1) return null;
  const { from, to } = pageSpanAt(mei, locator, surfaces[at + 1] ?? null);
  const tags = [...tagsIn(mei.slice(from, to))];
  for (const name of ["note", "measure"]) {
    const id = tags
      .find(
        (tag) =>
          tag.name === name &&
          tag.kind !== "end" &&
          tag.attributes?.has("xml:id"),
      )
      ?.attributes?.get("xml:id");
    if (id !== undefined) return id;
  }
  return null;
}

/**
 * Splice the fork's encoding of one page into the base score. `locator` is the
 * page's `surface-N` id; the base's span for that page is replaced by the
 * fork's span content wholesale, and everything outside it is preserved from
 * the base. Throws if either side is missing the page break or the result
 * fails the integrity checks (assertSpliceIntegrity).
 */
export function splicePage(
  baseMei: string,
  forkMei: string,
  locator: string,
): string {
  return spliceSpan(baseMei, forkMei, locator);
}

/**
 * Splice the fork's encoding of one page into the base score by replacing the
 * page's whole `<pb>` span with the fork's. Used for physical pieces, whose
 * pages hold no fixed measure grid — the encoder transcribes from the source,
 * so measures are theirs to add and number and the page's content is taken
 * wholesale. Both files must carry the page's `<pb facs="#surface-N"/>`
 * marker; everything outside the span is kept from the base verbatim, so
 * per-page tasks still cannot touch each other's pages.
 */
export function splicePageSpan(
  baseMei: string,
  forkMei: string,
  locator: string,
): string {
  return spliceSpan(baseMei, forkMei, locator);
}

/** A staff without the fields a check of the opening score definition may change. */
function unchecked(staff: StaffModel): Partial<StaffModel> {
  const rest: Partial<StaffModel> = { ...staff };
  for (const field of CHECKED_STAFF_FIELDS) delete rest[field];
  return rest;
}

/**
 * Why the fork's opening score definition may not replace the base's, or
 * null when it may: the two differ at most in the staves' clefs, own key
 * signatures and transpositions (CHECKED_STAFF_FIELDS), the key and the
 * meter. Staves, their ids, names and layers, and the groups stay.
 */
export function openingScoreDefChange(
  base: ScoreDefModel,
  fork: ScoreDefModel,
): string | null {
  if (fork.staves.length !== base.staves.length)
    return `the score has ${base.staves.length} staves, the submission ${fork.staves.length}`;
  const changed = base.staves.findIndex(
    (staff, i) =>
      JSON.stringify(unchecked(staff)) !==
      JSON.stringify(unchecked(fork.staves[i])),
  );
  if (changed >= 0)
    return `staff ${changed + 1} changes more than its clef, key signature or transposition`;
  if (JSON.stringify(base.groups) !== JSON.stringify(fork.groups))
    return "the staff groups change";
  return null;
}

/**
 * The base score with the fork's opening score definition, which may change
 * only what openingScoreDefChange allows; a movement's copy of it follows
 * (replaceOpeningScoreDef). Unchanged, the base is returned as it is. Throws
 * with the reason for any other change.
 */
export function spliceOpeningScoreDef(
  baseMei: string,
  forkMei: string,
): string {
  const base = parseScoreDef(baseMei);
  const fork = parseScoreDef(forkMei);
  const reason = openingScoreDefChange(base, fork);
  if (reason)
    throw new Error(
      `The score definition may change only in clefs, key signatures, meter and transpositions: ${reason}.`,
    );
  const same =
    base.keysig === fork.keysig &&
    base.meterCount === fork.meterCount &&
    base.meterUnit === fork.meterUnit &&
    base.meterSym === fork.meterSym &&
    base.staves.every((staff, i) =>
      CHECKED_STAFF_FIELDS.every(
        (field) => staff[field] === fork.staves[i][field],
      ),
    );
  if (same) return baseMei;
  return replaceOpeningScoreDef(baseMei, {
    ...base,
    keysig: fork.keysig,
    meterCount: fork.meterCount,
    meterUnit: fork.meterUnit,
    meterSym: fork.meterSym,
    staves: base.staves.map((staff, i) => {
      const checked: Record<string, unknown> = { ...staff };
      for (const field of CHECKED_STAFF_FIELDS) {
        const value = fork.staves[i][field];
        if (value === undefined) delete checked[field];
        else checked[field] = value;
      }
      return checked as unknown as StaffModel;
    }),
  });
}
