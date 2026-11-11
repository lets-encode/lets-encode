// The full-page score view over the board: addressed by ?score=<piece path>
// (and an optional 1-based ?page=), read reactively so back/forward
// navigate it; the open task's ?task= survives entering and leaving it.
// Focus follows the view, and the header's score button opens it where the
// page's attention is.
//
// Constructed during a component's initialisation: the effect runs for the
// component's lifetime.

import { page } from "$app/state";
import { goto } from "$app/navigation";
import { tick } from "svelte";
import type ScoreView from "../components/ScoreView.svelte";
import type { BoardCard } from "../campaign-board.ts";
import { pageOfLocator, taskHref } from "../campaign-graph.ts";
import { commentAnchor, pieceLabel } from "../campaign-tables.ts";
import type { CommentRow, MeasureAnchor } from "../campaign-tables.ts";
import type { BoardModel } from "./board-model.svelte.ts";
import type { TaskSelection } from "./task-selection.svelte.ts";

export class ScoreNav {
  #model: BoardModel;
  #selection: TaskSelection;
  #campaign: () => string;

  scoreView = $derived.by(() => {
    const path = page.url.searchParams.get("score");
    if (!path) return null;
    const index = this.#model.previewPieces.findIndex((p) => p.path === path);
    return index >= 0
      ? { piece: this.#model.previewPieces[index], index }
      : null;
  });
  startPage = $derived(
    Math.max(0, (Number(page.url.searchParams.get("page")) || 1) - 1),
  );
  // The measure range the score view opens highlighted (from a comment
  // anchor); within the view, anchors work without navigation.
  anchor = $state<MeasureAnchor | null>(null);
  scoreViewRef = $state<ReturnType<typeof ScoreView>>();
  // Focus follows the score view: to its heading when it opens or shows
  // another piece, and on close back to the element it was opened from, or
  // to the View score button when that element is gone.
  #returnFocus: HTMLElement | null = null;
  viewScoreButton = $state<HTMLButtonElement>();
  #focusedScore: string | null = null;

  // The header's score button opens the score where the view's attention is:
  // the selected task's pages, else the piece the board is scoped to, else
  // the next task's pages, else the first piece.
  scoreTarget = $derived.by(
    () =>
      this.#selection.detailCard ??
      (this.#model.railPiece ? null : this.#model.nextCard) ??
      this.#model.railPiece?.piece ??
      this.#model.previewPieces[0] ??
      null,
  );
  scoreHint = $derived(
    !this.scoreTarget
      ? ""
      : "task" in this.scoreTarget
        ? `Opens the score at ${this.scoreTarget.title}.`
        : `Opens the score of ${pieceLabel(this.scoreTarget)}.`,
  );
  canViewScore = $derived.by(
    () => this.#model.previewPieces.length > 0 && !!this.scoreTarget,
  );

  constructor(
    model: BoardModel,
    selection: TaskSelection,
    campaign: () => string,
  ) {
    this.#model = model;
    this.#selection = selection;
    this.#campaign = campaign;
    $effect(() => {
      const path = this.scoreView?.piece.path ?? null;
      if (path === this.#focusedScore) return;
      this.#focusedScore = path;
      void tick().then(() => {
        if (path) {
          this.scoreViewRef?.focusHeading();
          return;
        }
        const target = this.#returnFocus?.isConnected
          ? this.#returnFocus
          : this.viewScoreButton;
        this.#returnFocus = null;
        target?.focus();
      });
    });
  }

  // The open task's ?task= survives entering and leaving the score view.
  openScoreView = (
    path: string,
    startPage?: number,
    a: MeasureAnchor | null = null,
  ) => {
    this.anchor = a;
    if (!this.scoreView)
      this.#returnFocus =
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body
          ? document.activeElement
          : null;
    const query = new URLSearchParams();
    if (this.#selection.detailTask)
      query.set("task", this.#selection.detailTask);
    query.set("score", path);
    if (startPage) query.set("page", String(startPage + 1));
    // The score already open turns in place; the URL follows without a new
    // history entry.
    const same = this.scoreView?.piece.path === path;
    if (same) this.scoreViewRef?.show(startPage, a);
    goto(`/${this.#campaign()}?${query}`, {
      noScroll: true,
      keepFocus: true,
      replaceState: same,
    });
  };

  closeScoreView = () => {
    goto(taskHref(this.#campaign(), this.#selection.detailTask), {
      noScroll: true,
      keepFocus: true,
    });
  };

  viewScorePiece = (index: number, startPage?: number) => {
    const path = this.#model.previewPieces[index]?.path;
    if (path) this.openScoreView(path, startPage);
  };

  // A task's score view opens at its page when the task covers one surface.
  #cardPage = (card: BoardCard) => String(pageOfLocator(card.locator) ?? "");
  viewCardScore = (card: BoardCard) => {
    const page = this.#cardPage(card);
    this.viewScorePiece(
      this.#model.pieceIndexByTask.get(card.task) ?? 0,
      page ? Number(page) - 1 : undefined,
    );
  };

  viewContextScore = () => {
    if (!this.scoreTarget) return;
    if ("task" in this.scoreTarget) this.viewCardScore(this.scoreTarget);
    else
      this.viewScorePiece(this.#model.previewPieces.indexOf(this.scoreTarget));
  };

  // A comment anchor outside the score view: open it on the comment's piece,
  // at the anchored page, with the range highlighted.
  showCommentInScore = (c: CommentRow) => {
    const path = c.task_id
      ? this.#model.previewPieces[
          this.#model.pieceIndexByTask.get(c.task_id) ?? -1
        ]?.path
      : c.fragment;
    if (!path) return;
    this.openScoreView(
      path,
      c.page ? Number(c.page) - 1 : undefined,
      commentAnchor(c),
    );
  };
}
