// Editing one staff of a score definition: the clefs and staff kinds the
// score setup and the first page task's score check offer, and setting a
// staff's clef, transposition and own key signature. A staff's key follows
// the score's, moved by its transposition, unless it has its own (`keysig`);
// a key set equal to the one it would follow is dropped, so it keeps
// following. Functions on the staff object, which they change in place.

import type { MusicGlyphName } from "./components/MusicGlyph.svelte";
import type { StaffModel } from "./mei-facsimile.ts";
import { keysigText, writtenKeysig } from "./transposition.ts";
import type { Transposition } from "./transposition.ts";

// The clefs and staff kinds the form offers, by name. Each option carries
// the staff values it sets: clef shape, line, octave displacement and
// notation type as MEI writes them, and the staff's line count. A modern
// (guitar) tablature staff shows the TAB lettering as its clef; the lute
// kinds carry no clef.
const pitchedClef = (
  value: string,
  label: string,
  clefShape: string,
  clefLine: number,
  clefDis = "",
) => ({
  value,
  label,
  glyph: (clefDis
    ? "gClef8vb"
    : clefShape === "G"
      ? "gClef"
      : clefShape === "F"
        ? "fClef"
        : "cClef") as MusicGlyphName,
  clefShape,
  clefDis,
  notationType: "",
  clefLine,
  lines: 5,
});
export const CLEF_OPTIONS = [
  pitchedClef("G2", "Treble", "G", 2),
  pitchedClef("G2-8", "Treble, octave lower", "G", 2, "8"),
  pitchedClef("G1", "French violin", "G", 1),
  pitchedClef("C1", "Soprano", "C", 1),
  pitchedClef("C2", "Mezzo-soprano", "C", 2),
  pitchedClef("C3", "Alto", "C", 3),
  pitchedClef("C4", "Tenor", "C", 4),
  pitchedClef("C5", "Baritone (C clef)", "C", 5),
  pitchedClef("F3", "Baritone (F clef)", "F", 3),
  pitchedClef("F4", "Bass", "F", 4),
  pitchedClef("F5", "Sub-bass", "F", 5),
  {
    value: "perc",
    label: "Percussion",
    glyph: "percussion" as MusicGlyphName,
    clefShape: "perc",
    clefDis: "",
    notationType: "",
    clefLine: 3,
    lines: 5,
  },
  {
    value: "TAB",
    label: "Tablature, modern",
    glyph: "tab" as MusicGlyphName,
    clefShape: "TAB",
    clefDis: "",
    notationType: "tab.guitar",
    clefLine: 3,
    lines: 6,
  },
  {
    value: "TABfr",
    label: "Tablature, French",
    clefShape: "TAB",
    clefDis: "",
    notationType: "tab.lute.french",
    clefLine: 3,
    lines: 6,
  },
  {
    value: "TABit",
    label: "Tablature, Italian",
    clefShape: "TAB",
    clefDis: "",
    notationType: "tab.lute.italian",
    clefLine: 3,
    lines: 6,
  },
  {
    value: "TABde",
    label: "Tablature, German",
    clefShape: "TAB",
    clefDis: "",
    notationType: "tab.lute.german",
    clefLine: 3,
    lines: 6,
  },
] as const;
// The clefs most staves open with, listed first in the clef menu.
export const COMMON_CLEFS = ["G2", "F4", "C3"];
// The option behind a staff's stored values: the one with its shape,
// displacement and notation type, and for a pitched clef its line too.
// An unlisted combination (an OMR reading, an imported file) has none.
export const clefOption = (staff: StaffModel) =>
  CLEF_OPTIONS.find(
    (o) =>
      o.clefShape === staff.clefShape &&
      o.clefDis === staff.clefDis &&
      o.notationType === staff.notationType &&
      (unpitched(staff) || o.clefLine === staff.clefLine),
  );
export const unpitched = (staff: StaffModel): boolean =>
  staff.clefShape === "perc" || staff.clefShape === "TAB";
/** The symbol of a staff's clef: its option's, else its shape's. */
export function clefGlyph(staff: StaffModel): MusicGlyphName | undefined {
  const option = clefOption(staff);
  if (option) return "glyph" in option ? option.glyph : undefined;
  return (
    { G: "gClef", F: "fClef", C: "cClef" } as Record<string, MusicGlyphName>
  )[staff.clefShape];
}
/** A staff's clef as text. */
export function clefText(staff: StaffModel): string {
  const option = clefOption(staff);
  if (option) return option.label;
  const octaves =
    { "8": "an octave", "15": "two octaves", "22": "three octaves" }[
      staff.clefDis
    ] ?? "";
  const octave = octaves
    ? `, ${octaves} ${staff.clefDisPlace === "above" ? "higher" : "lower"}`
    : "";
  return `${staff.clefShape} clef on line ${staff.clefLine}${octave}`;
}
// A percussion staff has up to 5 lines; a tablature one line (string or
// course) per string, 4 to 8.
export const linesChoices = (staff: StaffModel): number[] =>
  staff.clefShape === "perc" ? [1, 2, 3, 4, 5] : [4, 5, 6, 7, 8];
export const KEY_SIGNATURES = ["0", "1s", "2s", "3s", "4s", "5s", "6s", "7s"]
  .concat(["1f", "2f", "3f", "4f", "5f", "6f", "7f"])
  .map((value) => ({ value, label: keysigText(value) }));

/** Set a staff's clef and kind from a CLEF_OPTIONS value; an unknown value changes nothing. */
export function setClef(scoreKeysig: string, staff: StaffModel, value: string) {
  const option = CLEF_OPTIONS.find((o) => o.value === value);
  if (!option) return;
  staff.clefShape = option.clefShape;
  staff.clefDis = option.clefDis;
  staff.clefDisPlace = option.clefDis ? "below" : "";
  staff.notationType = option.notationType;
  staff.clefLine = option.clefLine;
  staff.lines = option.lines;
  // Percussion and tablature staves do not transpose or carry a key.
  if (unpitched(staff)) {
    setTransposition(scoreKeysig, staff, null);
    delete staff.keysig;
  }
}

/** A staff's transposition; 0, 0 for none. */
export const transOf = (staff: StaffModel): Transposition => ({
  diat: staff.transDiat ?? 0,
  semi: staff.transSemi ?? 0,
});
export const transposes = (staff: StaffModel) =>
  !!(staff.transDiat || staff.transSemi);
/** The key a staff follows without its own: the score's, moved by its transposition. */
export const followedKey = (scoreKeysig: string, staff: StaffModel) =>
  writtenKeysig(scoreKeysig, transOf(staff));
/** Drop a staff's own key where it equals the one it follows. */
export function settleKey(scoreKeysig: string, staff: StaffModel) {
  if (
    staff.keysig !== undefined &&
    staff.keysig === followedKey(scoreKeysig, staff)
  )
    delete staff.keysig;
}
export function setTransposition(
  scoreKeysig: string,
  staff: StaffModel,
  t: Transposition | null,
) {
  if (t && (t.diat || t.semi)) {
    staff.transDiat = t.diat;
    staff.transSemi = t.semi;
  } else {
    delete staff.transDiat;
    delete staff.transSemi;
  }
  settleKey(scoreKeysig, staff);
}
