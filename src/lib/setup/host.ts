// What the score setup is given by the page that hosts it: the score to set
// up and the recognition done for it over the network.

import type { PageModel, ParsedFacsimile } from "../mei-facsimile.ts";
import type { PieceRecognition } from "../omr-piece-recognition.ts";
import type { OmrRecord } from "../omr-record.ts";

/** The score to set up. */
export interface SetupInput {
  model: ParsedFacsimile;
  /** Per page (same order as model.pages), the address of its image. */
  imageUrls: string[];
  /** The piece's preparation, one of PREPARATIONS. */
  preparation: string;
}

/** The work done for the setup over the network. */
export interface SetupServices {
  /**
   * Transcribe the staves of `pages` and read their labels; `known` is the
   * record of this session, in whose place the saved one is used when null.
   */
  recogniseStaves(
    pages: PageModel[],
    known: OmrRecord | null,
    progress: (step: string) => void,
  ): Promise<PieceRecognition>;
}
