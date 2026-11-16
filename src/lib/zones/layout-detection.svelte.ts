// Layout detection (OMR-prepared pieces)
//
// A layout task's boxes come from the layout model, run by the host's
// services when the claim holder opens a task whose score carries no boxes
// yet. The result is seeded like measure detection's: reading order,
// continuous numbering, a system start on every row but the page's first.
// Each page's model output is kept by the services as it arrives and read
// back by the next detection, until the loaded score carries boxes.

import type { MeasureBox } from "../mei-facsimile.ts";
import {
  layoutBoxes,
  type CocoLayout,
  type PageLayout,
} from "../omr-layout.ts";
import { centreInRegions } from "../box-geometry.ts";
import type {
  CorrectorInput,
  CorrectorServices,
  CorrectorWork,
  WorkResult,
} from "./host.ts";
import { resort, resortStaves } from "./measures.ts";
import type { ZonePages } from "./zone-pages.svelte.ts";

export interface LayoutDetectionHost {
  model: ZonePages;
  runner: CorrectorWork;
  /** The task corrects an OMR layout. */
  omr(): boolean;
  canEdit(): boolean;
  data(): CorrectorInput | null;
  taskId(): string;
  /** The network work; null while it is not available. */
  services(): CorrectorServices | null;
  /** The detected boxes open at the first step, as a new history. */
  detected(): void;
}

export class LayoutDetection {
  /** The task a detection was started for. */
  detectedFor = $state<string | null>(null);
  #host: LayoutDetectionHost;

  constructor(host: LayoutDetectionHost) {
    this.#host = host;
    $effect(() => {
      const boxed = this.#host
        .data()
        ?.model.pages.some(
          (pg) => pg.zones.length > 0 || (pg.staves?.length ?? 0) > 0,
        );
      if (this.#host.omr() && boxed) {
        this.#host.services()?.forgetLayouts();
      }
    });
    $effect(() => {
      if (
        this.#host.data() &&
        !this.#host.runner.busy &&
        this.detectedFor !== this.#host.taskId() &&
        this.needsDetection()
      ) {
        this.detectedFor = this.#host.taskId();
        this.detectLayout();
      }
    });
  }

  /** The claim holder has an OMR layout task whose pages carry no boxes. */
  needsDetection = () =>
    this.#host.omr() &&
    this.#host.canEdit() &&
    this.#host.model.pages.length > 0 &&
    this.#host.model.pages.every(
      (pg) => pg.zones.length === 0 && pg.staves.length === 0,
    );

  get #pages() {
    return this.#host.model.pages;
  }

  #seedLayout() {
    this.#pages.forEach((_, p) => resort(this.#pages, p));
  }

  detectLayout = async () => {
    const services = this.#host.services();
    if (!services || !this.#host.data()) return;
    await this.#host.runner.run(() => this.detectSteps(services));
  };

  // The detection steps, logged to the running command's overlay.
  async detectSteps(services: CorrectorServices): Promise<WorkResult> {
    const runner = this.#host.runner;
    const cached = services.keptLayouts();
    try {
      if (!this.#pages.every((pg) => cached[pg.image])) {
        runner.log.step("Checking the recognition service");
        await services.checkLayoutService();
      }
      let measures = 0;
      let staves = 0;
      let grandstaves = 0;
      // The pages take their boxes once every page is detected: a run that
      // fails part way leaves all pages without boxes, which offers the retry.
      const detected: { layout: CocoLayout; boxes: PageLayout }[] = [];
      for (const [p, pg] of this.#pages.entries()) {
        runner.log.step(
          `Detecting the layout of page ${p + 1} of ${this.#pages.length}`,
        );
        let layout = cached[pg.image];
        if (layout) {
          runner.log.detail(
            "Result stored in this browser from an earlier detection",
          );
        } else {
          layout = await services.detectLayout(p, pg.image);
        }
        // The model reads the whole page; the piece keeps the boxes in its
        // regions.
        const all = layoutBoxes(layout, pg);
        const inPiece = (box: MeasureBox) => centreInRegions(box, pg.regions);
        const boxes = {
          measures: all.measures.filter(inPiece),
          staves: all.staves.filter(inPiece),
          grandstaves: all.grandstaves.filter(inPiece),
        };
        detected.push({ layout, boxes });
        measures += boxes.measures.length;
        staves += boxes.staves.length;
        grandstaves += boxes.grandstaves.length;
        runner.log.detail(
          `${boxes.staves.length} staves, ${boxes.grandstaves.length} grand staves, ${boxes.measures.length} measures`,
        );
      }
      for (const [p, { layout, boxes }] of detected.entries()) {
        this.#host.model.rawLayouts[p] = layout;
        this.#pages[p].zones = boxes.measures.map((box) => ({
          box,
          override: null,
          label: "",
          sb: false,
          sbOverride: null,
          mdiv: false,
          pickup: false,
        }));
        this.#pages[p].staves = boxes.staves.map((box) => ({ box }));
        this.#pages[p].grandstaves = boxes.grandstaves.map((box) => ({ box }));
        resortStaves(this.#pages, p);
        resortStaves(this.#pages, p, "grandstaves");
      }
      this.#seedLayout();
      this.#host.detected();
      return {
        ok: true,
        message: `Layout detected: ${staves} staves, ${grandstaves} grand staves and ${measures} measures on ${this.#pages.length} page(s).`,
      };
    } catch (e) {
      return {
        error: `Layout detection failed: ${(e as Error).message}`,
        retry: this.detectLayout,
      };
    }
  }
}
