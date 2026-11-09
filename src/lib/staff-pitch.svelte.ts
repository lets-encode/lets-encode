// The transposition fields of a score definition's staves, as the score
// setup and the score check edit them: the select between "not
// transposing", the listed transpositions and "Other…", and the pitch fields
// "Other…" shows.

import { SvelteSet } from "svelte/reactivity";
import type { StaffModel } from "./mei-facsimile.ts";
import {
  setTransposition,
  transOf,
  transposes,
  unpitched,
} from "./staff-edit.ts";
import {
  COMMON_TRANSPOSITIONS,
  fromCustom,
  toCustom,
  transpositionFromLabel,
} from "./transposition.ts";

/** A transposition outside the list, as its pitch fields hold it. */
export type CustomPitch = NonNullable<ReturnType<typeof toCustom>>;

export class StaffPitchEditor {
  /** Staves whose transposition the volunteer chose, which a label no longer fills. */
  readonly chosen = new SvelteSet<StaffModel>();
  /** Staves showing the pitch fields although a listed transposition matches. */
  readonly custom = new SvelteSet<StaffModel>();
  #scoreKey: () => string;

  /** `scoreKey` gives the score's key signature, which staff keys follow. */
  constructor(scoreKey: () => string) {
    this.#scoreKey = scoreKey;
  }

  /** The transposition select's value: 'none', a list index, or 'other'. */
  value(staff: StaffModel): string {
    if (this.custom.has(staff)) return "other";
    if (!transposes(staff)) return "none";
    const i = COMMON_TRANSPOSITIONS.findIndex(
      (t) => t.diat === staff.transDiat && t.semi === staff.transSemi,
    );
    return i < 0 ? "other" : String(i);
  }

  /** Apply a choice from the transposition select. */
  pick(staff: StaffModel, value: string): void {
    this.chosen.add(staff);
    if (value === "other") {
      this.custom.add(staff);
      return;
    }
    this.custom.delete(staff);
    setTransposition(
      this.#scoreKey(),
      staff,
      value === "none" ? null : COMMON_TRANSPOSITIONS[Number(value)],
    );
  }

  /** The pitch fields of a staff with a transposition outside the list. */
  customOf(staff: StaffModel): CustomPitch {
    return (
      toCustom(transOf(staff)) ?? { pitch: "C", higher: false, octaves: 0 }
    );
  }

  /** Apply a change to the pitch fields. */
  setCustom(staff: StaffModel, change: Partial<CustomPitch>): void {
    setTransposition(
      this.#scoreKey(),
      staff,
      fromCustom({ ...this.customOf(staff), ...change }),
    );
  }

  /** Fill a staff's transposition from its label, unless one is set or was chosen. */
  fillFromLabel(staff: StaffModel): void {
    if (this.chosen.has(staff) || transposes(staff) || unpitched(staff)) return;
    const t = transpositionFromLabel(staff.label);
    if (t) setTransposition(this.#scoreKey(), staff, t);
  }
}
