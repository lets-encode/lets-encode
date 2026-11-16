// What the measure and layout correction is given by the page that hosts
// it: the pages to correct, the long work it may show, and the work done
// for it over the network.

import type {
  MeasureBox,
  PageModel,
  ParsedFacsimile,
} from "../mei-facsimile.ts";
import type { CocoLayout, LayoutInstruments } from "../omr-layout.ts";
import type { PieceRecognition } from "../omr-piece-recognition.ts";
import type { OmrRecord } from "../omr-record.ts";

/** The pages to correct. */
export interface CorrectorInput {
  model: ParsedFacsimile;
  /** Per page (same order as model.pages), the address of its image. */
  imageUrls: string[];
  /** Per page, the piece's regions on it in image pixels; empty where it
      covers the whole page. */
  regions: MeasureBox[][];
  /** The instruments named so far; null when none. */
  instruments: LayoutInstruments | null;
}

/** How long work ended. */
export interface WorkResult {
  ok?: boolean;
  /** An ok result of which part failed. */
  outcome?: "partial";
  error?: string;
  message?: string;
  /** Runs the failed work again. */
  retry?: () => void;
}

/** Long work as the host shows it: one at a time, its steps and its result. */
export interface CorrectorWork {
  readonly busy: boolean;
  readonly log: {
    step(text: string): void;
    detail(text: string): void;
  };
  run(work: () => Promise<WorkResult>): Promise<unknown>;
}

/** The work done for the correction over the network. */
export interface CorrectorServices {
  /** The layouts kept from an earlier detection, by page image. */
  keptLayouts(): Record<string, CocoLayout>;
  /** Drop the kept layouts. */
  forgetLayouts(): void;
  /** Fails when the recognition service cannot detect layouts. */
  checkLayoutService(): Promise<void>;
  /** Detect the layout of page `p` (0-based) with the image `image`, and keep it. */
  detectLayout(p: number, image: string): Promise<CocoLayout>;
  /**
   * Transcribe the staves of `pages`; `known` is the record of this session,
   * in whose place the saved one is used when null.
   */
  transcribeStaves(
    pages: PageModel[],
    known: OmrRecord | null,
    progress: (step: string) => void,
  ): Promise<PieceRecognition>;
  /** A page image; null when it cannot be read. */
  pageImage(image: string): Promise<Blob | null>;
}
