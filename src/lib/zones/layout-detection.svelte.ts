// Layout detection (OMR-prepared pieces)
//
// A layout task's boxes come from the Musibot layout model, run through
// the broker's relay when the claim holder opens a task whose score carries
// no boxes yet. Page bytes are read through the
// forge API; the result is seeded like measure detection's: reading order,
// continuous numbering, a system start on every row but the page's first.
// Each page's model output is stored in the browser as it arrives and read
// back by the next detection, until the loaded score carries boxes.

import { forge } from "../auth.svelte.ts";
import type { ForgeClient } from "../forge/types.ts";
import type { FacsimileTaskData, Result } from "../commands.ts";
import type { CommandRunner } from "../command-runner.svelte.ts";
import type { MeasureBox } from "../mei-facsimile.ts";
import type { createOmrClient } from "../omr-client.ts";
import {
  layoutBoxes,
  LAYOUT_PARAMETERS,
  type CocoLayout,
  type PageLayout,
} from "../omr-layout.ts";
import { omr as omrModels } from "../forge/config.ts";
import {
  clearCachedLayouts,
  readCachedLayouts,
  writeCachedLayout,
} from "../omr-layout-cache.ts";
import { resolveRepoRelativeTarget } from "../facsimile-images.ts";
import { centreInRegions } from "../box-geometry.ts";
import type { EditPage } from "./edit-pages.ts";
import { resort, resortStaves } from "./measures.ts";
import type { ZonePages } from "./zone-pages.svelte.ts";

export interface LayoutDetectionHost {
  model: ZonePages;
  runner: CommandRunner;
  /** The task corrects an OMR layout. */
  omr(): boolean;
  canEdit(): boolean;
  data(): FacsimileTaskData | null;
  taskId(): string;
  repoId(): number;
  owner(): string;
  repo(): string;
  omrClient(): ReturnType<typeof createOmrClient>;
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
        clearCachedLayouts(this.#host.repoId(), this.#host.taskId());
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
    const f = forge();
    const data = this.#host.data();
    if (!f || !data) return;
    const fragment = data.fragment;
    await this.#host.runner.run(() => this.detectSteps(f, fragment));
  };

  // The detection steps, logged to the running command's overlay.
  async detectSteps(f: ForgeClient, fragment: string): Promise<Result> {
    const runner = this.#host.runner;
    const client = this.#host.omrClient();
    const cached = readCachedLayouts(
      this.#host.repoId(),
      this.#host.taskId(),
      omrModels.layoutModel,
    );
    try {
      if (!this.#pages.every((pg) => cached[pg.image])) {
        runner.log.step("Checking the recognition service");
        await client.requirePipelines([omrModels.layoutModel]);
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
          layout = await this.#detectPage(f, client, fragment, p, pg);
          writeCachedLayout(
            this.#host.repoId(),
            this.#host.taskId(),
            omrModels.layoutModel,
            pg.image,
            layout,
          );
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

  // One page's layout from the model.
  async #detectPage(
    f: ForgeClient,
    client: ReturnType<typeof createOmrClient>,
    fragment: string,
    p: number,
    pg: EditPage,
  ): Promise<CocoLayout> {
    const path = resolveRepoRelativeTarget(fragment, pg.image);
    const image = path
      ? await f.getRepoFileBytes(this.#host.owner(), this.#host.repo(), path)
      : null;
    if (!image)
      throw new Error(
        `the image of page ${p + 1} (${pg.image}) could not be read.`,
      );
    return client.withPage(async (pageId) => {
      await client.upload(pageId, { "image.jpg": image });
      const execution = await client.run(
        pageId,
        omrModels.layoutModel,
        ["image.jpg"],
        LAYOUT_PARAMETERS,
      );
      if (execution.state !== "completed") {
        throw new Error(
          `the layout model failed on page ${p + 1}: ${execution.error ?? execution.state}.`,
        );
      }
      const files = await client.download(pageId, ["layout.json"]);
      return JSON.parse(await files["layout.json"].text()) as CocoLayout;
    });
  }
}
