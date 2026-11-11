// Review verdicts and switching from reviewing to editing: the
// campaign.submitValidation and campaign.reviewEdit commands.

import { shortId } from "../util.ts";
import {
  parseStateCsv,
  parseLockCsv,
  serializeStateCsv,
  serializeLockCsv,
  appendComments,
  findRow,
  COMMENT_PATH,
  LOCK_PATH,
  STATE_PATH,
} from "../campaign-tables.ts";
import type { LockRow } from "../campaign-tables.ts";
import { reapLocks } from "../campaign-reaper.ts";
import { appendEnvelopeToPrBody } from "../command-envelope.ts";
import type { CommandDef, Result } from "./core.ts";
import { deleteTaskBranch } from "./task-branch.ts";
import {
  followInBackground,
  muteOnce,
  openAndFinishInBackground,
  readAtHead,
  verdictResult,
  waitForPrProcessed,
} from "./change-request.ts";
import type { PrProcessingResult } from "./change-request.ts";

/** The measure-anchored explanation a fail verdict must carry. */
export interface FailComment {
  body: string;
  /** 1-based facsimile page the comment anchors to; '' = unanchored. */
  page: string;
  measure_start: string;
  measure_end: string;
}

// Open a PR that sets the subtask's first open validation cell (pass/fail).
// A fail carries its mandatory comment as one appended comment.csv row in the
// same PR; the automation rejects a fail without one.
const submitValidation: CommandDef<
  {
    task_id: string;
    subtask_id: string;
    verdict: string;
    comment?: FailComment;
  },
  Result
> = {
  id: "campaign.submitValidation",
  version: 2,
  log: "pr",
  background: true,
  envelopeInput: ({ task_id, subtask_id, verdict }) => ({
    task_id,
    subtask_id,
    verdict,
  }),
  async run({ task_id, subtask_id, verdict, comment }, ctx, envelope) {
    const { forge: f, owner, repo } = ctx;
    if (verdict !== "pass" && verdict !== "fail") {
      return { error: `Invalid review verdict: ${verdict}.` };
    }
    if (verdict === "fail" && !comment?.body.trim()) {
      return {
        error:
          "A change request needs a note saying what to change — nothing was submitted.",
      };
    }
    const label = `Review of ${task_id}/${subtask_id} (${verdict === "pass" ? "approved" : "changes requested"})`;
    return openAndFinishInBackground(
      ctx,
      label,
      { kind: "validate", task: task_id, sub: subtask_id },
      async () => {
        await muteOnce(ctx);
        const {
          sha,
          files: [stateCsv, commentCsv],
        } = await readAtHead(ctx, [STATE_PATH, COMMENT_PATH]);
        const state = parseStateCsv(stateCsv ?? "");
        const row = findRow(state.rows, task_id, subtask_id);
        if (!row) throw new Error(`unknown subtask ${task_id}/${subtask_id}.`);
        const slot = state.validationColumns.find((c) => (row[c] ?? "") === "");
        if (!slot) {
          throw new Error(`no open review slot on ${task_id}/${subtask_id}.`);
        }
        row[slot] = verdict; // the Action re-authors this to `verdict|user|time`
        const files = [{ path: STATE_PATH, content: serializeStateCsv(state) }];
        if (verdict === "fail") {
          // The id, author and timestamp are the Action's to write.
          files.push({
            path: COMMENT_PATH,
            content: appendComments(commentCsv ?? "", [
              {
                comment_id: "",
                task_id,
                subtask_id,
                kind: "fail",
                page: comment!.page,
                measure_start: comment!.measure_start,
                measure_end: comment!.measure_end,
                author_id: "",
                timestamp: "",
                resolved: "",
                parent_id: "",
                body: comment!.body.trim(),
                fragment: "",
              },
            ]),
          });
        }
        const body = `Submits a ${verdict} review of ${task_id}/${subtask_id}. Opened from the app.`;
        console.log("[validate] opening validation PR", {
          task_id,
          subtask_id,
          verdict,
          slot,
        });
        const pr = await f.openChangePr(owner, repo, {
          branch: `validate-${task_id}-${subtask_id}-${shortId()}`,
          files,
          message: `Review ${task_id}/${subtask_id} (${verdict})`,
          title: `Review ${task_id}/${subtask_id} (${verdict})`,
          body: envelope ? appendEnvelopeToPrBody(body, envelope) : body,
          baseSha: sha,
        });
        console.log("[validate] validation PR opened", pr.number, pr.html_url);
        return pr;
      },
    );
  },
};

// Switch from reviewing to editing: a PR that removes the viewer's review
// lock and appends the fail comment saying what the edit is for. The
// automation records it as a fail and a send-back in one step and gives the
// viewer the task's encoding claim. Waits for the verdict, since the edit
// starts from it.
const reviewEdit: CommandDef<
  { task_id: string; subtask_id: string; comment: FailComment },
  Result
> = {
  id: "campaign.reviewEdit",
  version: 1,
  log: "pr",
  envelopeInput: ({ task_id, subtask_id }) => ({ task_id, subtask_id }),
  async run({ task_id, subtask_id, comment }, ctx, envelope) {
    const { forge: f, owner, repo, viewer, viewerLogin } = ctx;
    const target = `${task_id}/${subtask_id}`;
    if (!comment.body.trim())
      return {
        error:
          "Switching to editing needs a note saying why — nothing was submitted.",
      };
    try {
      ctx.progress({ step: "Switching to editing…" });
      await muteOnce(ctx);
      const {
        sha,
        files: [lockCsv, commentCsv],
      } = await readAtHead(ctx, [LOCK_PATH, COMMENT_PATH]);
      const locks = parseLockCsv(lockCsv ?? "");
      const mine = (l: LockRow) =>
        l.task_id === task_id &&
        l.subtask_id === subtask_id &&
        l.kind === "validation" &&
        l.user_id === viewer;
      const { removed } = reapLocks({ locks, now: new Date().toISOString() });
      if (removed.some(mine))
        return { error: `Your review claim on ${target} has run out.` };
      if (!locks.some(mine))
        return { error: `You hold no review claim on ${target}.` };
      const body = `Switches the review of ${target} by ${viewerLogin} to editing. Opened from the app.`;
      const pr = await f.openChangePr(owner, repo, {
        branch: `review-edit-${task_id}-${shortId()}`,
        files: [
          {
            path: LOCK_PATH,
            content: serializeLockCsv(locks.filter((l) => !mine(l))),
          },
          // The id, author and timestamp are the Action's to write.
          {
            path: COMMENT_PATH,
            content: appendComments(commentCsv ?? "", [
              {
                comment_id: "",
                task_id,
                subtask_id,
                kind: "fail",
                page: comment.page,
                measure_start: comment.measure_start,
                measure_end: comment.measure_end,
                author_id: "",
                timestamp: "",
                resolved: "",
                parent_id: "",
                body: comment.body.trim(),
                fragment: "",
              },
            ]),
          },
        ],
        message: `Edit ${task_id} from review`,
        title: `Edit ${task_id} from review`,
        body: envelope ? appendEnvelopeToPrBody(body, envelope) : body,
        baseSha: sha,
      });
      console.log("[review-edit] PR opened", pr.number, pr.html_url);
      let verdict: PrProcessingResult;
      try {
        verdict = await waitForPrProcessed(ctx, pr);
      } catch (e) {
        console.warn(
          "[review-edit] verdict poll failed:",
          (e as Error).message,
        );
        verdict = { state: "timeout" };
      }
      const res = verdictResult(
        verdict,
        pr.number,
        pr.html_url,
        `Review edit #${pr.number} opened for ${target}.`,
      );
      if (verdict.state === "timeout" || verdict.state === "run_failed")
        followInBackground(
          ctx,
          `Review edit of ${target}`,
          { kind: "review-edit", task: task_id, sub: subtask_id },
          verdict.state === "run_failed" ? { ...pr, headSha: undefined } : pr,
          task_id,
        );
      if (!res.ok || res.outcome === "pending") return res;
      // The edit starts from the reviewed submission, not from an earlier
      // branch of the viewer's.
      await deleteTaskBranch(ctx, task_id);
      return { ...res, message: `You now edit ${task_id}.` };
    } catch (e) {
      return { error: `Switching to editing failed: ${(e as Error).message}` };
    }
  },
};

export { reviewEdit, submitValidation };
