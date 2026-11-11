// A layout task's steps: the staff boxes, the grand-staff boxes, the
// measures, and where the piece names its instruments the instruments. Each
// step edits one layer; a review is approved once every step was opened.

import { untrack } from "svelte";
import { STEP_LAYERS, STEP_NAMES, type Layer } from "./edit-pages.ts";

export type LayoutStep = 1 | 2 | 3 | 4;

export interface LayoutStepsHost {
  /** The task corrects an OMR layout. */
  omr(): boolean;
  /** The layout task also names the instruments, in a fourth step. */
  naming(): boolean;
}

export class LayoutSteps {
  layoutStep = $state<LayoutStep>(1);
  // The step in view when the viewer switched their review to editing.
  editFrom: LayoutStep | null = null;
  stepsSeen = $state<number[]>([1]);
  #host: LayoutStepsHost;

  constructor(host: LayoutStepsHost) {
    this.#host = host;
    $effect(() => {
      const step = this.layoutStep;
      untrack(() => {
        if (!this.stepsSeen.includes(step))
          this.stepsSeen = [...this.stepsSeen, step];
      });
    });
  }

  // The layer the pointer edits; in a layout task the others are not drawn.
  // The instruments step edits no boxes and shows its own view of the staves.
  tool = $derived.by<Layer>(() =>
    this.#host.omr()
      ? (STEP_LAYERS[this.layoutStep - 1] ?? "staves")
      : "measures",
  );
  step4 = $derived.by(() => this.#host.naming() && this.layoutStep === 4);
  lastStep = $derived.by<LayoutStep>(() => (this.#host.naming() ? 4 : 3));
  // The steps not opened yet; the next of them after the one in view.
  stepsMissing = $derived.by(() =>
    this.#host.omr()
      ? Array.from({ length: this.lastStep }, (_, i) => i + 1).filter(
          (n) => !this.stepsSeen.includes(n),
        )
      : [],
  );
  nextMissing = $derived(
    this.stepsMissing.find((n) => n > this.layoutStep) ?? this.stepsMissing[0],
  );
  approveBlock = $derived(
    this.stepsMissing.length
      ? `Open ${this.stepsMissing.map((n) => `step ${n} (${STEP_NAMES[n - 1]})`).join(", ")} before approving.`
      : null,
  );
}
