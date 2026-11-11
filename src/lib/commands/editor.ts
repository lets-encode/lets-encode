// The mei-friend hand-off: the campaign.openEditor command, which claims the
// task when needed, prepares the task branch and returns the editor URL.

import { sleep } from "../util.ts";
import {
  parseTaskCsv,
  parseStateCsv,
  parseLockCsv,
  findRow,
  CONFIG_PATH,
  LOCK_PATH,
  STATE_PATH,
  TASK_PATH,
} from "../campaign-tables.ts";
import { usesOmr } from "../campaign-init.ts";
import { claimRefusal, encodingClaimOf } from "../campaign-claim.ts";
import { liveLocks } from "../campaign-reaper.ts";
import { pageOfLocator } from "../campaign-graph.ts";
import type { ScoreDefModel } from "../mei-facsimile.ts";
import {
  checksOpening,
  pieceFieldForPath,
  REASON_TEXT,
} from "../coordinator-policy.ts";
import { firstElementOfPage } from "../mei-page-splice.ts";
import type { CommandDef, Result } from "./core.ts";
import { seedFromKeptWork, workRepoOf } from "./task-branch.ts";
import {
  followInBackground,
  verdictResult,
  waitForPrProcessed,
} from "./change-request.ts";
import { claimLimitError, claimedElsewhere, openClaimPr } from "./claim.ts";

// Prepare the task's score for mei-friend and return the hand-off URL; opening
// for editing first claims the task (unless the user already holds the lock).
// The caller decides when to navigate — never on a rejected or still-pending
// claim. `campaign` and `base` tell mei-friend where to return the volunteer:
// <base>/<campaign>?task=<task_id>&mf_status=…. A task that checks its
// piece's opening score definition (checksOpening) is claimed in the app's
// check view, which passes the checked definition as `scoreDef`: the draft is
// made with it.
const openEditor: CommandDef<
  {
    task_id: string;
    campaign: string;
    base: string;
    scoreDef?: ScoreDefModel;
  },
  Result
> = {
  id: "campaign.openEditor",
  version: 1,
  log: "pr",
  envelopeInput: ({ task_id }) => ({ task_id }),
  async run({ task_id, campaign, base, scoreDef }, ctx, envelope) {
    const { forge: f, owner, repo, viewer, meiFriendUrl } = ctx;
    if (!meiFriendUrl)
      return {
        error:
          "Open in mei-friend failed: no mei-friend address is configured for this deployment.",
      };
    try {
      const [taskCsv, stateCsv, configYaml, lockCsv] = await Promise.all([
        f.getRepoFile(owner, repo, TASK_PATH),
        f.getRepoFile(owner, repo, STATE_PATH),
        f.getRepoFile(owner, repo, CONFIG_PATH),
        f.getRepoFile(owner, repo, LOCK_PATH),
      ]);
      const taskDefs = parseTaskCsv(taskCsv ?? "");
      const taskDef = findRow(taskDefs, task_id, "");
      const fragment = taskDef?.fragment;
      const state = parseStateCsv(stateCsv ?? "");
      const task = findRow(state.rows, task_id, "");
      if (!taskDef || !fragment || !task)
        return { error: `Unknown task ${task_id}.` };

      const locks = liveLocks(parseLockCsv(lockCsv ?? ""));
      const mine = encodingClaimOf(locks, task_id, viewer) !== undefined;
      const claiming = task.status === "encoding_required" && !mine;
      if (
        claiming &&
        checksOpening(
          taskDef,
          taskDefs,
          pieceFieldForPath(configYaml, fragment, "preparation"),
        )
      )
        return {
          error: `${task_id} starts with a check of the score definition: open the task and claim it there.`,
        };
      if (claiming) {
        // A claim the campaign automation would refuse stops here, before
        // the task branch, which may hold someone else's work, is touched.
        const refusal = claimRefusal({
          tasks: taskDefs,
          state,
          locks,
          intent: { task_id, subtask_id: "", kind: "encoding" },
          author: viewer,
        });
        if (refusal === "already_locked")
          return { error: `Someone else holds the claim on ${task_id}.` };
        if (refusal)
          return {
            error: `${task_id} cannot be claimed: ${REASON_TEXT[refusal] ?? refusal}.`,
          };
        const limited = claimLimitError(locks, viewer, configYaml);
        if (limited) return { error: limited };
      }

      const head = await f.getRepoHead(owner, repo);
      const { canPush } = head;
      let { sha } = head;
      console.log(
        "[editor] task",
        task_id,
        "fragment",
        fragment,
        "mainHead",
        sha,
        "canPush",
        canPush,
      );
      const ref = `encode-${task_id}`;
      let prUrl: string | undefined;
      let claimMessage = "";
      // A newly accepted claim starts its task branch afresh.
      let startsFresh = false;
      if (claiming) {
        ctx.progress({ step: "Opening the encoding claim…" });
        const pr = await openClaimPr(ctx, task_id, "", "encoding", envelope);
        console.log(
          "[editor] encoding claim PR opened",
          pr.number,
          pr.html_url,
        );
        prUrl = pr.html_url;
        const verdict = await waitForPrProcessed(ctx, pr);
        if (verdict.state === "run_failed")
          followInBackground(
            ctx,
            `Encoding claim of ${task_id}`,
            { kind: "claim", task: task_id },
            { ...pr, headSha: undefined },
            task_id,
          );
        if (verdict.state === "timeout") {
          followInBackground(
            ctx,
            `Encoding claim of ${task_id}`,
            { kind: "claim", task: task_id },
            pr,
            task_id,
          );
          return {
            ok: true,
            outcome: "pending",
            prUrl,
            message: `Encoding claim #${pr.number} is still being processed. Open it in mei-friend once it is accepted.`,
          };
        }
        const res = verdictResult(
          verdict,
          pr.number,
          pr.html_url,
          `Encoding claim #${pr.number} opened.`,
        );
        if (!res.error) {
          startsFresh = true;
          claimMessage = `${res.message} `;
        } else if (
          // Claimed from another tab or device: its branch is kept.
          !(await claimedElsewhere(ctx, verdict, task_id, "", "encoding"))
        ) {
          return {
            error: `The encoding claim was rejected — ${res.error}`,
            prUrl,
          };
        }
        // Pages accepted while the claim was processed are on the branch
        // the editor opens.
        ({ sha } = await f.getRepoHead(owner, repo));
      }

      // The task branch `encode-<task_id>` lives where the claim's pull
      // request came from (workRepoOf): the campaign repo for owners and
      // collaborators, the volunteer's fork otherwise. The submission PR
      // later names the same branch.
      const workRepo = await workRepoOf(ctx, task_id);
      // A new claim starts from the current score or the work kept from
      // expired claims. The branch is deleted only once the claim is
      // accepted: until then, an expired claim's work on it may still be
      // being kept.
      if (startsFresh) await f.deleteBranch(workRepo.owner, workRepo.repo, ref);

      ctx.progress({ step: "Preparing the score for mei-friend…" });
      // Whether the branch now sits at the head with nothing of its own on it.
      let fresh = true;
      try {
        await f.createBranch(workRepo.owner, workRepo.repo, ref, sha);
        console.log(
          "[editor] created branch",
          ref,
          "in",
          `${workRepo.owner}/${workRepo.repo}`,
          "at",
          sha,
        );
      } catch (e) {
        if (!/already exists/i.test((e as Error).message)) throw e;
        // The branch exists from an earlier open by the current holder. If it
        // is merely stale, fast-forward it to the current head; a branch with
        // its own commits — work in progress — is left untouched.
        fresh = await f.fastForwardBranch(
          workRepo.owner,
          workRepo.repo,
          ref,
          sha,
        );
        console.log(
          "[editor] branch",
          ref,
          "already existed; fast-forward to",
          sha,
          "=>",
          fresh,
        );
      }
      // A fresh branch continues from the work kept from expired claims of
      // the task, when there is any.
      if (fresh && (await seedFromKeptWork(ctx, taskDef, workRepo, ref))) {
        fresh = false;
        ctx.progress({
          step: "Continuing from the unsubmitted work of an earlier claim.",
        });
      }

      // A page task of an OMR-prepared piece starts from a draft of its page
      // made from the piece's recognition record, committed to the fresh
      // branch before mei-friend opens. A branch with work in progress keeps it.
      let draft: { note: string; warnings: string[] } | null = null;
      const pageNo = pageOfLocator(taskDef.locator);
      if (
        fresh &&
        pageNo &&
        usesOmr(pieceFieldForPath(configYaml, fragment, "preparation"))
      ) {
        ctx.progress({ step: "Preparing the transcription draft…" });
        try {
          const { draftPage } = await import("../omr-page-draft.ts");
          draft = await draftPage({
            forge: f,
            owner,
            repo,
            headSha: sha,
            workRepo,
            branch: ref,
            fragment,
            page: pageNo,
            scoreDef,
            models: ctx.omr,
            progress: (detail) => ctx.progress({ detail }),
          });
        } catch (e) {
          return {
            error: `Could not prepare the transcription draft: ${(e as Error).message}`,
            prUrl,
          };
        }
        // The note is a step of the overlay. With warnings, the overlay
        // stays up until Continue before the hand-off (holdHandOff).
        ctx.progress({ step: draft.note });
      }

      // The branch ref was created or moved a moment ago, and GitHub's
      // Contents API can briefly lag ref updates — retry the lookup rather
      // than failing on that race.
      let downloadUrl: string | null = null;
      for (let attempt = 1; attempt <= 5 && !downloadUrl; attempt++) {
        if (attempt > 1) await sleep(1500);
        downloadUrl = await f.getRepoFileDownloadUrl(
          workRepo.owner,
          workRepo.repo,
          fragment,
          ref,
        );
        console.log("[editor] download URL attempt", {
          attempt,
          fragment,
          ref,
          available: Boolean(downloadUrl),
        });
      }
      if (!downloadUrl) {
        return {
          error: `Could not get a download URL for ${fragment}.`,
          prUrl,
        };
      }
      const params = new URLSearchParams({
        file: downloadUrl,
        le_campaignname: campaign,
        le_taskid: task_id,
        le_base: base,
      });
      // mei-friend opens at page 1; `select` makes it page to the given
      // element. A page task selects the first note (else measure) of its page
      // in the file mei-friend opens. Without either, mei-friend opens at page 1.
      // In speed mode mei-friend does not page to the selected element on
      // load, so `speed=false` accompanies it.
      if (pageNo) {
        try {
          const mei = await f.getRepoFile(
            workRepo.owner,
            workRepo.repo,
            fragment,
            ref,
          );
          const elementId = mei && firstElementOfPage(mei, taskDef.locator);
          if (elementId) {
            params.set("select", elementId);
            params.set("speed", "false");
          } else console.log("[editor] nothing to select on", taskDef.locator);
        } catch (e) {
          console.log("[editor] could not read the page's first element", e);
        }
      }
      const url = `${meiFriendUrl}/?${params}`;
      return {
        ok: true,
        meiFriendUrl: url,
        prUrl,
        message: `${claimMessage}${draft ? `${draft.note} ` : ""}Opening the score in mei-friend.`,
        ...(draft?.warnings.length ? { holdHandOff: true } : {}),
      };
    } catch (e) {
      return { error: `Open in mei-friend failed: ${(e as Error).message}` };
    }
  },
};

export { openEditor };
