// Recognition (OMR-prepared pieces)
//
// When the claim holder opens the task, every staff box of the piece is
// transcribed and its instrument label read; the record goes into the
// submission as `omr.xml`, which the page drafts are made from. Staves the
// head's record or this browser already holds are not transcribed again.
//
// A definition still at the default is filled in from the record. The
// staff count starts from the layout correction. Each staff's clef is the
// one it opens with where it first appears (a first system may leave a
// staff out, a resting voice above a piano introduction), placed by the
// system with the most staves; key and meter come from the piece's first
// system, where signatures are printed. A clef submitted other than the
// one read is recorded as a correction: the page drafts then read that
// staff in the submitted clef until the model reads a real change. The instrument
// labels are those read in front of the first system, where they are
// usually written out, and in front of the fullest system for a staff the
// first leaves out; a staff that already has a label keeps it. Braces come
// from the corrected grand-staff boxes of the fullest system; brackets are
// not recognised. The count stays editable until the piece holds notation,
// since the setup submission rebuilds empty measures for it until then.

import type { UnitWork, WorkResult } from "../editor-units.ts";
import type { MeasureBox, StaffGroupModel } from "../mei-facsimile.ts";
import { grandStaffSpans, pageSystems } from "../omr-layout.ts";
import {
  clefStaff,
  plainClef,
  proposeScoreDef,
  staffClefToken,
} from "../omr-musicxml.ts";
import type { PieceRecognition } from "../omr-piece-recognition.ts";
import type { OmrRecord } from "../omr-record.ts";
import { suggestStaffAssignment } from "../omr-staff-assign.ts";
import { openingClefs, pieceStaves } from "../omr-timeline.ts";
import { spanProblem } from "../staff-groups.ts";
import type { SetupInput, SetupServices } from "./host.ts";
import { newGroup } from "./score-def.ts";
import type { SetupModel } from "./setup-model.svelte.ts";

export interface SetupRecognitionHost {
  data(): SetupInput | null;
  canEdit(): boolean;
  runner: UnitWork;
  taskId(): string;
  /** The network work; null while it is not available. */
  services(): SetupServices | null;
}

export class SetupRecognition {
  #host: SetupRecognitionHost;
  #model: SetupModel;
  /** The recognition this session made, once it has run. */
  result = $state<PieceRecognition | null>(null);
  /** The task the recognition was started for. */
  recognisedFor = $state<string | null>(null);
  omr = $derived.by(() => this.#host.data()?.preparation === "omr");

  constructor(host: SetupRecognitionHost, model: SetupModel) {
    this.#host = host;
    this.#model = model;
  }

  /** Run inside an `$effect`: recognises the piece once the holder opens
      the task. */
  startWhenHeld() {
    if (
      this.omr &&
      this.#host.canEdit() &&
      this.#host.data() &&
      !this.#host.runner.busy &&
      this.recognisedFor !== this.#host.taskId()
    ) {
      this.recognisedFor = this.#host.taskId();
      this.recognise();
    }
  }

  recognise = async () => {
    const services = this.#host.services();
    const d = this.#host.data();
    if (!services || !d) return;
    await this.#host.runner.run(() => this.steps(services, d));
  };

  /** The definition proposed from a record, and the labels it reads; a note says what was used. */
  #proposalFrom(d: SetupInput, record: OmrRecord): { note: string } {
    type System = { p: number; index: number; staves: MeasureBox[] };
    let first: System | null = null;
    let fullest: System | null = null;
    for (const [p, pg] of d.model.pages.entries()) {
      for (const [index, system] of pageSystems(pg).systems.entries()) {
        if (!system.length) continue;
        first ??= { p, index, staves: system };
        if (!fullest || system.length > fullest.staves.length)
          fullest = { p, index, staves: system };
      }
    }
    if (!first || !fullest)
      throw new Error("the layout has no system with staves.");
    const same = first.p === fullest.p && first.index === fullest.index;
    const entriesOf = (system: System) =>
      system.staves.map((box) => {
        const zone = `staff-zone-${system.p + 1}-${d.model.pages[system.p].staves!.indexOf(box) + 1}`;
        return (
          record.pages
            .find((pg) => pg.n === system.p + 1)
            ?.staves.find((e) => e.zone === zone) ?? null
        );
      });
    const fullestEntries = entriesOf(fullest);
    const firstEntries = same ? fullestEntries : entriesOf(first);
    const fullestXmls = fullestEntries.map((e) => e?.musicxml ?? null);
    const firstXmls = firstEntries.map((e) => e?.musicxml ?? null);
    const proposal = proposeScoreDef(fullestXmls, same ? [] : firstXmls);
    // Each staff opens in the clef of its first appearance, placed by the fullest system's clefs.
    const placedBy = proposal.staves.map((staff) => ({
      clef: plainClef(staffClefToken(staff)),
      label: "",
    }));
    openingClefs(
      pieceStaves(d.model, { ...record, clefs: [] }, placedBy),
      proposal.staves.length,
    ).forEach((token, i) => {
      if (token)
        proposal.staves[i] = { ...proposal.staves[i], ...clefStaff(token) };
    });
    this.#model.applyProposal(proposal);

    // The fullest system shows every staff of the definition, in order.
    const read = fullestEntries.map((e) => e?.label ?? "");
    if (!same) {
      const onFirst = suggestStaffAssignment(
        first.staves.map((box, i) => ({
          box,
          clef: plainClef(staffClefToken(firstXmls[i])),
          label: "",
        })),
        proposal.staves.map((staff) => ({
          clef: plainClef(staffClefToken(staff)),
          label: "",
        })),
        fullest.staves,
      );
      onFirst.forEach((n, i) => {
        const label = firstEntries[i]?.label;
        if (n > 0 && label) read[n - 1] = label;
      });
    }
    let filled = 0;
    this.#model.staves = this.#model.staves.map((staff, i) => {
      if (staff.label.trim() || !read[i]) return staff;
      filled++;
      return { ...staff, label: read[i] };
    });
    this.#model.staves.forEach((staff) =>
      this.#model.pitch.fillFromLabel(staff),
    );
    // The fullest system's grand-staff boxes become braces, unless the
    // definition has groups already; a span repeating or crossing an earlier
    // one is left out.
    const braces: StaffGroupModel[] = [];
    if (!this.#model.groups.length)
      for (const { start, end } of grandStaffSpans(
        fullest.staves,
        d.model.pages[fullest.p].grandstaves ?? [],
      )) {
        const repeated = braces.some((b) => b.start === start && b.end === end);
        if (!repeated && !spanProblem(braces, start, end))
          braces.push(newGroup(start, end, "brace", this.#model.staves));
      }
    if (braces.length) this.#model.groups = braces;
    const clefs = proposal.staves
      .map(
        (s) =>
          `${s.clefShape}${s.clefLine}${s.clefDis ? ` ${s.clefDis}${s.clefDisPlace === "below" ? "vb" : "va"}` : ""}`,
      )
      .join(", ");
    const meter =
      proposal.meterSym || `${proposal.meterCount}/${proposal.meterUnit}`;
    return {
      note:
        ` Filled in: clefs ${clefs}, each where its staff first appears; key signature ${proposal.keysig} and time signature ${meter} from the first system; instrument labels for ${filled} of ${this.#model.staves.length} staves${braces.length ? `; ${braces.length} brace${braces.length === 1 ? "" : "s"} from the grand staves` : ""}.` +
        " Check the values, then submit.",
    };
  }

  // The recognition steps, logged to the running command's overlay.
  async steps(services: SetupServices, d: SetupInput): Promise<WorkResult> {
    const runner = this.#host.runner;
    try {
      runner.log.step("Reading the recognition record");
      const result = await services.recogniseStaves(
        d.model.pages,
        this.result?.record ?? null,
        (step) => runner.log.step(step),
      );
      this.result = result;
      const total = result.record.pages.reduce(
        (n, pg) => n + pg.staves.length,
        0,
      );
      const failed = result.failed.length
        ? ` ${result.failed.length} of ${total} staves could not be transcribed (${result.failed
            .map((s) => `page ${s.page}, staff ${s.staff}`)
            .join(
              "; ",
            )})${result.runErrors.length ? `; the staff pipeline reported: ${result.runErrors.join("; ")}` : ""}. Use “Transcribe failed staves again”.`
        : "";
      const labels = result.labelErrors.length
        ? ` The instrument labels could not be read on page${result.labelErrors.length === 1 ? "" : "s"} ${result.labelErrors.map((e) => e.page).join(", ")} (${result.labelErrors[0].error}).`
        : "";
      const filled = this.#model.unset
        ? this.#proposalFrom(d, result.record).note
        : "";
      this.#model.unset = false;
      return {
        ok: true,
        outcome:
          result.failed.length > 0 || result.labelErrors.length > 0
            ? "partial"
            : undefined,
        message: `${total - result.failed.length} of ${total} staves are transcribed.${failed}${labels}${filled}`,
      };
    } catch (e) {
      return {
        error: `Recognition failed: ${(e as Error).message}`,
        retry: this.recognise,
      };
    }
  }
}
