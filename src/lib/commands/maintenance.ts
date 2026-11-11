// The owner's direct commands: saving the task plan and dispatching the
// stale-lock reaper.

import { sleep } from "../util.ts";
import {
  parseTaskCsv,
  parseStateCsv,
  parseLockCsv,
  parseHistoryCsv,
  serializeStateCsv,
  serializeTaskCsv,
  HISTORY_PATH,
  LOCK_PATH,
  STATE_PATH,
  TASK_PATH,
} from "../campaign-tables.ts";
import type { TaskRow } from "../campaign-tables.ts";
import { checkPlan } from "../campaign-plan.ts";
import { WorkflowRunWatch } from "../run-watch.ts";
import type { CommandDef, Result } from "./core.ts";

// Rewrite the task plan (task.csv + the matching state.csv rows) from the
// app's plan editor. Owner-only: the rewrite is committed directly, so it
// requires push access; checkPlan re-validates against fresh tables so a claim
// that landed while editing rejects the save rather than being overwritten.
// `base` is the task table the editor opened with: a task.csv changed since
// (a replan of page tasks, a save from another tab) refuses the save, since
// the edited table would undo those changes for every task not yet started.
const PLAN_REJECTIONS: Record<string, string> = {
  empty_plan: "The plan has no tasks — a campaign needs at least one.",
  duplicate_row: "The plan lists the same task twice.",
  missing_task_id: "A task row has no id.",
  missing_fragment: "Every task needs a score file (fragment).",
  orphan_subtask: "A review subtask points at a task that is not in the plan.",
  unknown_dependency: "A task depends on a task that is not in the plan.",
  dependency_cycle:
    "The dependencies run in a circle — no task could ever be claimed.",
  task_in_progress:
    "A task someone has already worked on or claimed was changed or removed — refresh and edit again.",
  plan_changed:
    "The plan was changed while you were editing it. Cancel, open the plan editor again and repeat your edits.",
};

const savePlan: CommandDef<{ tasks: TaskRow[]; base: TaskRow[] }, Result> = {
  id: "campaign.savePlan",
  version: 1,
  log: "direct",
  envelopeInput: ({ tasks }) => ({
    tasks: tasks.filter((t) => t.subtask_id === "").map((t) => t.task_id),
  }),
  async run({ tasks, base }, ctx) {
    const { forge: f, owner, repo } = ctx;
    try {
      ctx.progress({ step: "Checking the plan against the current tables…" });
      const { sha, canPush } = await f.getRepoHead(owner, repo);
      if (!canPush)
        return { error: "Only the campaign owner can edit the plan." };
      const [taskCsv, stateCsv, lockCsv, historyCsv] = await Promise.all([
        f.getRepoFile(owner, repo, TASK_PATH, sha),
        f.getRepoFile(owner, repo, STATE_PATH, sha),
        f.getRepoFile(owner, repo, LOCK_PATH, sha),
        f.getRepoFile(owner, repo, HISTORY_PATH, sha),
      ]);
      if (taskCsv == null || stateCsv == null)
        return { error: "Could not read the tracking tables." };
      if (serializeTaskCsv(parseTaskCsv(taskCsv)) !== serializeTaskCsv(base))
        return { error: PLAN_REJECTIONS.plan_changed };
      const state = parseStateCsv(stateCsv);
      const verdict = checkPlan(
        parseTaskCsv(taskCsv),
        state,
        parseLockCsv(lockCsv ?? ""),
        parseHistoryCsv(historyCsv ?? ""),
        tasks,
      );
      if (!verdict.ok) {
        return {
          error:
            PLAN_REJECTIONS[verdict.reason] ??
            `Plan rejected: ${verdict.reason}.`,
        };
      }
      ctx.progress({ step: "Committing the new plan…" });
      await f.commitFiles(
        owner,
        repo,
        [
          { path: TASK_PATH, content: serializeTaskCsv(tasks) },
          {
            path: STATE_PATH,
            content: serializeStateCsv({
              header: state.header,
              rows: verdict.stateRows,
            }),
          },
        ],
        "Edit the task plan",
        { baseSha: sha },
      );
      return { ok: true, message: "The plan is saved." };
    } catch (e) {
      return { error: `Saving the plan failed: ${(e as Error).message}` };
    }
  },
};

// Manually dispatch the scheduled reaper, then wait for its run to finish
// (there is no PR to watch — poll the dispatched workflow run instead).
// Dispatching requires push access, so the invocation is logged directly.
const runReaper: CommandDef<Record<string, never>, Result> = {
  id: "campaign.runReaper",
  version: 1,
  log: "direct",
  async run(_input, ctx) {
    const { forge: f, owner, repo } = ctx;
    try {
      ctx.progress({ step: "Dispatching the stale-lock reaper…" });
      const { branch } = await f.getRepoHead(owner, repo);
      const dispatchedAt = Date.now();
      console.log("[reaper] dispatching caller.yml on", branch);
      await f.dispatchWorkflow(owner, repo, "caller.yml", branch);
      // Only a run created after our dispatch counts (the watch applies
      // clock-skew slack to `since`). The watch narrates the wait for the
      // run itself, starting with the search for it.
      const watch = new WorkflowRunWatch(
        f,
        owner,
        repo,
        {
          workflow: "caller.yml",
          event: "workflow_dispatch",
          since: dispatchedAt,
        },
        ctx.progress,
      );
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await sleep(2000);
        await watch.tick();
        if (watch.state.phase === "completed") {
          const { conclusion, html_url } = watch.state.run;
          console.log("[reaper] run finished with conclusion:", conclusion);
          // Scheduled and dispatched runs share one queue, in which a newer
          // run replaces a waiting one: the scheduled run does the same work.
          if (conclusion === "cancelled") {
            return {
              ok: true,
              outcome: "pending",
              message:
                "The run was replaced by a scheduled run that does the same; refresh the tables once it has finished.",
            };
          }
          if (conclusion !== "success") {
            return {
              error: `The reaper run finished with "${conclusion}" — see ${html_url}.`,
            };
          }
          return { ok: true, message: "Stale-lock reaper finished." };
        }
      }
      return {
        ok: true,
        outcome: "pending",
        message:
          "Reaper dispatched; the run hasn’t finished yet — refresh the tables in a moment.",
      };
    } catch (e) {
      return { error: `Reaper dispatch failed: ${(e as Error).message}` };
    }
  },
};

export { runReaper, savePlan };
