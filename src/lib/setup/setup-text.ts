// The score setup's values as text: a group's symbol and line, a staff's
// transposition.

import type { MusicGlyphName } from "../components/MusicGlyph.svelte";
import type { StaffGroupModel, StaffModel } from "../mei-facsimile.ts";
import { transOf, transposes } from "../staff-edit.ts";
import { soundsText, toCustom } from "../transposition.ts";

export const symbolName = (symbol: string) =>
  symbol === "brace" ? "Brace" : "Bracket";

export const symbolGlyph = (symbol: string): MusicGlyphName =>
  symbol === "brace" ? "brace" : "bracket";

/** "staves 7–8 · Pianoforte · one instrument · barlines through" */
export const groupText = (g: StaffGroupModel) =>
  [
    `staves ${g.start}–${g.end}`,
    g.label.trim(),
    g.symbol === "brace"
      ? g.oneInstrument
        ? "one instrument"
        : "separate staves"
      : "",
    g.barThru ? "barlines through" : "barlines per staff",
  ]
    .filter(Boolean)
    .join(" · ");

/** "in B♭, sounds a major 2nd lower", or '' for a staff that does not transpose. */
export function transText(staff: StaffModel): string {
  if (!transposes(staff)) return "";
  const c = toCustom(transOf(staff));
  const pitch =
    c && !(c.pitch === "C" && c.octaves > 0) ? `in ${c.pitch}, ` : "";
  return `${pitch}sounds ${soundsText(transOf(staff))}`;
}
