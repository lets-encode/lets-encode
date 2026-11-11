// The campaign page's board as the viewer sees it: the board built from the
// tables, the piece rail's selection and the stats bar's filter over it,
// and what the lanes, the rail and the headers show from them.

import { buildBoard, expiresIn } from "../campaign-board.ts";
import {
  pieceLabel,
  pieceNamesOf,
  piecePreparationsOf,
  pieceZone,
} from "../campaign-tables.ts";
import { pendingVerdicts } from "../pending-verdicts.svelte.ts";
import type { CampaignData } from "./campaign-data.svelte.ts";
import {
  attentionByPieceOf,
  attentionCardsOf,
  displayColumnsOf,
  firstFilledLaneOf,
  pieceIndexByTaskOf,
  pieceProgressOf,
  previewPiecesOf,
  railCountsOf,
  railOpenCountOf,
  scopeColumns,
  volStandingOf,
  type BoardScope,
} from "./board-columns.ts";

export class BoardModel {
  #data: CampaignData;
  #viewer: () => string;
  #repoId: () => number;

  // The stats bar's board filter: every task, or only those someone can act
  // on right now — claimable encodings and validations with a free slot.
  boardScope = $state<BoardScope>("all");
  // The piece the board is scoped to, or "all" for the full board.
  selectedPiece = $state<"all" | string>("all");
  showAttention = $state(false);

  previewPieces = $derived.by(() =>
    previewPiecesOf(this.#data.taskDefs, this.#data.pieces),
  );
  pieceNames = $derived.by(() => pieceNamesOf(this.#data.pieces));
  piecePreparations = $derived.by(() => piecePreparationsOf(this.#data.pieces));
  graphData = $derived.by(() => ({
    taskDefs: this.#data.taskDefs,
    rows: this.#data.rows,
    validationColumns: this.#data.validationColumns,
    locks: this.#data.locks,
    passThreshold: this.#data.passThreshold,
    allowSelfValidation: this.#data.allowSelfValidation,
  }));
  board = $derived.by(() =>
    buildBoard(
      this.graphData,
      this.#data.comments,
      this.#data.history,
      this.#viewer(),
      this.#data.logins,
      this.pieceNames,
      this.#data.now,
      this.piecePreparations,
    ),
  );
  allCards = $derived(this.board.columns.flatMap((c) => c.cards));
  pieceProgress = $derived.by(() =>
    pieceProgressOf(this.allCards, this.#data.taskDefs),
  );
  pieceIndexByTask = $derived.by(() =>
    pieceIndexByTaskOf(this.previewPieces, this.#data.taskDefs),
  );
  attentionCards = $derived(attentionCardsOf(this.allCards));
  attentionByPiece = $derived(
    attentionByPieceOf(
      this.attentionCards,
      this.previewPieces,
      this.pieceIndexByTask,
    ),
  );
  railCounts = $derived(
    railCountsOf(
      this.allCards,
      this.boardScope,
      this.previewPieces,
      this.pieceIndexByTask,
    ),
  );
  // Cards name their piece only while the board shows several pieces.
  piecesListed = $derived(
    this.previewPieces.length > 1 && this.selectedPiece === "all",
  );
  railPiece = $derived.by(() => {
    const index = this.previewPieces.findIndex(
      (p) => p.path === this.selectedPiece,
    );
    return index >= 0 ? { piece: this.previewPieces[index], index } : null;
  });
  // Tasks the viewer's accepted submissions just moved on this campaign's
  // board, highlighted in their new column for a short while.
  recentlyFinished = $derived.by(
    () =>
      new Set(
        pendingVerdicts.recentlyFinished
          .filter((m) => m.repoId === this.#repoId())
          .map((m) => m.task),
      ),
  );
  nextCard = $derived(
    this.board.nextUp
      ? (this.allCards.find((c) => c.task === this.board.nextUp) ?? null)
      : null,
  );
  volStanding = $derived.by(() =>
    volStandingOf(
      this.#viewer(),
      this.#data.history,
      this.allCards,
      this.#data.locks,
    ),
  );
  displayColumns = $derived(displayColumnsOf(this.board.columns));
  scopedColumns = $derived(
    scopeColumns(
      this.displayColumns,
      this.selectedPiece,
      this.boardScope,
      this.previewPieces,
      this.pieceIndexByTask,
    ),
  );
  railOpenCount = $derived(
    railOpenCountOf(this.displayColumns, this.boardScope),
  );
  firstFilledLane = $derived(firstFilledLaneOf(this.scopedColumns));

  constructor(data: CampaignData, viewer: () => string, repoId: () => number) {
    this.#data = data;
    this.#viewer = viewer;
    this.#repoId = repoId;
  }

  /** When the claim on a held review slot expires. */
  reviewExpiry = (task: string, sub: string, user: string) => {
    const lock = this.#data.locks.find(
      (l) =>
        l.task_id === task &&
        l.subtask_id === sub &&
        l.kind === "validation" &&
        l.user_id === user,
    );
    return lock ? expiresIn(lock.expires, this.#data.now) : "";
  };

  // The side panel names its piece and carries its colour.
  pieceNameOf = (task: string) => {
    const p = this.previewPieces[this.pieceIndexByTask.get(task) ?? 0];
    return p ? pieceLabel(p) : "";
  };
  zoneOf = (task: string) => pieceZone(this.pieceIndexByTask.get(task) ?? 0);
}
