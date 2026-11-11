// The clef corrections a score setup records in the recognition record: a
// staff submitted in another clef than the one the recognition read.

import type { ParsedFacsimile, StaffModel } from "../mei-facsimile.ts";
import { plainClef, staffClefToken } from "../omr-musicxml.ts";
import type { OmrRecord } from "../omr-record.ts";
import { openingClefs, pieceStaves } from "../omr-timeline.ts";

/** Clef tokens of the form's staves for placing the boxes. */
const formParts = (staves: StaffModel[]) =>
  staves.map((s) => ({
    clef: plainClef(staffClefToken(s)),
    label: s.label.trim(),
  }));
const pitched = (token: string) => /^[GFC]\d/.test(token);

/**
 * The record with a clef correction for each staff submitted in another
 * clef than it opens with in the recognition, the boxes placed on the
 * form's staves as the page drafts will place them.
 */
export function withClefCorrections(
  model: Pick<ParsedFacsimile, "pages"> | undefined,
  staves: StaffModel[],
  record: OmrRecord,
): OmrRecord {
  const readClefs = model
    ? openingClefs(
        pieceStaves(model, { ...record, clefs: [] }, formParts(staves)),
        staves.length,
      )
    : [];
  const clefs = staves.flatMap((staff, i) => {
    const read = readClefs[i];
    const corrected = staffClefToken(staff);
    return read && read !== corrected && pitched(read) && pitched(corrected)
      ? [{ staff: i + 1, read, corrected }]
      : [];
  });
  return { ...record, clefs };
}
