// Which pages of an 'omr-instruments' piece ask the encoder to check the
// score definition against the scan, and why: a page on which an instrument
// is first named, an instrument is written on other staves than in the
// system before it (divisi), or the recognition changes a clef at a system
// start, the key or the meter. The first page is checked in its own task
// and gets no reasons here. Pure functions apart from `loadPageChecks`,
// which reads the piece from the campaign repo; no DOM.

import type { ForgeClient } from "./forge/types.ts";
import { parseFacsimileMei, type ParsedFacsimile } from "./mei-facsimile.ts";
import {
  correctedLayoutPath,
  layoutInstruments,
  withCorrectedLayout,
} from "./omr-layout.ts";
import { omrRecordPath, parseOmrRecord, type OmrRecord } from "./omr-record.ts";
import { staffClefToken } from "./omr-musicxml.ts";
import {
  openingClefs,
  pageChanges,
  pieceStaves,
  scoreStaves,
  type PageStaves,
} from "./omr-timeline.ts";
import {
  plannedBoxes,
  staffPlan,
  type StaffPlan,
} from "./instrument-naming.ts";

const pitched = (token: string) => /^[GFC]\d/.test(token);

/**
 * A piece's staves read through, each box placed on the score staff the
 * staff plan gives it, with the clef corrections the score definition gives:
 * a staff whose clef differs from the one its first transcribed box reads
 * (both pitched) is read in the definition's clef (omr-musicxml
 * correctClef), as the score setup's corrections are.
 */
export function namedPieceStaves(
  parsed: Pick<ParsedFacsimile, "pages" | "scoreDef">,
  record: OmrRecord,
  plan: StaffPlan,
): PageStaves[] {
  const placed = plannedBoxes(plan, parsed.pages.length);
  const parts = scoreStaves(parsed);
  const read = openingClefs(
    pieceStaves(parsed, { ...record, clefs: [] }, parts, placed),
    parts.length,
  );
  const clefs = parsed.scoreDef.staves.flatMap((staff, i) => {
    const corrected = staffClefToken(staff);
    const r = read[i];
    return r && r !== corrected && pitched(r) && pitched(corrected)
      ? [{ staff: i + 1, read: r, corrected }]
      : [];
  });
  return pieceStaves(parsed, { ...record, clefs }, parts, placed);
}

const list = (names: string[]): string => [...new Set(names)].join(", ");

/**
 * Per page (index 0 for page 1), the reasons to check it: sentences naming
 * the instruments first named there, those on other staves than before, the
 * staves whose clef changes at a system start, and the key and meter
 * changes with their systems. Page 1 has none.
 */
export function pageChecks(
  parsed: Pick<ParsedFacsimile, "scoreDef">,
  pages: PageStaves[],
  plan: StaffPlan,
): string[][] {
  const byStaff = new Map(
    plan.staves.map((staff, i) => {
      const { instrument } = staff;
      const parts = staff.parts.map((p) => instrument.parts[p].name).join(", ");
      return [
        i + 1,
        {
          instrument: instrument.id,
          label: parts ? `${instrument.name} ${parts}` : instrument.name,
        },
      ];
    }),
  );
  const nameOf = new Map(
    plan.staves.map((s) => [s.instrument.id, s.instrument.name]),
  );
  const changes = pageChanges(parsed, pages);
  // Per instrument, the staves it was last printed on, as "n,n".
  const last = new Map<string, string>();
  return pages.map((staves, p) => {
    const first: string[] = [];
    const moved: string[] = [];
    for (const assigned of staves.assigned) {
      const shown = new Map<string, number[]>();
      for (const n of assigned) {
        const at = byStaff.get(n);
        if (at)
          shown.set(at.instrument, [...(shown.get(at.instrument) ?? []), n]);
      }
      for (const [instrument, ns] of shown) {
        const key = [...ns].sort((a, b) => a - b).join(",");
        const before = last.get(instrument);
        if (before === undefined) first.push(nameOf.get(instrument)!);
        else if (before !== key) moved.push(nameOf.get(instrument)!);
        last.set(instrument, key);
      }
    }
    if (p === 0) return [];
    const reasons: string[] = [];
    if (first.length) reasons.push(`First named on this page: ${list(first)}.`);
    if (moved.length)
      reasons.push(
        `On other staves than in the system before: ${list(moved)}.`,
      );
    const systems = (kind: string) =>
      list(
        changes[p]
          .filter((c) => c.kind === kind)
          .map((c) => String(c.system + 1)),
      );
    const clefs = changes[p].flatMap((c) =>
      c.kind === "clef" && byStaff.has(c.part! + 1)
        ? [byStaff.get(c.part! + 1)!.label]
        : [],
    );
    if (clefs.length) reasons.push(`The clef changes on ${list(clefs)}.`);
    if (systems("key"))
      reasons.push(`The key changes in system ${systems("key")}.`);
    if (systems("meter"))
      reasons.push(`The meter changes in system ${systems("meter")}.`);
    return reasons;
  });
}

/**
 * The check reasons of every page of a piece whose layout task names its
 * instruments (pageChecks), from the campaign repo at `ref` (the default
 * branch when absent); null for a piece without named instruments or
 * recognition record.
 */
export async function loadPageChecks(
  forge: ForgeClient,
  owner: string,
  repo: string,
  fragment: string,
  ref?: string,
): Promise<string[][] | null> {
  const [score, recordXml, corrected] = await Promise.all([
    forge.getRepoFile(owner, repo, fragment, ref),
    forge.getRepoFile(owner, repo, omrRecordPath(fragment), ref),
    forge.getRepoFile(owner, repo, correctedLayoutPath(fragment), ref),
  ]);
  const named = corrected ? layoutInstruments(corrected) : null;
  const record = parseOmrRecord(recordXml);
  if (!score || !named || !record) return null;
  const parsed = parseFacsimileMei(score);
  parsed.pages = withCorrectedLayout(parsed.pages, corrected);
  const plan = staffPlan(named, parsed.pages);
  return pageChecks(parsed, namedPieceStaves(parsed, record, plan), plan);
}
