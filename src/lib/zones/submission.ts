// What the measure correction saves and submits: the draft of the boxes,
// the submission's input, and why a submission is not possible yet.

import type { DraftInput } from "../commands.ts";
import type { PageModel } from "../mei-facsimile.ts";
import {
  layoutRecord,
  type CocoLayout,
  type LayoutInstruments,
} from "../omr-layout.ts";
import type { OmrPipeline } from "../omr-client.ts";
import { namingProblem, pruneInstruments } from "../instrument-naming.ts";
import { serializeOmrRecord } from "../omr-record.ts";
import type { PieceRecognition } from "../omr-piece-recognition.ts";
import {
  layerItems,
  STEP_LAYERS,
  toPageModels,
  type EditPage,
  type Layer,
} from "./edit-pages.ts";

/** The editor's work as the draft and the submission take it. */
export interface ZoneWork {
  readonly omr: boolean;
  /** The layout task also names the instruments. */
  readonly naming: boolean;
  readonly pages: EditPage[];
  /** The layout model's raw output per page index from this session. */
  readonly rawLayouts: Record<number, CocoLayout>;
  /** Every instrument named in the session. */
  readonly named: LayoutInstruments;
  readonly recognition: PieceRecognition | null;
}

/** What decides whether the work can be submitted. */
export interface SubmitState {
  readonly omr: boolean;
  readonly naming: boolean;
  readonly pages: EditPage[];
  /** The pages shown in each step. */
  readonly seen: Record<Layer, number[]>;
  readonly named: LayoutInstruments;
  /** The instruments some staff box shows. */
  readonly shownNamed: LayoutInstruments;
  /** The pages as the instruments step reads them. */
  readonly namingModels: PageModel[];
  /** The staff boxes of a transcription in progress; null when none runs. */
  readonly runningKey: string | null;
  /** The staff boxes the transcription describes. */
  readonly recognisedKey: string;
  /** The current staff boxes. */
  readonly staffKey: string;
}

export const pageList = (ps: number[]) => ps.map((p) => p + 1).join(", ");
export const pagesWord = (ps: number[]) =>
  `${ps.length === 1 ? "page" : "pages"} ${pageList(ps)}`;

// Why the task cannot be submitted yet, or null when it can. Submission
// waits until every page with boxes in a step has been on screen in that
// step: a page without any (no music, no braces) is a valid result that
// needs no look.
export function submitBlock(s: SubmitState): string | null {
  const unseen = (layer: Layer) =>
    s.pages.flatMap((pg, p) =>
      s.seen[layer].includes(p) || !layerItems(pg, layer).length ? [] : [p],
    );
  if (!s.omr) {
    const pending = unseen("measures");
    return pending.length
      ? `Show ${pagesWord(pending)} before submitting.`
      : null;
  }
  for (const [i, layer] of STEP_LAYERS.entries()) {
    const pending = unseen(layer);
    if (pending.length) {
      return `Show ${pagesWord(pending)} in step ${i + 1} before submitting.`;
    }
  }
  const noMeasures = s.pages.flatMap((pg, p) =>
    pg.staves.length && !pg.zones.length ? [p] : [],
  );
  if (noMeasures.length) {
    return `${noMeasures.length === 1 ? "Page" : "Pages"} ${pageList(noMeasures)} ${noMeasures.length === 1 ? "has" : "have"} staff boxes but no measures.`;
  }
  if (!s.naming) return null;
  if (!s.named.fixed)
    return "Name the other systems in step 4 (Other systems) before submitting.";
  const problem = namingProblem(s.shownNamed, s.namingModels);
  if (problem) return problem;
  if (s.runningKey !== null)
    return "Wait until the staves are transcribed before submitting.";
  if (s.recognisedKey !== s.staffKey)
    return "The staves have to be transcribed before submitting.";
  return null;
}

// The raw layouts go with the submission when this session detected every page.
export const rawLayoutRecord = (w: ZoneWork, layoutModel: OmrPipeline) =>
  w.pages.every((_, p) => w.rawLayouts[p])
    ? layoutRecord(
        layoutModel,
        w.pages.map((pg, p) => ({ image: pg.image, layout: w.rawLayouts[p] })),
      )
    : undefined;

// The instruments with only those some staff box shows. `named` keeps
// every instrument named in the session, so an undo can return to one.
export const shownInstruments = (w: ZoneWork): LayoutInstruments =>
  pruneInstruments(w.named, toPageModels(w.pages, w.omr));

/** The draft of the work: the pages, and for a layout task its side files. */
export function draftInput(
  w: ZoneWork,
  layoutModel: OmrPipeline,
): Omit<DraftInput, "task_id"> {
  return w.omr
    ? {
        pages: toPageModels(w.pages, w.omr),
        layout: true,
        rawLayout: rawLayoutRecord(w, layoutModel),
        ...(w.naming ? { instruments: shownInstruments(w) } : {}),
        ...(w.naming && w.recognition
          ? { omr: serializeOmrRecord(w.recognition.record) }
          : {}),
      }
    : { pages: toPageModels(w.pages, w.omr) };
}

/** A layout task's submission, without its task id. */
export const layoutSubmission = (w: ZoneWork, layoutModel: OmrPipeline) => ({
  pages: toPageModels(w.pages, w.omr),
  layout: rawLayoutRecord(w, layoutModel),
  ...(w.naming ? { instruments: shownInstruments(w) } : {}),
  ...(w.naming && w.recognition
    ? { omr: serializeOmrRecord(w.recognition.record) }
    : {}),
});
