// The ?task= of the page's URL: read once after the first load (a deep link,
// a return from mei-friend, or the owner's last task), and followed after it
// (a link, back or forward).
//
// Constructed during a component's initialisation: the effects run for the
// component's lifetime.

import { page } from "$app/state";
import { goto } from "$app/navigation";
import { auth } from "../auth.svelte.ts";
import { taskHref } from "../campaign-graph.ts";
import { findRow } from "../campaign-tables.ts";
import { readLastTask, writeLastTask } from "../side-panels.ts";
import type { CampaignData } from "./campaign-data.svelte.ts";
import type { TaskSelection } from "./task-selection.svelte.ts";
import type { EditorReturn } from "./editor-return.svelte.ts";

export interface DeepLinkHooks {
  campaign: () => string;
  viewer: () => string;
  /** The score view is open. */
  scoreView: () => boolean;
}

export class DeepLink {
  #deepLinked = false;
  #urlTask = page.url.searchParams.get("task");

  constructor(
    data: CampaignData,
    selection: TaskSelection,
    editorReturn: EditorReturn,
    h: DeepLinkHooks,
  ) {
    // Deep links, read once after the first load: ?task= opens that task's
    // detail. On the owner's board the side panel reopens the task chosen last
    // time, if any; the score view shows a task only from ?task=.
    $effect(() => {
      if (!data.loaded || this.#deepLinked) return;
      this.#deepLinked = true;
      const task = page.url.searchParams.get("task");
      if (task && findRow(data.taskDefs, task, "")) {
        selection.detailTask = task;
        const status = page.url.searchParams.get("mf_status");
        if (status) {
          // Logged out, the outcome waits in the URL; logging in returns here
          // with it.
          if (!auth.user) {
            editorReturn.editorError = {
              task,
              label: "",
              text: "Log in with GitHub to record the outcome from mei-friend.",
            };
            return;
          }
          const msg = page.url.searchParams.get("mf_msg") ?? "";
          // The outcome is handled once; a reload must not repeat it.
          goto(taskHref(h.campaign(), task), {
            replaceState: true,
            noScroll: true,
            keepFocus: true,
          });
          editorReturn.handle(task, status, msg);
        }
        return;
      }
      // A return from mei-friend for a task the plan no longer has records
      // nothing; it is said so, and the outcome is cleared from the URL.
      if (task && page.url.searchParams.has("mf_status")) {
        // The id comes from a link anyone can build; it is shown cut short.
        editorReturn.returnedGone = task.slice(0, 40);
        goto(`/${h.campaign()}`, { replaceState: true, noScroll: true });
        return;
      }
      // The owner's board reopens the task chosen last time only while it is
      // the owner's own claimed work; otherwise it opens on the campaign.
      if (!data.canPush || h.scoreView()) return;
      const last = readLastTask(h.campaign());
      if (
        last &&
        data.locks.some((l) => l.task_id === last && l.user_id === h.viewer())
      )
        selection.detailTask = last;
    });

    // After the first load, a change of ?task= (a link, back or forward) opens
    // that task, or the campaign when it is gone.
    $effect(() => {
      const task = page.url.searchParams.get("task");
      if (task === this.#urlTask) return;
      this.#urlTask = task;
      if (!this.#deepLinked) return;
      const found = task && findRow(data.taskDefs, task, "") ? task : null;
      if (found === selection.detailTask) return;
      selection.detailTask = found;
      selection.pickedLane = null;
      writeLastTask(h.campaign(), found);
    });
  }
}
