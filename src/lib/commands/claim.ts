// Claiming a task and giving it back: the claim limit, the claim pull request
// and its synchronous wait, and the claimValidation, abandon and claimTask
// commands.

import { shortId } from "../util.ts";
import {
  parseLockCsv,
  serializeLockCsv,
  configNumber,
  DEFAULT_MAX_CLAIMS,
  CONFIG_PATH,
  LOCK_PATH,
} from "../campaign-tables.ts";
import type { LockRow } from "../campaign-tables.ts";
import { claimLimitReached } from "../campaign-claim.ts";
import { claimRanOut, liveLocks, reapLocks } from "../campaign-reaper.ts";
import { appendEnvelopeToPrBody } from "../command-envelope.ts";
import type { CommandEnvelope } from "../command-envelope.ts";
import type { CommandContext, CommandDef, Result } from "./core.ts";
import { deleteTaskBranch } from "./task-branch.ts";
import {
  followInBackground,
  muteOnce,
  readAtHead,
  verdictResult,
  waitForPrProcessed,
} from "./change-request.ts";
import type { PrProcessingResult } from "./change-request.ts";

/**
 * Why the viewer may not claim another task, when they hold the most claims
 * the campaign allows one person at once (locking.max_claims_per_person, which
 * the campaign automation enforces); null otherwise. `locks` are the live ones.
 */
function claimLimitError(
  locks: LockRow[],
  viewer: string,
  configYaml: string | null,
): string | null {
  const max = configNumber(
    configYaml,
    "max_claims_per_person",
    DEFAULT_MAX_CLAIMS,
  );
  return claimLimitReached(locks, viewer, max)
    ? `You hold ${max} claims, as many as this campaign allows one person at once. Submit or give back one of them first.`
    : null;
}

// Whether the viewer holds the claim on the row and kind. A claim of theirs
// refused as `already_locked` was then granted to them from another tab or
// device.
async function holdsClaim(
  ctx: CommandContext,
  task_id: string,
  subtask_id: string,
  kind: string,
): Promise<boolean> {
  const { forge: f, owner, repo, viewer } = ctx;
  return liveLocks(
    parseLockCsv((await f.getRepoFile(owner, repo, LOCK_PATH)) ?? ""),
  ).some(
    (l) =>
      l.task_id === task_id &&
      l.subtask_id === subtask_id &&
      l.kind === kind &&
      l.user_id === viewer,
  );
}

// Whether a decided claim was refused as `already_locked` while the viewer
// holds that claim.
const claimedElsewhere = async (
  ctx: CommandContext,
  verdict: PrProcessingResult,
  task_id: string,
  subtask_id: string,
  kind: string,
): Promise<boolean> =>
  verdict.state === "decided" &&
  !verdict.accepted &&
  verdict.detail === "already_locked" &&
  (await holdsClaim(ctx, task_id, subtask_id, kind));

// Open a PR that adds a lock row (the Action re-authors who/when), carrying
// the invoking command's envelope in its body. Shared by the claim command
// and "open in mei-friend" (where opening == claiming).
async function openClaimPr(
  ctx: CommandContext,
  task_id: string,
  subtask_id: string,
  kind: string,
  envelope: CommandEnvelope | null,
) {
  const { forge: f, owner, repo, viewer, viewerLogin } = ctx;
  await muteOnce(ctx);
  const {
    sha,
    files: [lockCsv, configYaml],
  } = await readAtHead(ctx, [LOCK_PATH, CONFIG_PATH]);
  const lockRows = parseLockCsv(lockCsv ?? "");
  const limited = claimLimitError(liveLocks(lockRows), viewer, configYaml);
  if (limited) throw new Error(limited);
  lockRows.push({
    task_id,
    subtask_id,
    user_id: viewer,
    timestamp: new Date().toISOString(),
    kind,
    expires: "",
  });
  const target = subtask_id ? `${task_id}/${subtask_id}` : task_id;
  const work = kind === "validation" ? "review" : kind;
  const body = `Reserves ${target} for ${work} work by ${viewerLogin}. Opened from the app.`;
  console.log("[claim] opening claim PR", {
    task_id,
    subtask_id,
    kind,
    user: viewer,
  });
  return f.openChangePr(owner, repo, {
    branch: `claim-${task_id}${subtask_id ? "-" + subtask_id : ""}-${shortId()}`,
    files: [{ path: LOCK_PATH, content: serializeLockCsv(lockRows) }],
    message: `Claim ${target} (${work})`,
    title: `Claim ${target} (${work})`,
    body: envelope ? appendEnvelopeToPrBody(body, envelope) : body,
    baseSha: sha,
  });
}

// Open a claim PR and wait for its verdict synchronously — the claim gates the
// user's next step. A poll failure after the PR opened is indeterminate: it
// resolves as the "still being processed" warning, never as a rejection.
async function claimAndWait(
  ctx: CommandContext,
  task_id: string,
  subtask_id: string,
  kind: string,
  envelope: CommandEnvelope | null,
): Promise<Result> {
  try {
    ctx.progress({ step: "Opening the claim…" });
    const pr = await openClaimPr(ctx, task_id, subtask_id, kind, envelope);
    console.log("[claim] claim PR opened", pr.number, pr.html_url);
    let verdict: PrProcessingResult;
    try {
      verdict = await waitForPrProcessed(ctx, pr);
    } catch (e) {
      console.warn("[claim] verdict poll failed:", (e as Error).message);
      verdict = { state: "timeout" };
    }
    const target = subtask_id ? `${task_id}/${subtask_id}` : task_id;
    if (await claimedElsewhere(ctx, verdict, task_id, subtask_id, kind))
      return {
        ok: true,
        outcome: "noop",
        prUrl: pr.html_url,
        message: `You already hold the claim on ${target}.`,
      };
    if (verdict.state === "timeout" || verdict.state === "run_failed")
      followInBackground(
        ctx,
        `${kind === "validation" ? "Review" : "Encoding"} claim of ${target}`,
        { kind: "claim", task: task_id, sub: subtask_id },
        verdict.state === "run_failed" ? { ...pr, headSha: undefined } : pr,
        kind === "encoding" ? task_id : undefined,
      );
    return verdictResult(
      verdict,
      pr.number,
      pr.html_url,
      `Claim #${pr.number} opened for ${target} (${kind === "validation" ? "review" : kind}).`,
    );
  } catch (e) {
    return { error: `Claim failed: ${(e as Error).message}` };
  }
}

const claimValidation: CommandDef<
  { task_id: string; subtask_id: string },
  Result
> = {
  id: "campaign.claimValidation",
  version: 1,
  log: "pr",
  run: ({ task_id, subtask_id }, ctx, envelope) =>
    claimAndWait(ctx, task_id, subtask_id, "validation", envelope),
};

// Abandon a held claim: a PR that removes the viewer's lock row (an encoding
// claim on the task row, a review claim on a subtask row). The task's state is
// unchanged, so the task is open to claim again once the release is accepted.
// An accepted encoding release deletes the viewer's task branch, which holds
// their unsubmitted changes.
const abandon: CommandDef<{ task_id: string; subtask_id: string }, Result> = {
  id: "campaign.abandon",
  version: 1,
  log: "pr",
  async run({ task_id, subtask_id }, ctx, envelope) {
    const { forge: f, owner, repo, viewer, viewerLogin } = ctx;
    const kind = subtask_id ? "validation" : "encoding";
    const target = subtask_id ? `${task_id}/${subtask_id}` : task_id;
    try {
      ctx.progress({ step: "Giving the task back…" });
      await muteOnce(ctx);
      const {
        sha,
        files: [lockCsv],
      } = await readAtHead(ctx, [LOCK_PATH]);
      const locks = parseLockCsv(lockCsv ?? "");
      const { removed } = reapLocks({ locks, now: new Date().toISOString() });
      if (claimRanOut(removed, { task_id, subtask_id, kind }, viewer))
        return { error: `Your claim on ${target} has run out.` };
      const kept = locks.filter(
        (l) =>
          !(
            l.task_id === task_id &&
            l.subtask_id === subtask_id &&
            l.kind === kind &&
            l.user_id === viewer
          ),
      );
      if (kept.length === locks.length)
        return { error: `You hold no claim on ${target}.` };
      const work = kind === "validation" ? "review" : kind;
      const body = `Abandons ${target} (${work}) by ${viewerLogin}. Opened from the app.`;
      const pr = await f.openChangePr(owner, repo, {
        branch: `release-${task_id}${subtask_id ? "-" + subtask_id : ""}-${shortId()}`,
        files: [{ path: LOCK_PATH, content: serializeLockCsv(kept) }],
        message: `Abandon ${target} (${work})`,
        title: `Abandon ${target} (${work})`,
        body: envelope ? appendEnvelopeToPrBody(body, envelope) : body,
        baseSha: sha,
      });
      console.log("[abandon] release PR opened", pr.number, pr.html_url);
      let verdict: PrProcessingResult;
      try {
        verdict = await waitForPrProcessed(ctx, pr);
      } catch (e) {
        console.warn("[abandon] verdict poll failed:", (e as Error).message);
        verdict = { state: "timeout" };
      }
      const res = verdictResult(
        verdict,
        pr.number,
        pr.html_url,
        `Release #${pr.number} opened for ${target}.`,
      );
      if (verdict.state === "timeout" || verdict.state === "run_failed")
        followInBackground(
          ctx,
          `Release of ${target}`,
          { kind: "release", task: task_id, sub: subtask_id },
          verdict.state === "run_failed" ? { ...pr, headSha: undefined } : pr,
          kind === "encoding" ? task_id : undefined,
        );
      if (!res.ok || res.outcome === "pending") return res;
      if (kind === "encoding") await deleteTaskBranch(ctx, task_id);
      return { ...res, message: `You abandoned ${target}.` };
    } catch (e) {
      return { error: `Giving the task back failed: ${(e as Error).message}` };
    }
  },
};

// Claim a task for encoding-kind work without a mei-friend hand-off — the
// zone editor's claim path for the facsimile pre-tasks.
const claimTask: CommandDef<{ task_id: string }, Result> = {
  id: "campaign.claimTask",
  version: 1,
  log: "pr",
  async run({ task_id }, ctx, envelope) {
    const result = await claimAndWait(ctx, task_id, "", "encoding", envelope);
    // A new claim starts from the current score or the work kept from
    // expired claims, never from a branch of an earlier claim. The branch is
    // deleted only once the claim is accepted: until then, an expired claim's
    // work on it may still be being kept.
    if (result.ok && result.outcome !== "pending" && result.outcome !== "noop")
      await deleteTaskBranch(ctx, task_id);
    return result;
  },
};

export {
  abandon,
  claimLimitError,
  claimTask,
  claimValidation,
  claimedElsewhere,
  openClaimPr,
};
