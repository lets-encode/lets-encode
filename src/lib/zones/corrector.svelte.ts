// The measure and layout correction as one unit: its working copy, steps,
// box editor, page view, selection, instruments step, staff transcription
// and layout detection, wired to each other and to the page that hosts it.

import { tick, untrack } from "svelte";
import { MediaQuery } from "svelte/reactivity";
import { BoxEditor } from "../box-editor.svelte.ts";
import type { UnitWork } from "../editor-units.ts";
import type { MeasureBox } from "../mei-facsimile.ts";
import type { OmrPipeline } from "../omr-client.ts";
import { BoxSelection } from "./box-selection.svelte.ts";
import {
  boxNameOf,
  STEP_LAYERS,
  toPageModels,
  type Layer,
} from "./edit-pages.ts";
import type { CorrectorInput, CorrectorServices } from "./host.ts";
import { InstrumentStep } from "./instrument-step.svelte.ts";
import { LayoutDetection } from "./layout-detection.svelte.ts";
import { LayoutSteps, type LayoutStep } from "./layout-steps.svelte.ts";
import { PageView } from "./page-view.svelte.ts";
import { StaffTranscription } from "./staff-transcription.svelte.ts";
import {
  draftInput,
  layoutSubmission,
  submitBlock as submitBlockOf,
  type SubmitState,
  type ZoneWork,
} from "./submission.ts";
import {
  ZonePages,
  type ZoneEditor,
  type ZoneSnapshot,
} from "./zone-pages.svelte.ts";

// The selection, the gestures and the undo history of the active layer's
// boxes. In page pixels: a box is at least MIN_BOX each way, a drawn box
// under DROP_BELOW was a click on the page, and an arrow key moves NUDGE
// (NUDGE_FAR with Shift).
const MIN_BOX = 5;
const DROP_BELOW = 8;
const NUDGE = 2;
const NUDGE_FAR = 10;

export interface CorrectorHost {
  /** The pages to correct; null while they are not loaded. */
  data(): CorrectorInput | null;
  /** The task corrects an OMR layout: staff and grand-staff boxes too. */
  omr(): boolean;
  /** The layout task also names the instruments, in a fourth step. */
  naming(): boolean;
  canEdit(): boolean;
  runner: UnitWork;
  taskId(): string;
  /** The network work; null while it is not available. */
  services(): CorrectorServices | null;
  /** The layout model whose raw output goes with the work. */
  layoutModel: OmrPipeline;
}

export class Corrector {
  readonly steps: LayoutSteps;
  readonly model: ZonePages;
  readonly ed: ZoneEditor;
  readonly view: PageView;
  readonly sel: BoxSelection;
  readonly instruments: InstrumentStep;
  readonly transcriber: StaffTranscription;
  readonly detection: LayoutDetection;
  /** The work as the draft, the submission and its checks read it. */
  readonly work: ZoneWork & SubmitState;
  // The editor help and the View options behind the toolbar's ⋯ button.
  helpOpen = $state(false);
  viewOpen = $state(false);
  // On a touch screen a finger drag on the page scrolls it: a tap selects a
  // box, the selected box and its handles drag, and new boxes are drawn only
  // in draw mode.
  #coarseQuery = new MediaQuery("(pointer: coarse)", false);
  #host: CorrectorHost;

  constructor(host: CorrectorHost) {
    this.#host = host;
    const canEdit = () => host.canEdit();
    const steps = (this.steps = new LayoutSteps({
      omr: () => host.omr(),
      naming: () => host.naming(),
    }));
    const model = (this.model = new ZonePages({
      canEdit,
      commit: () => this.ed.commit(),
    }));
    const ed = (this.ed = new BoxEditor<{ box: MeasureBox }, ZoneSnapshot>({
      items: (p) => (model.pages[p] ? this.items(p) : []),
      box: (item) => item.box,
      page: (p) => model.pages[p],
      surface: (p) => this.view.svgEls[p],
      screenWidth: (p) => this.view.canvasW[p] || model.pages[p]?.width || 0,
      canEdit,
      canDraw: () => canEdit() && this.view.showBoxes,
      shown: () => this.view.showBoxes,
      touch: () => this.coarse,
      scope: () => steps.tool,
      add: (p, box) => this.items(p)[model.addBox(p, steps.tool, box)],
      remove: (p, item) => {
        const list = this.items(p);
        const z = list.indexOf(item);
        if (z >= 0) list.splice(z, 1);
      },
      minSize: () => MIN_BOX,
      dropBelow: () => DROP_BELOW,
      nudge: { near: NUDGE, far: NUDGE_FAR },
      changed: this.settle,
      snapshot: () => model.snapshot(),
      restore: (s) => model.restore(s),
    }));
    $effect(() => ed.listen());

    const view = (this.view = new PageView({
      pages: () => model.pages,
      data: () => host.data(),
      coarse: () => this.coarse,
      step4: () => steps.step4,
      deselect: () => ed.select(0, null),
      boxesToggled: () => ed.clear(),
    }));
    this.sel = new BoxSelection({
      editor: ed,
      model,
      view,
      tool: () => steps.tool,
      canEdit,
      settle: this.settle,
    });

    // The pages shown in each step. Submission waits until every page with
    // boxes in a step has been on screen in that step.
    $effect(() => {
      const shown = view.shownPages;
      const layer = steps.tool;
      if (steps.step4) return;
      untrack(() => model.markSeen(layer, shown));
    });

    const instruments = (this.instruments = new InstrumentStep({
      model,
      runner: host.runner,
      omr: () => host.omr(),
      naming: () => host.naming(),
      layoutStep: () => steps.layoutStep,
      canEdit,
      taskId: () => host.taskId(),
      data: () => host.data(),
      services: () => host.services(),
      commit: () => ed.commit(),
    }));
    const transcriber = (this.transcriber = new StaffTranscription({
      omr: () => host.omr(),
      naming: () => host.naming(),
      step4: () => steps.step4,
      canEdit,
      data: () => host.data(),
      pages: () => model.pages,
      services: () => host.services(),
    }));

    this.work = {
      get omr() {
        return host.omr();
      },
      get naming() {
        return host.naming();
      },
      get pages() {
        return model.pages;
      },
      get rawLayouts() {
        return model.rawLayouts;
      },
      get named() {
        return model.named;
      },
      get recognition() {
        return transcriber.recognition;
      },
      get seen() {
        return model.seen;
      },
      get shownNamed() {
        return instruments.shownNamed;
      },
      get namingModels() {
        return instruments.namingModels;
      },
      get runningKey() {
        return transcriber.runningKey;
      },
      get recognisedKey() {
        return transcriber.recognisedKey;
      },
      get staffKey() {
        return transcriber.staffKey;
      },
    };

    this.detection = new LayoutDetection({
      model,
      runner: host.runner,
      omr: () => host.omr(),
      canEdit,
      data: () => host.data(),
      taskId: () => host.taskId(),
      services: () => host.services(),
      detected: () => {
        this.setLayoutStep(1);
        ed.resetHistory();
      },
    });
  }

  /** A touch screen. */
  get coarse(): boolean {
    return this.#coarseQuery.current;
  }

  /** A page's boxes in a layer, the active one by default. */
  items = (p: number, layer: Layer = this.steps.tool) =>
    this.model.items(p, layer);

  // Why the task cannot be submitted yet, or null when it can.
  submitBlock = $derived.by(() => submitBlockOf(this.work));

  // What one box of the active layer is called.
  boxName = $derived.by(() => boxNameOf(this.steps.tool));

  /**
   * Take loaded pages as the working copy, with a new history. With
   * `continuing`, an edit switched to from a review continues at the step
   * that was in view: the steps before it count as checked, and at the
   * instruments step it starts at the first system.
   */
  load(d: CorrectorInput, continuing: boolean) {
    const { steps, model, view, ed } = this;
    ed.clear();
    view.anchor = { page: 0, frac: 0 };
    model.load(d);
    const from = steps.editFrom;
    steps.editFrom = null;
    if (from && continuing) {
      for (const layer of STEP_LAYERS.slice(0, from - 1))
        model.seen[layer] = model.pages.map((_, p) => p);
      if (from === 4) {
        model.named = { ...model.named, fixed: false };
        view.step4Pages = false;
        view.step4Top.names = view.step4Top.pages = 0;
        tick().then(() => view.desk?.scrollTo({ top: 0 }));
      }
    }
    ed.resetHistory();
  }

  /** The draft of the work. */
  draft = () => draftInput(this.work, this.#host.layoutModel);

  /** A layout task's submission, without its task id. */
  layoutSubmission = () => layoutSubmission(this.work, this.#host.layoutModel);

  /** The pages as a measure correction submits them. */
  pageModels = () => toPageModels(this.model.pages, this.#host.omr());

  // Each step starts at the top of the first page.
  setLayoutStep = (step: LayoutStep) => {
    this.steps.layoutStep = step;
    this.view.step4Pages = false;
    this.view.step4Top.names = this.view.step4Top.pages = 0;
    this.ed.setDrawMode(false);
    this.view.showPage(0);
  };

  // Page p's boxes changed: re-sort the active layer and record the step.
  settle = (p: number) => {
    this.model.resortLayer(p, this.steps.tool);
    this.ed.commit();
  };

  // The page's keys. Text fields keep their own keys; undo, redo and Esc
  // work from any other control; the editing keys (A, D, N, Delete, the
  // arrows) only on the pages or with nothing focused, so a key on a panel
  // control never moves a box or turns a page. While a drag or a Shift+drag
  // is under way, Esc undoes it and the other keys do nothing.
  keydown = (e: KeyboardEvent) => {
    const { ed, sel, view } = this;
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable]")) return;
    if (ed.keydown(e)) return;
    if (
      e.key === "Escape" &&
      (this.helpOpen || this.viewOpen || sel.selected)
    ) {
      if (this.helpOpen) this.helpOpen = false;
      else if (this.viewOpen) this.viewOpen = false;
      else ed.select(0, null);
      return;
    }
    if (target !== document.body && !target.closest(".desk")) return;
    if ((e.key === "Delete" || e.key === "Backspace") && sel.selected) {
      e.preventDefault();
      ed.deleteSelection();
    } else if (
      (e.key === "a" || e.key === "A" || e.key === "d" || e.key === "D") &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      // The keys leave the view where it is.
      sel.stepSelection(e.key === "a" || e.key === "A" ? -1 : 1, false);
    } else if (
      (e.key === "n" || e.key === "N") &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      sel.newBox();
    } else if (
      e.key.startsWith("Arrow") &&
      this.#host.canEdit() &&
      sel.selectedItem
    ) {
      // A selected box takes the arrow keys; without one, ← → turn pages.
      ed.nudge(e, sel.selectedItem.p, sel.selectedItem.item);
    } else if (e.key === "ArrowRight") {
      view.go(1);
    } else if (e.key === "ArrowLeft") {
      view.go(-1);
    }
  };

  // A press outside the View options closes them.
  closeViewOutside = (e: PointerEvent) => {
    if (this.viewOpen && !(e.target as Element).closest(".viewmenu, .viewbtn"))
      this.viewOpen = false;
  };
}
