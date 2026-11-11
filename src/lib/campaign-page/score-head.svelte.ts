// The score's <meiHead> fields, for the campaign details in the owner's
// side panel, read once the owner's tables are loaded.
//
// Constructed during a component's initialisation: the effect runs for the
// component's lifetime.

import { readForge } from "../command-runner.svelte.ts";
import { parseMeiHeader } from "../mei-header.ts";
import type { MeiHeader } from "../mei-header.ts";
import type { CampaignData } from "./campaign-data.svelte.ts";

export class ScoreHead {
  head = $state<MeiHeader | null>(null);
  state = $state<"idle" | "loading" | "done" | "error">("idle");

  #data: CampaignData;
  #owner: () => string;
  #repo: () => string;

  constructor(data: CampaignData, owner: () => string, repo: () => string) {
    this.#data = data;
    this.#owner = owner;
    this.#repo = repo;
    $effect(() => {
      if (data.loaded && data.canPush) this.load();
    });
  }

  async load() {
    if (this.state !== "idle") return;
    this.state = "loading";
    try {
      const f = readForge();
      const taskDefs = this.#data.taskDefs;
      // The first task's fragment is the piece the campaign opens on.
      const mei = taskDefs[0]?.fragment
        ? await f.getRepoFile(this.#owner(), this.#repo(), taskDefs[0].fragment)
        : null;
      this.head = mei ? parseMeiHeader(mei) : null;
      this.state = mei ? "done" : "error";
    } catch {
      this.state = "error";
    }
  }
}
