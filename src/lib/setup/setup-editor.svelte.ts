// The score setup as one unit: its working copy of the score definition,
// the preview, the group marking, the staff list and the recognition, wired
// to each other and to the page that hosts it.

import type { UnitWork } from "../editor-units.ts";
import { GroupMarking } from "./group-marking.svelte.ts";
import type { SetupInput, SetupServices } from "./host.ts";
import { SetupModel } from "./setup-model.svelte.ts";
import { SetupPreview } from "./setup-preview.svelte.ts";
import { SetupRecognition } from "./setup-recognition.svelte.ts";
import { firstMeasureOf } from "./source-frame.ts";
import { StaffListEditor } from "./staff-list.svelte.ts";

export interface SetupEditorHost {
  /** The score to set up; null while it is not loaded. */
  data(): SetupInput | null;
  canEdit(): boolean;
  runner: UnitWork;
  taskId(): string;
  /** The network work; null while it is not available. */
  services(): SetupServices | null;
  /** A click on a staff picks it for the host instead of marking a group. */
  picking(): boolean;
  pickStaff(i: number): void;
  /** Run inside an effect after each change of the setup: saves a draft. */
  draft?(): void;
}

export class SetupEditor {
  /** The form's working copy of the score definition. */
  readonly model: SetupModel;
  /** The preview of the setup beside the source. */
  readonly preview: SetupPreview;
  readonly marking: GroupMarking;
  readonly staffList: StaffListEditor;
  /** The piece's recognition (an OMR-prepared piece). */
  readonly recognition: SetupRecognition;
  // The setup's two steps: the staves with the key and time signature, then
  // the groups.
  step = $state<1 | 2>(1);
  // A page shown whole in place of the first measure's; null for the first
  // measure's page, framed on the measure.
  anchorPage = $state<number | null>(null);
  #host: SetupEditorHost;

  constructor(host: SetupEditorHost) {
    this.#host = host;
    const model = (this.model = new SetupModel({
      canEdit: () => host.canEdit(),
      taskId: () => host.taskId(),
    }));
    const recognition = (this.recognition = new SetupRecognition(
      {
        data: () => host.data(),
        canEdit: () => host.canEdit(),
        runner: host.runner,
        taskId: () => host.taskId(),
        services: () => host.services(),
      },
      model,
    ));
    const preview = (this.preview = new SetupPreview(model, {
      data: () => host.data(),
      firstMeasure: () => this.firstMeasure,
      anchorPage: () => this.anchorPage,
      markable: () => this.markable,
    }));
    const marking = (this.marking = new GroupMarking(model, preview, {
      markable: () => this.markable,
      step: () => this.step,
      picking: () => host.picking(),
      pickStaff: (i) => host.pickStaff(i),
    }));
    this.staffList = new StaffListEditor(model, marking);

    // The effects, in this order: the preview's measuring, the draft, the
    // recognition, the groups' one-instrument guess, the transpositions
    // from the labels, the preview's render, its coloured staves and its
    // staff numbers.
    $effect(() => preview.measureRendering());
    $effect(() => host.draft?.());
    $effect(() => recognition.startWhenHeld());
    $effect(() => model.followInstrumentGuess());
    $effect(() => model.fillLabelsOnce());
    $effect(() => preview.render());
    $effect(() => preview.lightStaves(marking.lit));
    $effect(() => preview.observeSheet());
  }

  // The source side of the work area: the first measure's page, framed on
  // the measure and the names in front of its system, the measure outlined
  // (source-frame.ts).
  firstMeasure = $derived.by(() =>
    firstMeasureOf(this.#host.data()?.model.pages),
  );
  shownPage = $derived.by(
    () => this.anchorPage ?? this.firstMeasure?.page ?? 0,
  );
  // Groups are marked in step 2, by the volunteer holding the task.
  markable = $derived.by(
    () =>
      this.#host.canEdit() && this.step === 2 && this.model.staves.length > 1,
  );

  goStep = (step: 1 | 2) => {
    this.step = step;
    this.marking.clearMark();
  };
}
