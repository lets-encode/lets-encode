// The return from mei-friend: mei-friend returns the volunteer to
// /<campaign>?task=<id>&mf_status=complete|failed|abandoned (with an optional
// mf_msg). `complete` submits the encoding, `abandoned` abandons the claim,
// `failed` shows mei-friend's message in the side panel. Also the "Just
// completed" highlight of the task mei-friend reported complete.
//
// Constructed during a component's initialisation: the effect runs for the
// component's lifetime.

import { takeHandOff } from "../command-runner.svelte.ts";
import type { Result } from "../commands.ts";
import { encodingClaimOf } from "../campaign-claim.ts";
import type { LockRow } from "../campaign-tables.ts";
import type { PendingVerdict } from "../pending-verdicts.svelte.ts";

/** An error from the return from mei-friend, shown in the task's panel;
    `label` names mei-friend when the text is its own message. */
export interface EditorError {
  task: string;
  label: string;
  text: string;
  confirm?: { label: string; run: () => void };
}

export interface EditorReturnHooks {
  campaign: () => string;
  locks: () => LockRow[];
  viewer: () => string;
  repoId: () => number;
  /** Submit the task's encoding for review. */
  submit: (task: string) => Promise<Result | null>;
  /** Give back the viewer's claim on the task. */
  abandon: (task: string) => void;
}

// The longest message from mei-friend the panel shows.
const MAX_EDITOR_MESSAGE = 500;
const COMPLETED_HIGHLIGHT_MS = 5 * 60_000;

export class EditorReturn {
  editorError = $state<EditorError | null>(null);
  // A task mei-friend returned from that the plan no longer has.
  returnedGone = $state<string | null>(null);
  /** The task mei-friend just reported complete, highlighted until `until`. */
  completed = $state<{ task: string; until: number } | null>(null);
  completedTask = $derived(this.completed?.task ?? null);

  #h: EditorReturnHooks;

  constructor(h: EditorReturnHooks) {
    this.#h = h;
    $effect(() => {
      if (!this.completed) return;
      const timer = setTimeout(
        () => (this.completed = null),
        this.completed.until - Date.now(),
      );
      return () => clearTimeout(timer);
    });
  }

  // Acting on another task ends the highlight and the reported error.
  actedOn = (task: string) => {
    if (this.completed && this.completed.task !== task) this.completed = null;
    if (this.editorError && this.editorError.task !== task)
      this.editorError = null;
  };

  // A rejected submission ends the task's "Just completed" highlight; a
  // failed run is followed on until the submission is decided.
  settled = (entry: PendingVerdict) => {
    if (
      entry.repoId === this.#h.repoId() &&
      entry.state === "rejected" &&
      !entry.runFailed &&
      entry.key.kind === "encode" &&
      entry.key.task === this.completed?.task
    )
      this.completed = null;
  };

  #holdsEncoding = (task: string) =>
    encodingClaimOf(this.#h.locks(), task, this.#h.viewer()) !== undefined;

  handle(task: string, status: string, msg: string) {
    console.log("[editor-return]", task, status, {
      holds: this.#holdsEncoding(task),
      msg,
    });
    // A status other than mei-friend's three is shown and keeps this
    // browser's record of the hand-off; any of the three uses it up.
    if (!["complete", "failed", "abandoned"].includes(status)) {
      this.editorError = {
        task,
        label: "",
        text: `mei-friend returned an unknown status (${status.slice(0, 40)}); nothing was recorded.`,
      };
      return;
    }
    const handedOff = takeHandOff(this.#h.campaign(), task);
    if (status === "failed") {
      // mei-friend's own message only for a hand-off this browser made: the
      // return URL is a link anyone can build.
      this.editorError =
        msg && handedOff
          ? {
              task,
              label: "Message from mei-friend",
              text: msg.slice(0, MAX_EDITOR_MESSAGE),
            }
          : {
              task,
              label: "",
              text: "mei-friend reported that the task could not be completed.",
            };
      return;
    }
    if (!this.#holdsEncoding(task)) {
      this.editorError = {
        task,
        label: "",
        text:
          status === "complete"
            ? "mei-friend reported the task complete, but you do not hold its claim, so nothing was submitted."
            : "mei-friend reported the task abandoned, but you do not hold its claim.",
      };
      return;
    }
    // A return this browser did not hand off may come from a link someone
    // else built, so it waits for the volunteer.
    if (!handedOff) {
      this.editorError =
        status === "complete"
          ? {
              task,
              label: "",
              text: "mei-friend reported the task complete, but it was not opened from this browser, so nothing was submitted yet.",
              confirm: {
                label: "Submit for review",
                run: () => this.submitCompleted(task),
              },
            }
          : {
              task,
              label: "",
              text: "mei-friend reported the task abandoned, but it was not opened from this browser, so the claim was kept.",
            };
      return;
    }
    if (status === "complete") this.submitCompleted(task);
    else this.#h.abandon(task);
  }

  async submitCompleted(task: string) {
    this.editorError = null;
    this.completed = { task, until: Date.now() + COMPLETED_HIGHLIGHT_MS };
    // A submission that could not be opened is not completed.
    const result = await this.#h.submit(task);
    if (!result?.ok && this.completed?.task === task) this.completed = null;
  }
}
