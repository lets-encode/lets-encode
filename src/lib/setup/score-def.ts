// The score setup's working values: the limits of the form, the staff a new
// row starts with and a new staff group.

import type { StaffGroupModel, StaffModel } from "../mei-facsimile.ts";
import { guessOneInstrument } from "../staff-groups.ts";

export const METER_NAMES = { common: "Common time", cut: "Cut time" };
export const MAX_STAVES = 24;

/** The time signature: numbers (count over unit), or one of the two MEI
    symbols — common time (C) and cut time (¢). */
export type MeterType = "numeric" | "common" | "cut";

export const plainStaff = (): StaffModel => ({
  clefShape: "G",
  clefLine: 2,
  clefDis: "",
  clefDisPlace: "",
  lines: 5,
  notationType: "",
  label: "",
});

/** A group over staves `start` to `end` (1-based); a brace guesses from the
    staves' labels and clefs whether it joins one instrument. */
export const newGroup = (
  start: number,
  end: number,
  symbol: string,
  staves: StaffModel[],
): StaffGroupModel => ({
  start,
  end,
  symbol,
  label: "",
  barThru: true,
  oneInstrument:
    symbol === "brace" && guessOneInstrument({ start, end, label: "" }, staves),
});
