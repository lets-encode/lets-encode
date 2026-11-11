// The score setup form's working copy of the score definition: the staves,
// the staff groups, the key and the time signature, with their validity and
// the definition they make.

import { untrack } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import type { FacsimileTaskData } from "../commands.ts";
import {
  DEFAULT_SCORE_DEF,
  withoutIds,
  type ScoreDefModel,
  type StaffGroupModel,
  type StaffModel,
} from "../mei-facsimile.ts";
import { staffCountOf } from "../omr-layout.ts";
import {
  groupsValid as groupsFit,
  guessOneInstrument,
  sortGroups,
} from "../staff-groups.ts";
import { setClef as setStaffClef } from "../staff-edit.ts";
import { StaffPitchEditor } from "../staff-pitch.svelte.ts";
import { plainStaff, type MeterType } from "./score-def.ts";

export interface SetupModelHost {
  /** Whether the viewer holds the task and edits it. */
  canEdit: () => boolean;
  taskId: () => string;
}

export class SetupModel {
  staves = $state<StaffModel[]>([]);
  groups = $state<StaffGroupModel[]>([]);
  keysig = $state("0");
  meterType = $state<MeterType>("numeric");
  meterCount = $state("4");
  meterUnit = $state("4");
  /** Whether the file still carries the default definition (set on load). */
  unset = $state(false);
  /** Groups whose one-instrument value the volunteer set or the file holds;
      the others follow the guess from the labels and clefs. */
  readonly instrChosen = new SvelteSet<StaffGroupModel>();
  /** The staves' transposition fields (StaffPitchSelects, StaffCustomPitch). */
  readonly pitch = new StaffPitchEditor(() => this.keysig);
  #labelsReadFor = $state<string | null>(null);
  #host: SetupModelHost;

  // A count of 0, a blank, or anything non-numeric would emit a meter no
  // renderer can read, so the submission waits for a whole number above zero.
  // A symbol signature carries no count to get wrong.
  meterValid = $derived(
    this.meterType !== "numeric" || /^[1-9]\d*$/.test(this.meterCount.trim()),
  );

  // Groups must fit the staves and nest without crossing (staff-groups.ts).
  groupsValid = $derived(groupsFit(this.groups, this.staves.length));

  // A symbol signature implies its numeric meter — common time is 4/4, cut
  // time 2/2 — matching what parseScoreDef reads back.
  scoreDef = $derived<ScoreDefModel>({
    staves: this.staves.map((s) => ({ ...s, label: s.label.trim() })),
    groups: this.groups.map((g) => ({ ...g, label: g.label.trim() })),
    keysig: this.keysig,
    meterCount:
      this.meterType === "numeric"
        ? this.meterCount.trim()
        : this.meterType === "cut"
          ? "2"
          : "4",
    meterUnit:
      this.meterType === "numeric"
        ? this.meterUnit
        : this.meterType === "cut"
          ? "2"
          : "4",
    meterSym: this.meterType === "numeric" ? "" : this.meterType,
  });

  /** The groups in staff order, an outer group before the groups inside it. */
  ordered = $derived(sortGroups(this.groups));

  constructor(host: SetupModelHost) {
    this.#host = host;
  }

  /** Take the loaded task's definition into the form. */
  load(d: FacsimileTaskData) {
    this.staves = d.model.scoreDef.staves.map((s) => ({ ...s }));
    this.groups = d.model.scoreDef.groups.map((g) => ({ ...g }));
    // A loaded group's one-instrument value is kept, not guessed again.
    this.instrChosen.clear();
    this.groups.forEach((g) => this.instrChosen.add(g));
    this.keysig = d.model.scoreDef.keysig;
    this.meterType =
      d.model.scoreDef.meterSym === ""
        ? "numeric"
        : (d.model.scoreDef.meterSym as "common" | "cut");
    this.meterCount = d.model.scoreDef.meterCount;
    this.meterUnit = d.model.scoreDef.meterUnit;
    // An OMR-prepared piece still at the default definition opens with the
    // staff count its layout has; the clefs, key and meter follow from the
    // recognition once the task is held.
    this.unset =
      JSON.stringify(withoutIds(d.model.scoreDef)) ===
      JSON.stringify(DEFAULT_SCORE_DEF);
    if (d.preparation === "omr" && this.unset) {
      this.staves = Array.from(
        { length: staffCountOf(d.model.pages) },
        plainStaff,
      );
    }
  }

  applyProposal(proposal: ScoreDefModel) {
    // A clef per staff the layout has; a staff beyond the recognised system
    // keeps its own. Labels stay.
    this.staves = this.staves.map((s, i) =>
      proposal.staves[i] ? { ...proposal.staves[i], label: s.label } : s,
    );
    this.keysig = proposal.keysig;
    this.meterType =
      proposal.meterSym === ""
        ? "numeric"
        : (proposal.meterSym as "common" | "cut");
    this.meterCount = proposal.meterCount;
    this.meterUnit = proposal.meterUnit;
  }

  /** Run inside an `$effect`: a group whose one-instrument value nobody
      chose follows the guess from the labels and clefs. */
  followInstrumentGuess() {
    for (const g of this.groups) {
      if (this.instrChosen.has(g)) continue;
      const guess = g.symbol === "brace" && guessOneInstrument(g, this.staves);
      if (g.oneInstrument !== guess) g.oneInstrument = guess;
    }
  }

  setOneInstrument(g: StaffGroupModel, value: boolean) {
    g.oneInstrument = value;
    this.instrChosen.add(g);
  }

  /** Whether the groups stay valid with one group's values changed. */
  fitsWith = (g: StaffGroupModel, change: Partial<StaffGroupModel>) =>
    groupsFit(
      this.groups.map((h) => (h === g ? { ...h, ...change } : h)),
      this.staves.length,
    );

  // The staff edits against the score's key (staff-edit.ts).
  setClef = (staff: StaffModel, key: string) =>
    setStaffClef(this.keysig, staff, key);

  /** Run inside an `$effect`: labels already in the file or a saved draft
      fill the transpositions once the holder opens the task. */
  fillLabelsOnce() {
    if (
      !this.#host.canEdit() ||
      this.staves.length === 0 ||
      this.#labelsReadFor === this.#host.taskId()
    )
      return;
    this.#labelsReadFor = this.#host.taskId();
    untrack(() =>
      this.staves.forEach((staff) => this.pitch.fillFromLabel(staff)),
    );
  }
}
