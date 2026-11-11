// The commands the campaign page runs: claims, the editor hand-off,
// submissions, comments, the reaper and plan saves. Each runs through the
// page's command runner, which shows the busy overlay and its result, and
// refreshes the tables afterwards.

import { goto } from "$app/navigation";
import { forge } from "../auth.svelte.ts";
import { openMeiFriend, type CommandRunner } from "../command-runner.svelte.ts";
import type { ForgeClient } from "../forge/types.ts";
import { commands, invoke, commentInput } from "../commands.ts";
import type {
  CommandContext,
  CommentAnchorInput,
  Result,
} from "../commands.ts";
import { reviewHref, taskAction, taskActionHref } from "../campaign-graph.ts";
import type { BoardCard } from "../campaign-board.ts";
import type { TaskRow } from "../campaign-tables.ts";
import { pendingVerdicts } from "../pending-verdicts.svelte.ts";

export interface CampaignActionHooks {
  campaign: () => string;
  repoId: () => number;
  taskDefs: () => TaskRow[];
  ctx: (f: ForgeClient) => CommandContext;
  /** Read the tables again. */
  load: () => Promise<void>;
  /** Acting on a task ends another task's highlight and error. */
  actedOn: (task: string) => void;
  /** Open the task's detail in the side panel. */
  openTask: (task: string) => void;
  /** A clean plan save leaves the manage takeover. */
  planSaved: () => void;
}

export class CampaignActions {
  #runner: CommandRunner;
  #h: CampaignActionHooks;

  constructor(runner: CommandRunner, h: CampaignActionHooks) {
    this.#runner = runner;
    this.#h = h;
  }

  // Run a command: show the busy overlay, capture its result banner, then
  // refresh the tables.
  run = async (
    command: (c: CommandContext) => Promise<Result>,
    refresh = true,
  ) => {
    const f = forge();
    if (!f) return null;
    return this.#runner.run(
      () => command(this.#h.ctx(f)),
      async (result) => {
        // A background command changed nothing yet — the settle listener
        // refreshes when its verdict lands.
        if (refresh && !result.background) {
          this.#runner.log.step("Refreshing tables…");
          await this.#h.load();
        }
      },
    );
  };

  // Claiming a validation slot opens the place the review happens — a
  // pre-task's own editor, or the review view for encoding tasks — but only
  // on a clean claim, so a rejected claim leaves you on the campaign page.
  claimValidate = async (task_id: string, subtask_id: string) => {
    this.#h.actedOn(task_id);
    const result = await this.run((c) =>
      invoke(commands.claimValidation, { task_id, subtask_id }, c),
    );
    if (!result?.ok || result.outcome === "pending") return;
    const locator = this.#h
      .taskDefs()
      .find((t) => t.task_id === task_id && t.subtask_id === "")?.locator;
    await goto(reviewHref(this.#h.campaign(), locator ?? "", task_id));
  };

  // Open the task's score in mei-friend (claiming it if needed). The page
  // navigates only after the claim has gone through — never on a rejected or
  // still-pending claim — so it waits until the busy overlay is gone.
  editor = async (task_id: string) => {
    // A claim still being processed holds the editor until its verdict lands.
    if (
      pendingVerdicts.isProcessing(
        { kind: "claim", task: task_id },
        this.#h.repoId(),
      )
    )
      return;
    this.#h.actedOn(task_id);
    const result = await this.run((c) =>
      invoke(
        commands.openEditor,
        { task_id, campaign: this.#h.campaign(), base: location.origin },
        c,
      ),
    );
    openMeiFriend(result);
  };

  submitpr = (task_id: string) =>
    this.run((c) => invoke(commands.submitEncoding, { task_id }, c));

  abandon = (task_id: string, subtask_id: string) => {
    this.#h.actedOn(task_id);
    return this.run((c) =>
      invoke(commands.abandon, { task_id, subtask_id }, c),
    );
  };

  postComment = (
    task_id: string,
    kind: string,
    body: string,
    parent_id: string,
    at?: CommentAnchorInput,
  ) =>
    this.run((c) =>
      invoke(
        commands.submitComment,
        commentInput(task_id, kind, body, parent_id, at),
        c,
      ),
    );

  resolveCommentRow = (comment_id: string) =>
    this.run((c) => invoke(commands.resolveComment, { comment_id }, c));

  reaper = () => this.run((c) => invoke(commands.runReaper, {}, c));

  // Save the edited plan; a clean save leaves the manage takeover (run() has
  // already refreshed the tables, so the board reflects the new plan).
  savePlan = async (tasks: TaskRow[], base: TaskRow[]) => {
    const result = await this.run((c) =>
      invoke(commands.savePlan, { tasks, base }, c),
    );
    if (result?.ok) this.#h.planSaved();
  };

  // Claim an open task where taskAction sends it: a page in the app, else
  // mei-friend through the editor command.
  claimCard = (card: BoardCard) => {
    this.#h.actedOn(card.task);
    const href = taskActionHref(
      this.#h.campaign(),
      card,
      taskAction(card, "claim"),
    );
    if (href) goto(href);
    else this.editor(card.task);
  };

  // Act on a card the viewer can work on: claim it when it is open, claim its
  // free validation slot when it awaits review, otherwise open its detail
  // (their claimed work lives there).
  actOnCard = (card: BoardCard) => {
    if (card.column === "ready") {
      this.claimCard(card);
      return;
    }
    const sub = card.slots.find((s) => s.claimable)?.sub;
    if (card.column === "validation" && sub !== undefined) {
      this.#h.actedOn(card.task);
      this.claimValidate(card.task, sub);
    } else this.#h.openTask(card.task);
  };
}
