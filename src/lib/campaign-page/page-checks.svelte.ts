// Why each page of the selected task's piece is to be checked against the
// scan (omr-page-checks.ts), read once per piece whose layout task names
// its instruments; keyed by campaign repo and piece.
//
// Constructed during a component's initialisation: the effect runs for the
// component's lifetime.

import { readForge } from "../command-runner.svelte.ts";
import type { BoardCard } from "../campaign-board.ts";
import { pageOfLocator } from "../campaign-graph.ts";
import { findRow } from "../campaign-tables.ts";
import type { CampaignData } from "./campaign-data.svelte.ts";
import type { BoardModel } from "./board-model.svelte.ts";

export class PageChecks {
  // Per score: its page checks, null while they load, "failed" when they could
  // not be read (tried again on the next load of the page).
  by = $state<Record<string, string[][] | null | "failed">>({});

  #data: CampaignData;
  #owner: () => string;
  #repo: () => string;

  constructor(
    data: CampaignData,
    model: BoardModel,
    detailCard: () => BoardCard | null,
    owner: () => string,
    repo: () => string,
  ) {
    this.#data = data;
    this.#owner = owner;
    this.#repo = repo;
    $effect(() => {
      const card = detailCard();
      const fragment = card
        ? (findRow(data.taskDefs, card.task, "")?.fragment ?? "")
        : "";
      const key = this.#key(fragment);
      if (
        !card?.omr ||
        model.piecePreparations[fragment] !== "omr-instruments" ||
        key in this.by
      )
        return;
      this.by[key] = null;
      const at = { owner: owner(), repo: repo() };
      import("$lib/omr-page-checks.ts")
        .then((m) => m.loadPageChecks(readForge(), at.owner, at.repo, fragment))
        .then((checks) => (this.by[key] = checks))
        .catch(() => (this.by[key] = "failed"));
    });
  }

  #key = (fragment: string) => `${this.#owner()}/${this.#repo()}/${fragment}`;

  checksFor = (card: BoardCard) =>
    this.by[
      this.#key(findRow(this.#data.taskDefs, card.task, "")?.fragment ?? "")
    ];
  checksOf = (card: BoardCard): string[] => {
    const checks = this.checksFor(card);
    const n = pageOfLocator(card.locator);
    return (n && checks !== "failed" && checks?.[n - 1]) || [];
  };
}
