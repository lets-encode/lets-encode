// Campaign coordinator — the single entry point the generic caller runs.
// It branches on the triggering event (EVENT_NAME) and, for pull requests, on
// the PR's changed paths, then hands the decision to the pure modules and
// applies the result with optimistic concurrency. Every outcome — accepted,
// rejected, reaped — is appended to the campaign's history table, except the
// rejection of a pull request that does not parse as any operation
// (AUDIT_FREE_REJECTS). Scheduled runs process any open pull request whose
// own run was lost or that its run left open over the per-author cap
// (runCatchUp), and then reap stale locks.
// See DESIGN.md §4 (the caller) & §6 (PR contract).
//
// Runs in the BASE (campaign) repo's context with a write token. The pull
// request is treated purely as DATA: we read its changed-file patches and
// blobs via the API and never check out or execute anything the fork supplies.
//
// Env: GH_TOKEN, BASE_REPO ("owner/repo"), EVENT_NAME;
//      for pull_request_target additionally PR_NUMBER, PR_AUTHOR (numeric
//      account id — the canonical identity written to the tables), PR_AUTHOR_LOGIN
//      (login, for commit messages only), HEAD_REPO ("owner/repo" of the PR head),
//      HEAD_SHA, HEAD_REF.

import {
  parseTaskCsv,
  parseStateCsv,
  parseLockCsv,
  parseHistoryCsv,
  COMMENT_PATH,
  CONFIG_PATH,
  HISTORY_PATH,
  LOCK_PATH,
  STATE_PATH,
  TASK_PATH,
} from "../src/lib/campaign-tables.ts";
import type {
  ParsedState,
  TaskRow,
  LockRow,
  HistoryRow,
} from "../src/lib/campaign-tables.ts";
import { envelopeFromPrBody } from "../src/lib/command-envelope.ts";
import type { CommandEnvelope } from "../src/lib/command-envelope.ts";
import { checkRelease } from "../src/lib/campaign-claim.ts";
import { sideFilesOf } from "../src/lib/campaign-submit.ts";
import type { ReapLocksResult } from "../src/lib/campaign-reaper.ts";
import { pageOfLocator } from "../src/lib/campaign-graph.ts";
import {
  addedRowFromPatch,
  claimPullRequest,
  classifyPullRequest,
  isAutomaticCommit,
  contractMarker,
  isLeftoverOperationBranch,
  isOperationBranch,
  keptWorkBranch,
  keptWorkSince,
  lockIntentFromRow,
  MAX_OPEN_PRS_PER_AUTHOR,
  priorDecision,
  removedRowFromPatch,
  shouldCleanupSubmission,
  isCampaignOperation,
} from "../src/lib/coordinator-policy.ts";
import {
  claimComment,
  claimCommit,
  claimedLockOf,
  commentComment,
  commentCommit,
  commentIntent,
  decideClaim,
  decideComment,
  decideReviewEdit,
  isAuditFree,
  locksForDecision,
  openCountByAuthor,
  priorVerdict as priorVerdictOf,
  releaseComment,
  releaseCommit,
  reviewEditComment,
  reviewEditCommit,
  reviewEditIntent,
  tablesBusyComment,
} from "../src/lib/coordinator-operations.ts";
import type {
  BoundPullRequest,
  Verdict,
} from "../src/lib/coordinator-operations.ts";
import {
  acceptedEncoding,
  assembleEncoding,
  decideValidation as validationDecision,
  encodingContributions,
  encodingInputGap,
  encodingPrecheck,
  encodingVerdict,
  submitComment,
  submitCommit,
  submittedSideFiles,
  validationIntent,
} from "../src/lib/coordinator-submission.ts";
import type { SubmitDecision } from "../src/lib/coordinator-submission.ts";
import {
  CATCHUP_MAX_PRS,
  catchUpDue,
  reachedReviews,
  reapAt as reapLocksAt,
  reapCommit,
  undecidedPullRequests,
  UNDECIDED_COMMENT,
} from "../src/lib/coordinator-maintenance.ts";
import {
  compareCommitMessages,
  getPullRequestCommitMessages,
  getPullRequestDetails,
  getRepoFile,
  getRepoHead,
  getPullRequest,
  getUserLogin,
  listOpenPullRequests,
  listBranchCommitTimes,
  getCollaboratorCanPush,
  commitFiles,
  commentAndClosePr,
  deleteBranch,
  getGitHubRequestTelemetry,
  isTransientError,
  listWorkflowRuns,
} from "../src/lib/forge/github-rest.ts";
import type {
  OpenPullRequest,
  PullRequestFile,
} from "../src/lib/forge/github-rest.ts";
import { validateMei } from "./mei-validate.ts";
import type { MeiCheck } from "../src/lib/mei-schema.ts";
import { shortId } from "../src/lib/util.ts";

const token = process.env.GH_TOKEN ?? "";
const [owner, repo] = (process.env.BASE_REPO ?? "").split("/");
const eventName = process.env.EVENT_NAME ?? "";

// The pull request being processed. A pull_request_target run binds it once
// from the event's environment; the scheduled catch-up pass binds each open
// pull request it picks up in turn, so the decision functions below always
// see exactly one pull request.
interface PullRequestContext {
  number: number;
  /** The author's numeric account id. */
  author: string;
  authorLogin: string;
  headOwner: string;
  headRepo: string;
  headSha: string;
  headRef: string;
}
let prNumber = 0;
// The PR author's stable numeric account id — the identity written to the
// tracking tables (lock.user_id, state.encoder, validate_status, history).
let author = "";
// The PR author's login — for human-readable commit messages / co-author
// trailers only, never as a stored identity. Falls back to the id if absent.
let authorLogin = "";
let authorLabel = "";
let headOwner = "";
let headRepo = "";
let headSha = "";
let headRef = "";
// When the pull request was opened (GitHub's server time). Discussion comment
// rows carry it as their timestamp, so a discussion keeps the order the
// comments were submitted in even when their runs finish in another order;
// lock, state, history rows and a fail's comment carry the processing time.
let submittedAt = "";
// Comment on pull request `number` (the bound one by default) and close it.
// Every verdict comment ends with the automation's contract number, which the
// app compares with its own.
function commentAndClose(body: string, number = prNumber): Promise<void> {
  return commentAndClosePr(
    token,
    owner,
    repo,
    number,
    `${body}\n\n${contractMarker()}`,
  );
}

function bindPullRequest(pr: PullRequestContext): void {
  prNumber = pr.number;
  author = pr.author;
  authorLogin = pr.authorLogin;
  authorLabel = authorLogin || author;
  headOwner = pr.headOwner;
  headRepo = pr.headRepo;
  headSha = pr.headSha;
  headRef = pr.headRef;
}

// The bound pull request as the decision functions take it.
const boundPr = (): BoundPullRequest => ({
  number: prNumber,
  author,
  authorLogin,
});

const MAX_ATTEMPTS = 10;

// ---------------------------------------------------------------------------
// Shared helpers

// The decision history.csv already records for the bound pull request, or
// null (priorVerdict in coordinator-operations.ts).
function priorVerdict(
  historyCsv: string | null,
): (Verdict & { row: HistoryRow }) | null {
  const prior = priorVerdictOf(historyCsv, prNumber);
  if (prior)
    console.log(`PR #${prNumber} was already decided (${prior.row.outcome}).`);
  return prior;
}

// The campaign's open pull requests as this run last listed them.
let openPullRequests: OpenPullRequest[] = [];

// Split `locks` into those in force at `now` and those dropped as expired
// (reapAt in coordinator-maintenance.ts), for the bound pull request.
const reapAt = (locks: LockRow[], now: string): ReapLocksResult =>
  reapLocksAt(locks, now, openPullRequests, prNumber);

// The locks the bound pull request is decided against (locksForDecision).
const locksAtSubmission = (
  lockCsv: string | null,
  historyCsv: string | null,
): ReturnType<typeof locksForDecision> =>
  locksForDecision({
    lockCsv,
    historyCsv,
    submittedAt,
    pr: boundPr(),
    open: openPullRequests,
  });

// Keep the unsubmitted work of expired encoding claims: the claimer's task
// branch `encode-<task>` — in the repo their claim's pull request came from —
// is copied to the campaign branch `wip-<task>` when it holds commits of
// their own. The copy starts from `main` at `sha` and carries the task's
// score and side files; a later expiry moves `wip-<task>` to the new copy once
// it exists. Returns the locks whose work was kept. A claim whose pull request,
// repo or branch no longer exists has none. A failure a retry may get past
// (retryable) throws, so the attempt is retried; any other failure, or any
// failure on the decision's last attempt, is logged and its claim is released
// without kept work.
async function keepExpiredWork(
  removed: LockRow[],
  historyCsv: string | null,
  mainBranch: string,
  sha: string,
): Promise<Set<LockRow>> {
  const kept = new Set<LockRow>();
  const encoding = removed.filter((l) => l.kind === "encoding");
  if (encoding.length === 0) return kept;
  const history = parseHistoryCsv(historyCsv ?? "");
  const tasks = parseTaskCsv(
    (await getRepoFile(token, owner, repo, TASK_PATH, sha)) ?? "",
  );
  for (const lock of encoding) {
    try {
      const task = tasks.find(
        (t) => t.task_id === lock.task_id && t.subtask_id === "",
      );
      const claimPr = claimPullRequest(history, lock.task_id, lock.user_id);
      if (!task || claimPr === null) continue;
      const { headRepo: workRepo } = await getPullRequestDetails(
        token,
        owner,
        repo,
        claimPr,
      );
      if (!workRepo) continue;
      const [workOwner, workName] = workRepo.split("/");
      const ref = `encode-${lock.task_id}`;
      const messages = await compareCommitMessages(
        token,
        owner,
        repo,
        mainBranch,
        workOwner === owner && workName === repo ? ref : `${workOwner}:${ref}`,
      );
      if (!messages?.some((m) => !isAutomaticCommit(m))) continue;
      const paths = [task.fragment, ...sideFilesOf(task)];
      const contents = await Promise.all(
        paths.map((path) => getRepoFile(token, workOwner, workName, path, ref)),
      );
      const files = paths.flatMap((path, i) =>
        contents[i] == null ? [] : [{ path, content: contents[i]! }],
      );
      if (files.length === 0) continue;
      await commitFiles(
        token,
        owner,
        repo,
        files,
        `Keep the unsubmitted work on ${lock.task_id} from an expired claim`,
        {
          baseSha: sha,
          newBranch: keptWorkBranch(lock.task_id),
          replaceBranch: true,
        },
      );
      kept.add(lock);
    } catch (e) {
      const message = (e as Error).message;
      if (!lastAttempt && retryable(e)) throw e;
      console.warn(
        `The unsubmitted work on ${lock.task_id} was not kept; its expired claim is released without it: ${message}`,
      );
    }
  }
  return kept;
}

// Schema checks by content: a retried decision that assembles the same score
// again reuses the check, so a retry is not slowed by it.
const meiChecks = new Map<string, Promise<MeiCheck>>();
function checkMeiOnce(mei: string): Promise<MeiCheck> {
  let check = meiChecks.get(mei);
  if (!check) {
    check = validateMei(mei);
    meiChecks.set(mei, check);
    check.catch(() => meiChecks.delete(mei));
  }
  return check;
}

// A non-forced branch update GitHub refused because the branch moved on. A
// write's error message ends in "(<status> <method> <path>)" (github-rest.ts).
const LOST_RACE = /\(422 PATCH \S*\/git\/refs\/heads\//;

// Whether another attempt may get past `e`: a commit lost to another run's,
// or a failure of GitHub's that may pass (isTransientError).
const retryable = (e: unknown): boolean =>
  isTransientError(e) || LOST_RACE.test((e as Error).message);

// Every attempt of a decision lost the commit to other runs' commits. The
// pull request is closed with that reason rather than left open, so the
// outcome its author is shown is the one that holds.
class TablesBusy extends Error {}

// The pull request's head moved while its encoding was being decided. The
// run for that push, queued behind this one, decides it instead.
class HeadMoved extends Error {}

// Whether withRetry is running the last attempt of a decision.
let lastAttempt = false;

// Run one optimistic decide-and-apply pass, retrying (up to MAX_ATTEMPTS) when
// it throws an error another attempt may get past (retryable) — most often
// the non-fast-forward commit failing because the branch head moved. Each
// attempt re-reads the tables before writing, so retrying a failed read is
// equally safe. Any other error is thrown at once.
// Runs for different pull requests execute concurrently — several at once when
// operations are submitted in quick succession — so a random pause that grows
// with each retry (up to 8 s) spreads competing writers apart until each has
// committed.
async function withRetry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    lastAttempt = i === MAX_ATTEMPTS - 1;
    try {
      return await attempt();
    } catch (e) {
      if (!retryable(e)) throw e;
      const message = (e as Error).message;
      if (i === MAX_ATTEMPTS - 1)
        throw LOST_RACE.test(message) ? new TablesBusy(message) : e;
      console.warn(`Attempt ${i + 1} failed, retrying: ${message}`);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * Math.min(8_000, 500 * 2 ** i)),
      );
    }
  }
}

// Log the wall-clock seconds since `startedAt` as a `[phase-timing]` line —
// the form the run profiler (scripts/profile-actions.ts) extracts.
const logPhase = (phase: string, startedAt: number): void =>
  console.info(
    `[phase-timing] ${phase} ${((Date.now() - startedAt) / 1000).toFixed(2)}s`,
  );

// Whether the PR author can push to the campaign repo — the privilege behind
// owner-only operations (resolving someone else's comment). A failed lookup
// throws.
async function authorCanPush(): Promise<boolean> {
  if (!authorLogin) return false;
  return getCollaboratorCanPush(token, owner, repo, authorLogin);
}

// Delete the PR's head branch once we've closed it — but only when it lives in
// this repo (owner/collaborator PR). A volunteer's branch lives in their fork,
// which this token can't touch; it stays harmlessly in the fork.
async function cleanupHeadBranch(): Promise<void> {
  if (headOwner !== owner || headRepo !== repo || !headRef) return;
  try {
    await deleteBranch(token, owner, repo, headRef);
  } catch (e) {
    console.warn(`Branch cleanup skipped: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Claim (a PR adding one row to lock.csv)

async function attemptClaim(
  changedPaths: string[],
  intent: { task_id: string; subtask_id: string; kind: string } | null,
  envelope: CommandEnvelope | null,
): Promise<Verdict & { lock?: LockRow }> {
  const readStart = Date.now();
  const { branch, sha, treeSha } = await getRepoHead(token, owner, repo);
  const [taskCsv, stateCsv, lockCsv, historyCsv, configText] =
    await Promise.all([
      getRepoFile(token, owner, repo, TASK_PATH, sha),
      getRepoFile(token, owner, repo, STATE_PATH, sha),
      getRepoFile(token, owner, repo, LOCK_PATH, sha),
      getRepoFile(token, owner, repo, HISTORY_PATH, sha),
      getRepoFile(token, owner, repo, CONFIG_PATH, sha),
    ]);
  logPhase("read_tables", readStart);
  const prior = priorVerdict(historyCsv);
  if (prior)
    return {
      ...prior,
      lock: prior.ok ? claimedLockOf(prior.row) : undefined,
    };
  const now = new Date().toISOString();
  const { kept: locks, removed } = reapAt(parseLockCsv(lockCsv ?? ""), now);
  const verdict = decideClaim({
    taskCsv,
    stateCsv,
    configText,
    locks,
    intent,
    author,
    changedPaths,
    now,
  });
  const commit = claimCommit({
    pr: boundPr(),
    intent,
    verdict,
    locks,
    removed,
    keptWork: await keepExpiredWork(removed, historyCsv, branch, sha),
    historyCsv,
    now,
    envelope,
  });
  if (!commit) return verdict;
  const { files, message } = commit;
  // Non-fast-forward update fails if `main` moved since `sha` → we retry.
  const commitStart = Date.now();
  await commitFiles(token, owner, repo, files, message, {
    baseSha: sha,
    baseTreeSha: treeSha,
    branch,
  });
  logPhase("commit", commitStart);
  return verdict;
}

async function runClaim(
  files: PullRequestFile[],
  envelope: CommandEnvelope | null,
): Promise<void> {
  const changedPaths = files.map((f) => f.filename);
  const lockFile = files.find((f) => f.filename === LOCK_PATH);
  const removedRow = lockFile && removedRowFromPatch(lockFile.patch);
  if (removedRow) {
    await runRelease(changedPaths, removedRow, envelope);
    return;
  }
  const addedRow = lockFile && addedRowFromPatch(lockFile.patch);
  const intent = addedRow ? lockIntentFromRow(addedRow) : null;

  const verdict = await withRetry(() =>
    attemptClaim(changedPaths, intent, envelope),
  );

  const body = claimComment(verdict, authorLabel);
  const closeStart = Date.now();
  // The branch is deleted only after the close: deleting the head branch of an
  // open pull request closes it as well, and a close request racing that
  // deletion fails with a validation error.
  await commentAndClose(body);
  await cleanupHeadBranch();
  logPhase("comment_and_close", closeStart);
}

// ---------------------------------------------------------------------------
// Release (a PR removing one row from lock.csv: the author abandons a claim)

async function attemptRelease(
  changedPaths: string[],
  intent: { task_id: string; subtask_id: string; kind: string },
  envelope: CommandEnvelope | null,
): Promise<Verdict & { lock?: LockRow }> {
  const readStart = Date.now();
  const { branch, sha, treeSha } = await getRepoHead(token, owner, repo);
  const [lockCsv, historyCsv] = await Promise.all([
    getRepoFile(token, owner, repo, LOCK_PATH, sha),
    getRepoFile(token, owner, repo, HISTORY_PATH, sha),
  ]);
  logPhase("read_tables", readStart);
  const prior = priorVerdict(historyCsv);
  if (prior) return prior;
  const now = new Date().toISOString();
  // A claim is judged at the time its pull request was opened.
  const { locks, removed, opening, expired } = locksAtSubmission(
    lockCsv,
    historyCsv,
  );
  const verdict = checkRelease({
    locks: opening.decide,
    intent,
    author,
    changedPaths,
    expired,
  });
  if (isAuditFree(verdict)) return verdict;
  const { files, message } = releaseCommit({
    pr: boundPr(),
    intent,
    verdict,
    locks,
    removed,
    keptWork: await keepExpiredWork(removed, historyCsv, branch, sha),
    historyCsv,
    now,
    envelope,
  });
  const commitStart = Date.now();
  await commitFiles(token, owner, repo, files, message, {
    baseSha: sha,
    baseTreeSha: treeSha,
    branch,
  });
  logPhase("commit", commitStart);
  return verdict;
}

async function runRelease(
  changedPaths: string[],
  removedRow: string,
  envelope: CommandEnvelope | null,
): Promise<void> {
  const intent = lockIntentFromRow(removedRow);
  const verdict = await withRetry(() =>
    attemptRelease(changedPaths, intent, envelope),
  );
  const body = releaseComment(verdict, intent, authorLabel);
  const closeStart = Date.now();
  await commentAndClose(body);
  await cleanupHeadBranch();
  logPhase("comment_and_close", closeStart);
}

// ---------------------------------------------------------------------------
// Review edit (a PR removing the author's review lock from lock.csv and
// appending one fail comment: the reviewer switches to editing the task)

async function attemptReviewEdit(
  prFiles: PullRequestFile[],
  envelope: CommandEnvelope | null,
): Promise<Verdict & { task?: string }> {
  const changedPaths = prFiles.map((f) => f.filename);
  const readStart = Date.now();
  const { branch, sha, treeSha } = await getRepoHead(token, owner, repo);
  const [stateCsv, lockCsv, commentCsv, historyCsv, configText] =
    await Promise.all([
      getRepoFile(token, owner, repo, STATE_PATH, sha),
      getRepoFile(token, owner, repo, LOCK_PATH, sha),
      getRepoFile(token, owner, repo, COMMENT_PATH, sha),
      getRepoFile(token, owner, repo, HISTORY_PATH, sha),
      getRepoFile(token, owner, repo, CONFIG_PATH, sha),
    ]);
  logPhase("read_tables", readStart);
  const prior = priorVerdict(historyCsv);
  if (prior) return { ...prior, task: prior.row.task_id };

  // The intent is the review lock the PR removes and the fail comment it
  // appends, read from its own patches and re-applied to the fresh tables.
  const parsed = reviewEditIntent(prFiles);
  if (!parsed) return { ok: false, reason: "malformed_review_edit" };
  const { intent, added } = parsed;

  const now = new Date().toISOString();
  // A claim is judged at the time its pull request was opened.
  const { locks, removed, opening, expired } = locksAtSubmission(
    lockCsv,
    historyCsv,
  );
  const verdict = decideReviewEdit({
    stateCsv,
    configText,
    locks: opening.decide,
    intent,
    added,
    author,
    changedPaths,
    now,
    expired,
  });
  if (isAuditFree(verdict)) return verdict;

  const { files, message } = reviewEditCommit({
    pr: boundPr(),
    intent,
    added,
    verdict,
    locks,
    removed,
    openingExpired: opening.expired,
    keptWork: await keepExpiredWork(removed, historyCsv, branch, sha),
    historyCsv,
    commentCsv,
    now,
    envelope,
    newId: shortId(),
  });
  const commitStart = Date.now();
  await commitFiles(token, owner, repo, files, message, {
    baseSha: sha,
    baseTreeSha: treeSha,
    branch,
  });
  logPhase("commit", commitStart);
  return { ...verdict, task: intent.task_id };
}

async function runReviewEdit(
  files: PullRequestFile[],
  envelope: CommandEnvelope | null,
): Promise<void> {
  const verdict = await withRetry(() => attemptReviewEdit(files, envelope));
  const body = reviewEditComment(verdict, authorLabel);
  const closeStart = Date.now();
  await commentAndClose(body);
  await cleanupHeadBranch();
  logPhase("comment_and_close", closeStart);
}

// ---------------------------------------------------------------------------
// Submission (encoding: the PR edits the task's fragment; validation: the PR
// records a pass/fail in state.csv)

async function decideEncoding(
  sha: string,
  tasks: TaskRow[],
  state: ParsedState,
  locks: LockRow[],
  changedPaths: string[],
  envelope: CommandEnvelope | null,
  now: string,
  expired: LockRow[],
  pastHistory: HistoryRow[],
  held: LockRow[],
): Promise<SubmitDecision> {
  // A page task (locator `surface-N`) contributes only its page: we splice the
  // fork's page into the base score, leaving other pages as they stand: the
  // page's span is taken from the fork wholesale. The first page task of an
  // 'omr-instruments' piece also brings the opening score definition's
  // clefs, keys, meter and transpositions. Whole-file tasks
  // (empty locator) and pre-tasks take the fork's file with the campaign's
  // header (assembleSubmission).
  //
  // Failing to assemble the MEI at all and assembling one the schema rejects
  // are both `mei_invalid` submissions; which of the two it was survives only
  // in `detail`, since the reason code is what the tables record. A page
  // whose file passes the schema on its own while the assembled score fails
  // is `splice_invalid`: the join is at fault, not the encoding. So is every
  // submission the campaign's side fails (baseFailed): its score is missing,
  // a page task's config.yaml is missing, or the splice fails on the
  // campaign's score (BaseScoreError).
  // Everything but the MEI check is decided before the fork's file is read:
  // a submitter who holds no claim cannot make the run parse their file.
  const precheck = encodingPrecheck({
    tasks,
    state,
    locks,
    envelope,
    headRef,
    author,
    changedPaths,
    now,
    expired,
  });
  if ("rejected" in precheck) return precheck.rejected;
  const { task } = precheck;

  const isPageTask = pageOfLocator(task.locator) !== null;
  const readStart = Date.now();
  const [forkMei, baseMei, configText, commitMessages] = await Promise.all([
    getRepoFile(token, headOwner, headRepo, task.fragment, headSha),
    getRepoFile(token, owner, repo, task.fragment, sha),
    isPageTask ? getRepoFile(token, owner, repo, CONFIG_PATH, sha) : null,
    getPullRequestCommitMessages(token, owner, repo, prNumber),
  ]);
  logPhase("read_pr_files", readStart);
  const checkStart = Date.now();
  const gap = encodingInputGap({
    task,
    forkMei,
    baseMei,
    configText,
    isPageTask,
  });
  let mei: string | null = null;
  let { detail, baseFailed } = gap ?? { detail: "", baseFailed: false };
  if (!gap) {
    // The contribution is recorded in the assembled score's header — the
    // revision, the contributor, and the editing application — before the
    // machine check, so the updated header is validated with the rest of the
    // file (encodingContributions). Contributors are named by login with
    // their account id; a failed login lookup fails the run, which is
    // retried, rather than naming someone by number. A deleted account is
    // named "ghost", as GitHub shows it.
    const kept: { row: HistoryRow; login: string | null }[] = [];
    for (const row of keptWorkSince(pastHistory, task.task_id))
      kept.push({ row, login: await getUserLogin(token, Number(row.user_id)) });
    const assembled = assembleEncoding({
      task,
      tasks,
      configYaml: configText,
      baseMei,
      forkMei: forkMei!,
      contributions: encodingContributions({
        task,
        kept,
        commitMessages,
        pr: boundPr(),
        pastHistory,
        now,
      }),
    });
    if (assembled.mei == null)
      console.warn(
        `Page splice failed for ${task.task_id} (${task.locator}): ${assembled.spliceError}`,
      );
    ({ mei, detail, baseFailed } = assembled);
  }

  let meiValid = false;
  let joinFailed = baseFailed;
  if (mei != null) {
    const check = await checkMeiOnce(mei);
    meiValid = check.ok;
    if (!check.ok) {
      detail = `${task.fragment}:${check.error}`;
      joinFailed = isPageTask && (await checkMeiOnce(forkMei!)).ok;
    }
  }
  logPhase("mei_check", checkStart);

  const judged = encodingVerdict({
    tasks,
    state,
    locks,
    task,
    author,
    changedPaths,
    meiValid,
    joinFailed,
    detail,
    now,
    expired,
  });
  if ("rejected" in judged) return judged.rejected;

  const sidePaths = submittedSideFiles(task, changedPaths);
  const sideContents = await Promise.all(
    sidePaths.map((path) =>
      getRepoFile(token, headOwner, headRepo, path, headSha),
    ),
  );
  return acceptedEncoding({
    pr: boundPr(),
    task,
    tasks,
    mei: mei!,
    sideFiles: sidePaths.map((path, i) => ({ path, content: sideContents[i] })),
    accepted: judged,
    held,
    pastHistory,
  });
}

async function decideValidation(
  sha: string,
  state: ParsedState,
  locks: LockRow[],
  prFiles: PullRequestFile[],
  changedPaths: string[],
  now: string,
  expired: LockRow[],
  held: LockRow[],
): Promise<SubmitDecision> {
  // The intent is read from the PR's own patch (validationIntent); the
  // decision re-applies it to the freshly read tables (validationDecision).
  const intent = validationIntent({
    prFiles,
    changedPaths,
    state,
    author,
    now,
  });
  if ("rejected" in intent) return intent.rejected;

  // The config always (pass_threshold), the comment table when the decision
  // reads it.
  const readStart = Date.now();
  const [configText, baseCommentCsv] = await Promise.all([
    getRepoFile(token, owner, repo, CONFIG_PATH, sha),
    intent.wantsComments
      ? getRepoFile(token, owner, repo, COMMENT_PATH, sha)
      : null,
  ]);
  logPhase("read_pr_files", readStart);

  return validationDecision({
    pr: boundPr(),
    intent,
    state,
    locks,
    configText,
    baseCommentCsv,
    changedPaths,
    now,
    expired,
    held,
    newId: shortId(),
  });
}

// One decide-and-apply pass, pinned to the branch head we read. Throws only if
// the commit races (caller retries); returns the verdict otherwise.
async function attemptSubmit(
  kind: "encoding" | "validation",
  prFiles: PullRequestFile[],
  envelope: CommandEnvelope | null,
): Promise<Verdict> {
  const changedPaths = prFiles.map((f) => f.filename);
  const readStart = Date.now();
  const { branch, sha, treeSha } = await getRepoHead(token, owner, repo);
  const [taskCsv, stateCsv, lockCsv, historyCsv] = await Promise.all([
    getRepoFile(token, owner, repo, TASK_PATH, sha),
    getRepoFile(token, owner, repo, STATE_PATH, sha),
    getRepoFile(token, owner, repo, LOCK_PATH, sha),
    getRepoFile(token, owner, repo, HISTORY_PATH, sha),
  ]);
  logPhase("read_tables", readStart);
  const prior = priorVerdict(historyCsv);
  if (prior) return prior;
  const tasks = parseTaskCsv(taskCsv ?? "");
  const state = parseStateCsv(stateCsv ?? "");
  const now = new Date().toISOString();
  // A claim is judged at the time its pull request was opened.
  const { locks, removed, opening, expired } = locksAtSubmission(
    lockCsv,
    historyCsv,
  );

  const decideStart = Date.now();
  const outcome =
    kind === "validation"
      ? await decideValidation(
          sha,
          state,
          opening.decide,
          prFiles,
          changedPaths,
          now,
          expired,
          opening.expired,
        )
      : await decideEncoding(
          sha,
          tasks,
          state,
          opening.decide,
          changedPaths,
          envelope,
          now,
          expired,
          parseHistoryCsv(historyCsv ?? ""),
          opening.expired,
        );
  logPhase("decide", decideStart);
  if (isAuditFree(outcome)) return outcome;

  const { files, message, history } = submitCommit({
    pr: boundPr(),
    kind,
    outcome,
    locks,
    removed,
    keptWork: await keepExpiredWork(removed, historyCsv, branch, sha),
    historyCsv,
    now,
    envelope,
  });
  // A push during the decision would otherwise close the pull request on
  // content its author has since replaced.
  if (
    kind === "encoding" &&
    (await getPullRequestDetails(token, owner, repo, prNumber)).headSha !==
      headSha
  )
    throw new HeadMoved();
  const commitStart = Date.now();
  await commitFiles(token, owner, repo, files, message, {
    baseSha: sha,
    baseTreeSha: treeSha,
    branch,
  });
  logPhase("commit", commitStart);
  // The work kept from expired claims is part of the accepted submission.
  if (kind === "encoding" && outcome.ok) {
    await deleteBranch(
      token,
      owner,
      repo,
      keptWorkBranch(history.task_id),
    ).catch((e: Error) =>
      console.warn(`Kept-work branch cleanup skipped: ${e.message}`),
    );
  }
  return outcome;
}

async function runSubmit(
  kind: "encoding" | "validation",
  files: PullRequestFile[],
  envelope: CommandEnvelope | null,
): Promise<void> {
  const verdict = await withRetry(() => attemptSubmit(kind, files, envelope));

  const body = submitComment(kind, verdict);
  const closeStart = Date.now();
  await commentAndClose(body);
  if (shouldCleanupSubmission(kind, verdict.ok)) await cleanupHeadBranch();
  logPhase("comment_and_close", closeStart);
}

// ---------------------------------------------------------------------------
// Comment (a PR appending one discussion row to comment.csv, or resolving one)

async function attemptComment(
  prFiles: PullRequestFile[],
  envelope: CommandEnvelope | null,
): Promise<Verdict & { action: string }> {
  const changedPaths = prFiles.map((f) => f.filename);
  const readStart = Date.now();
  const { branch, sha, treeSha } = await getRepoHead(token, owner, repo);
  const [stateCsv, commentCsv, historyCsv] = await Promise.all([
    getRepoFile(token, owner, repo, STATE_PATH, sha),
    getRepoFile(token, owner, repo, COMMENT_PATH, sha),
    getRepoFile(token, owner, repo, HISTORY_PATH, sha),
  ]);
  logPhase("read_tables", readStart);
  const prior = priorVerdict(historyCsv);
  if (prior) return { ...prior, action: prior.row.action };
  const now = new Date().toISOString();

  // The intent comes from the PR's own patch (merge-base relative), then is
  // re-applied to the freshly read comment table (decideComment). Push
  // access is looked up only for resolving a comment.
  const intent = commentIntent(prFiles);
  const decision = decideComment({
    stateCsv,
    commentCsv,
    intent,
    author,
    changedPaths,
    submittedAt,
    newId: shortId(),
    isCollaborator: intent.resolved ? await authorCanPush() : false,
  });
  const { action, verdict } = decision;

  if (!verdict.ok && isAuditFree(verdict)) {
    return { ok: false, reason: verdict.reason, action };
  }
  const { files, message } = commentCommit({
    pr: boundPr(),
    decision,
    historyCsv,
    now,
    envelope,
  });
  const commitStart = Date.now();
  await commitFiles(token, owner, repo, files, message, {
    baseSha: sha,
    baseTreeSha: treeSha,
    branch,
  });
  logPhase("commit", commitStart);
  return {
    ok: verdict.ok,
    reason: verdict.ok ? undefined : verdict.reason,
    action,
  };
}

async function runComment(
  files: PullRequestFile[],
  envelope: CommandEnvelope | null,
): Promise<void> {
  const verdict = await withRetry(() => attemptComment(files, envelope));
  const body = commentComment(verdict);
  const closeStart = Date.now();
  await commentAndClose(body);
  await cleanupHeadBranch();
  logPhase("comment_and_close", closeStart);
}

// ---------------------------------------------------------------------------
// Reaper (scheduled / manually dispatched)

async function attemptReap(): Promise<void> {
  const readStart = Date.now();
  const { branch, sha, treeSha } = await getRepoHead(token, owner, repo);
  const [lockCsv, historyCsv, stateCsv, configText] = await Promise.all([
    getRepoFile(token, owner, repo, LOCK_PATH, sha),
    getRepoFile(token, owner, repo, HISTORY_PATH, sha),
    getRepoFile(token, owner, repo, STATE_PATH, sha),
    getRepoFile(token, owner, repo, CONFIG_PATH, sha),
  ]);
  logPhase("read_tables", readStart);
  const now = new Date().toISOString();

  const { kept, removed } = reapAt(parseLockCsv(lockCsv ?? ""), now);
  // Reviews whose passes reach a pass threshold lowered since they were
  // recorded are completed here; nothing else can complete them.
  const reached = reachedReviews(stateCsv, configText, kept);
  if (removed.length === 0 && !reached) {
    console.log("No stale locks.");
    return;
  }

  const { files, message } = reapCommit({
    kept,
    removed,
    reached,
    keptWork: await keepExpiredWork(removed, historyCsv, branch, sha),
    historyCsv,
    now,
  });
  const commitStart = Date.now();
  await commitFiles(token, owner, repo, files, message, {
    baseSha: sha,
    baseTreeSha: treeSha,
    branch,
  });
  logPhase("commit", commitStart);
  console.log(message);
}

async function runReap(): Promise<void> {
  prNumber = 0;
  openPullRequests = await listOpenPullRequests(token, owner, repo);
  await withRetry(attemptReap);
}

// ---------------------------------------------------------------------------
// Entry: route by event, then (for PRs) by the operation the changed paths imply
// — lock.csv with comment.csv → review edit, lock.csv → claim (or release),
// state.csv → validation, comment.csv alone → comment, anything
// else → encoding. The boundary check inside each decision
// rejects mixed or out-of-bounds PRs.

// Process the bound pull request. `open` is the campaign's open pull request
// list when the caller already holds it. Returns false when the pull request
// was left alone: it is closed, its head moved past the bound sha (the run for
// the newer push decides it), it is not a campaign operation, or — with
// `capped` — its author has more than MAX_OPEN_PRS_PER_AUTHOR open, which
// leaves it to the scheduled pass.
async function processPullRequest(
  open?: OpenPullRequest[],
  { capped = true } = {},
): Promise<boolean> {
  const readStart = Date.now();
  const [{ body, files, createdAt, state, headSha: currentHeadSha }, openPrs] =
    await Promise.all([
      getPullRequest(token, owner, repo, prNumber),
      open ?? listOpenPullRequests(token, owner, repo),
    ]);
  logPhase("read_pr", readStart);
  openPullRequests = openPrs;
  if (state !== "open") {
    console.log(`PR #${prNumber} is ${state}; left as is.`);
    return false;
  }
  if (currentHeadSha !== headSha) {
    console.log(
      `PR #${prNumber} head moved from ${headSha} to ${currentHeadSha}; left to the run for the newer push.`,
    );
    return false;
  }
  submittedAt = createdAt || new Date().toISOString();
  const changedPaths = files.map((f) => f.filename);
  // The PR body may carry the app command's envelope; treated as data,
  // it names the task and feeds the command columns of the history row this
  // run authors.
  const envelope = envelopeFromPrBody(body);
  // Any pull request other than a campaign operation is left alone, by the
  // catch-up pass as well.
  if (!isCampaignOperation(changedPaths, body, headRef)) {
    console.log(`PR #${prNumber} is no campaign operation; left as is.`);
    return false;
  }
  const openByAuthor = openCountByAuthor(openPrs, author);
  if (capped && openByAuthor > MAX_OPEN_PRS_PER_AUTHOR) {
    console.log(
      `PR #${prNumber}: ${authorLabel} has ${openByAuthor} open pull requests; left open for the scheduled pass.`,
    );
    return false;
  }
  const kind = classifyPullRequest(changedPaths);
  try {
    if (kind === "claim") await runClaim(files, envelope);
    else if (kind === "review_edit") await runReviewEdit(files, envelope);
    else if (kind === "comment") await runComment(files, envelope);
    else await runSubmit(kind, files, envelope);
  } catch (e) {
    if (e instanceof HeadMoved) {
      console.log(
        `PR #${prNumber} head moved during the decision; left to the run for the newer push.`,
      );
      return false;
    }
    if (!(e instanceof TablesBusy)) throw e;
    console.warn(
      `PR #${prNumber}: every attempt lost the commit: ${e.message}`,
    );
    await commentAndClose(tablesBusyComment());
    // An encoding's head branch holds the work, kept for the next attempt.
    if (kind !== "encoding") await cleanupHeadBranch();
  }
  return true;
}

// Only a completed run closes a pull request, so one whose run was lost —
// cancelled, failed, refused by the caller's guard, or never delivered —
// stays open, as does one its own run left to this pass (over the per-author
// limit). The scheduled pass processes those, oldest first, one after
// another, without the per-author limit; a failure on one is logged and the
// next is still processed. A pull request whose own run is still queued or
// running is left to that run, so no pull request is decided by two runs at
// once.
// Drafts and pull requests from non-user accounts are left alone, as the
// caller's guard leaves them; a pull request that is no campaign operation
// is left alone too and does not count against the pass's budget.
async function runCatchUp(): Promise<void> {
  const open = await listOpenPullRequests(token, owner, repo);
  const now = Date.now();
  await closeUndecided(undecidedPullRequests(open, now), open);
  const due = catchUpDue(open, now);
  if (due.length === 0) {
    console.log("No open pull requests to catch up on.");
    return;
  }
  // The open list shrinks as pull requests are closed.
  let remaining = open;
  let processed = 0;
  for (const pr of due) {
    if (processed >= CATCHUP_MAX_PRS) break;
    bindOpenPullRequest(pr);
    try {
      if (await runUnderWay(pr)) {
        console.log(
          `Catch-up: PR #${pr.number} has a run of its own under way; left to it.`,
        );
        continue;
      }
      console.log(
        `Catch-up: processing open PR #${pr.number} by ${authorLabel}.`,
      );
      if (await processPullRequest(remaining, { capped: false })) {
        processed++;
        remaining = remaining.filter((p) => p.number !== pr.number);
      }
    } catch (e) {
      console.error(
        `Catch-up: PR #${pr.number} failed: ${(e as Error).message}`,
      );
      process.exitCode = 1;
    }
  }
}

// Bind an open pull request as the one this run processes.
function bindOpenPullRequest(pr: OpenPullRequest): void {
  const [prHeadOwner, prHeadRepo] = (pr.head.repo?.full_name ?? "").split("/");
  bindPullRequest({
    number: pr.number,
    author: String(pr.user.id),
    authorLogin: pr.user.login,
    headOwner: prHeadOwner ?? "",
    headRepo: prHeadRepo ?? "",
    headSha: pr.head.sha,
    headRef: pr.head.ref,
  });
}

// Whether a run of the pull request's own (on its current head) is under way;
// that run decides it.
async function runUnderWay(pr: OpenPullRequest): Promise<boolean> {
  const runs = await listWorkflowRuns(token, owner, repo, "caller.yml", {
    event: "pull_request_target",
    headSha: pr.head.sha,
  });
  return runs.some((run) => run.status !== "completed");
}

// Campaign operations older than CATCHUP_MAX_AGE_MS are no longer decided:
// they are closed with a comment saying so, which the app shows as the
// rejection. One decided before, whose comment or close was lost, gets its
// decision posted again instead; one with a run of its own under way is left
// to it. A failure is logged, fails the run, and the next pass tries again.
async function closeUndecided(
  stale: OpenPullRequest[],
  open: OpenPullRequest[],
): Promise<void> {
  if (stale.length === 0) return;
  const readHistory = async (): Promise<HistoryRow[]> =>
    parseHistoryCsv(
      (await getRepoFile(token, owner, repo, HISTORY_PATH)) ?? "",
    );
  let history: HistoryRow[];
  try {
    history = await readHistory();
  } catch (e) {
    // The pass for the younger pull requests goes on without this one.
    console.error(
      `Could not read the history to close undecided PRs: ${(e as Error).message}`,
    );
    process.exitCode = 1;
    return;
  }
  for (const pr of stale) {
    try {
      if (await runUnderWay(pr)) continue;
      if (priorDecision(history, pr.number)) {
        bindOpenPullRequest(pr);
        await processPullRequest(open, { capped: false });
        continue;
      }
      const { body, files } = await getPullRequest(
        token,
        owner,
        repo,
        pr.number,
      );
      if (
        !isCampaignOperation(
          files.map((f) => f.filename),
          body,
          pr.head.ref,
        )
      )
        continue;
      // A run may have decided it since the history was read.
      if (priorDecision(await readHistory(), pr.number)) {
        console.log(`PR #${pr.number} was decided meanwhile; not closed.`);
        continue;
      }
      await commentAndClose(UNDECIDED_COMMENT, pr.number);
      console.log(`Closed PR #${pr.number}: not decided within seven days.`);
    } catch (e) {
      console.error(
        `Could not close the undecided PR #${pr.number}: ${(e as Error).message}`,
      );
      process.exitCode = 1;
    }
  }
}

// An operation branch whose pull request was never opened (a request that
// failed after GitHub created the branch) or whose cleanup failed stays in
// the campaign repo; the scheduled pass deletes those (isLeftoverOperationBranch).
async function sweepOperationBranches(): Promise<void> {
  const [branches, open] = await Promise.all([
    listBranchCommitTimes(token, owner, repo, isOperationBranch),
    listOpenPullRequests(token, owner, repo),
  ]);
  const openHeads = new Set(open.map((pr) => pr.head.ref));
  const now = Date.now();
  for (const branch of branches) {
    if (!isLeftoverOperationBranch(branch, openHeads, now)) continue;
    try {
      await deleteBranch(token, owner, repo, branch.name);
      console.log(`Deleted the leftover branch ${branch.name}.`);
    } catch (e) {
      console.error(
        `Could not delete the leftover branch ${branch.name}: ${(e as Error).message}`,
      );
      process.exitCode = 1;
    }
  }
}

async function run(): Promise<void> {
  // The catch-up pass runs before the reaper: it judges each pull request
  // at its opening time, and the reaper would first remove the locks that
  // expired since.
  // Each phase runs whatever became of the one before; a failed phase fails
  // the run.
  if (eventName === "schedule" || eventName === "workflow_dispatch") {
    for (const phase of [runCatchUp, runReap, sweepOperationBranches]) {
      try {
        await phase();
      } catch (e) {
        console.error(`${phase.name} failed: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    }
    return;
  }
  if (eventName !== "pull_request_target") {
    throw new Error(`Unsupported event: ${eventName}`);
  }
  const [envHeadOwner, envHeadRepo] = (process.env.HEAD_REPO ?? "").split("/");
  bindPullRequest({
    number: Number(process.env.PR_NUMBER),
    author: process.env.PR_AUTHOR ?? "",
    authorLogin: process.env.PR_AUTHOR_LOGIN ?? "",
    headOwner: envHeadOwner ?? "",
    headRepo: envHeadRepo ?? "",
    headSha: process.env.HEAD_SHA ?? "",
    headRef: process.env.HEAD_REF ?? "",
  });
  await processPullRequest();
}

// Text from forks reaches this run's log, and the runner acts on a line such
// as `::add-mask::` or `::error::` in it. The coordinator issues no workflow
// commands, so the runner stops processing them for the rest of the run.
console.log(`::stop-commands::${crypto.randomUUID()}`);

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() =>
    // JSON on one line, so log collectors can extract the whole summary.
    console.info(
      "[github-api-summary]",
      JSON.stringify(getGitHubRequestTelemetry()),
    ),
  );
