// The preview of the piece the board is scoped to, for the context strip
// over the lanes: its first page, page and measure counts and incipit,
// read again when the piece's score changes.
//
// Constructed during a component's initialisation: the effect runs for the
// component's lifetime.

import { readForge } from "../command-runner.svelte.ts";
import { piecePreview, scoreVersion } from "../piece-previews.ts";
import type { PiecePreview } from "../piece-previews.ts";
import type { CampaignData } from "./campaign-data.svelte.ts";
import type { BoardModel } from "./board-model.svelte.ts";

export class StripPreview {
  #data: CampaignData;
  #model: BoardModel;

  preview = $state<PiecePreview | null>(null);
  version = $derived.by(() =>
    this.#model.railPiece
      ? scoreVersion(
          this.#data.history,
          this.#data.taskDefs,
          this.#model.railPiece.piece.path,
        )
      : "",
  );
  // Raised by "Try again" to load a failed strip preview anew.
  attempt = $state(0);

  constructor(
    data: CampaignData,
    model: BoardModel,
    owner: () => string,
    repo: () => string,
  ) {
    this.#data = data;
    this.#model = model;
    $effect(() => {
      const piece = model.railPiece?.piece;
      void this.attempt;
      this.preview = null;
      if (!piece || !owner()) return;
      const path = piece.path;
      piecePreview(readForge(), owner(), repo(), path, true, this.version).then(
        (preview) => {
          if (model.railPiece?.piece.path === path) this.preview = preview;
        },
      );
    });
  }
}
