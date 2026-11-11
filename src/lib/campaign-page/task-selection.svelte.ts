// The selected task: its detail opens in the side panel; the URL carries it
// as ?task= so the row stays addressable (deep links, post-login resume).
// Also the lane the narrow board shows (lane tabs).
//
// Constructed during a component's initialisation: the effect runs for the
// component's lifetime.

import { page } from "$app/state";
import { goto } from "$app/navigation";
import { tick } from "svelte";
import type { ColumnKey } from "../campaign-board.ts";
import { taskHref } from "../campaign-graph.ts";
import { writeLastTask } from "../side-panels.ts";
import type { BoardModel } from "./board-model.svelte.ts";
import { laneOf } from "./board-columns.ts";

export class TaskSelection {
  #model: BoardModel;
  #campaign: () => string;

  detailTask = $state<string | null>(null);
  detailCard = $derived.by(() =>
    this.detailTask
      ? (this.#model.allCards.find((c) => c.task === this.detailTask) ?? null)
      : null,
  );
  // The lane the narrow board shows (lane tabs): the one picked, else the
  // selected task's, else the next task's, else the first lane with cards.
  pickedLane = $state<ColumnKey | null>(null);
  laneTab = $derived.by<ColumnKey>(
    () =>
      this.pickedLane ??
      laneOf(this.detailCard) ??
      laneOf(this.#model.nextCard) ??
      this.#model.firstFilledLane,
  );

  constructor(model: BoardModel, campaign: () => string) {
    this.#model = model;
    this.#campaign = campaign;
    // The selected task's card is scrolled into the board's visible part, in
    // its lane and above a docked panel.
    $effect(() => {
      if (!this.detailTask) return;
      void tick().then(() =>
        document
          .querySelector<HTMLElement>('.card[aria-current="true"]')
          ?.scrollIntoView({ block: "nearest" }),
      );
    });
  }

  openTask = (task: string) => {
    this.detailTask = task;
    // The lane tabs follow the opened task again.
    this.pickedLane = null;
    writeLastTask(this.#campaign(), task);
    goto(taskHref(this.#campaign(), task), {
      replaceState: true,
      noScroll: true,
      keepFocus: true,
    });
  };

  // Deselect the task: the side panel shows the campaign. The score view's
  // parameters stay.
  closeTask = () => {
    this.detailTask = null;
    writeLastTask(this.#campaign(), null);
    const query = new URLSearchParams(page.url.searchParams);
    query.delete("task");
    const rest = query.toString();
    goto(`/${this.#campaign()}${rest ? `?${rest}` : ""}`, {
      replaceState: true,
      noScroll: true,
      keepFocus: true,
    });
  };
}
