// The decisions of the coordinator on encoding and review verdict
// submissions over values the run has already read: the verdict, the files to
// commit with its message, the history row and the verdict comment.
// scripts/coordinator.ts does the GitHub reads and writes around them.

import {
  appendHistory,
  parseCommentCsv,
  passThresholdOf,
  serializeCommentCsv,
  serializeLockCsv,
  serializeStateCsv,
  serializeTaskCsv,
  COMMENT_PATH,
  CONFIG_PATH,
  HISTORY_PATH,
  LOCK_PATH,
  STATE_PATH,
  TASK_PATH,
} from "./campaign-tables.ts";
import type {
  CommentRow,
  HistoryRow,
  LockRow,
  ParsedState,
  TaskRow,
} from "./campaign-tables.ts";
import type { CommandEnvelope } from "./command-envelope.ts";
import {
  checkEncoding,
  checkValidation,
  resolveChangeRequests,
  sideFilesOf,
} from "./campaign-submit.ts";
import { measuredSurfaceIds } from "./mei-facsimile.ts";
import { BaseScoreError } from "./mei-page-splice.ts";
import { replanPageTasks } from "./campaign-plan.ts";
import type { Contribution } from "./mei-provenance.ts";
import { isPreTask } from "./campaign-graph.ts";
import {
  appendedCommentsFromPatch,
  assembleSubmission,
  isAutomaticCommit,
  isReviewEdit,
  rejectionDetail,
  rejectionOutcome,
  resolveEncodingTask,
  validationIntentFromPatch,
  validationVerdict,
} from "./coordinator-policy.ts";
import {
  authorLabelOf,
  coAuthored,
  explainReason,
  historyColumns,
} from "./coordinator-operations.ts";
import type {
  BoundPullRequest,
  ChangedFile,
  TableCommit,
  TableFile,
  Verdict,
} from "./coordinator-operations.ts";
import { expiryRows } from "./coordinator-maintenance.ts";

/**
 * A submission's decision: for an accepted one the files it commits and the
 * commit's message; for every decision but an audit-free rejection its
 * history row.
 */
export type SubmitDecision = Verdict & {
  files?: TableFile[];
  message?: string;
  history?: HistoryRow;
};

/**
 * The task an encoding submission is for, if everything but its MEI check
 * accepts it; the rejection otherwise. A submitter who holds no claim cannot
 * make the run read their file.
 */
export function encodingPrecheck({
  tasks,
  state,
  locks,
  envelope,
  headRef,
  author,
  changedPaths,
  now,
  expired,
}: {
  tasks: TaskRow[];
  state: ParsedState;
  locks: LockRow[];
  envelope: CommandEnvelope | null;
  headRef: string;
  author: string;
  changedPaths: string[];
  now: string;
  expired: LockRow[];
}): { task: TaskRow } | { rejected: SubmitDecision } {
  const task = resolveEncodingTask({ tasks, envelope, headRef });
  if (!task) return { rejected: { ok: false, reason: "unknown_task" } };
  const precheck = checkEncoding({
    tasks,
    state,
    locks,
    intent: { task_id: task.task_id },
    author,
    changedPaths,
    meiValid: true,
    now,
    expired,
  });
  if (!precheck.ok) {
    return {
      rejected: {
        ok: false,
        reason: precheck.reason,
        detail: "",
        history: {
          timestamp: now,
          task_id: task.task_id,
          subtask_id: "",
          user_id: author,
          action: "submit_encoding",
          outcome: "rejected",
          detail: precheck.reason,
        },
      },
    };
  }
  return { task };
}

/**
 * Why an encoding cannot be assembled from the files read, or null when it
 * can: the fork's file is missing, or the campaign's score or, for a page
 * task, config.yaml is (`baseFailed`: the campaign's side fails).
 */
export function encodingInputGap({
  task,
  forkMei,
  baseMei,
  configText,
  isPageTask,
}: {
  task: TaskRow;
  forkMei: string | null;
  baseMei: string | null;
  configText: string | null;
  isPageTask: boolean;
}): { detail: string; baseFailed: boolean } | null {
  if (forkMei == null)
    return {
      detail: `${task.fragment} is missing from the fork.`,
      baseFailed: false,
    };
  if (baseMei == null)
    return {
      detail: `${task.fragment} is missing from the campaign.`,
      baseFailed: true,
    };
  if (isPageTask && configText == null)
    return {
      detail: `${CONFIG_PATH} is missing from the campaign.`,
      baseFailed: true,
    };
  return null;
}

/**
 * The contributions an accepted encoding of `task` records in the score's
 * header: the expired claims whose unsubmitted work it continues (`kept`,
 * keptWorkSince, each with its holder's login or null for a deleted
 * account), each dated at its expiry, then the author's, with the newest
 * commit message they wrote. Encodings are edited in mei-friend; a pre-task
 * is edited in the app itself, whose <application> entry every generated
 * score already carries. Throws when the pull request names no author login.
 */
export function encodingContributions({
  task,
  kept,
  commitMessages,
  pr,
  pastHistory,
  now,
}: {
  task: TaskRow;
  kept: { row: HistoryRow; login: string | null }[];
  commitMessages: string[];
  pr: BoundPullRequest;
  pastHistory: HistoryRow[];
  now: string;
}): Contribution[] {
  const application = isPreTask(task.locator) ? undefined : "mei-friend";
  const contributions: Contribution[] = [];
  for (const { row, login } of kept) {
    contributions.push({
      name: login ?? "ghost",
      id: row.user_id,
      message: `Unsubmitted work on ${task.task_id}, kept when the claim expired.`,
      isodate: row.timestamp.slice(0, 10),
      application,
    });
  }
  // The newest message the claimer wrote, not one of the app's commits.
  const message =
    commitMessages.filter((m) => !isAutomaticCommit(m)).at(-1) ??
    `Encoding of ${task.task_id} accepted.`;
  if (!pr.authorLogin)
    throw new Error(`Pull request #${pr.number} names no author login.`);
  contributions.push({
    name: pr.authorLogin,
    id: pr.author,
    message: isReviewEdit(pastHistory, task.task_id, pr.author)
      ? `Corrected during review: ${message}`
      : message,
    isodate: now.slice(0, 10),
    application,
  });
  return contributions;
}

/**
 * The campaign score an encoding submission makes (assembleSubmission), or,
 * when it cannot be assembled, the rejection's detail and whether the
 * campaign's score is at fault (BaseScoreError); `spliceError` is the
 * assembly's error message.
 */
export function assembleEncoding(
  args: Parameters<typeof assembleSubmission>[0],
):
  | { mei: string; detail: string; baseFailed: boolean }
  | { mei: null; detail: string; baseFailed: boolean; spliceError: string } {
  const { task } = args;
  try {
    return { mei: assembleSubmission(args), detail: "", baseFailed: false };
  } catch (err) {
    const message = (err as Error).message;
    return {
      mei: null,
      detail: `Could not splice page ${task.locator} into ${task.fragment}: ${message}`,
      baseFailed: err instanceof BaseScoreError,
      spliceError: message,
    };
  }
}

/**
 * The verdict on an encoding submission once its MEI is checked: the
 * rejection, or the accepted state and locks with the history row. A schema
 * failure of the assembled score is `splice_invalid` when the join is at
 * fault (`joinFailed`), `mei_invalid` otherwise; only those two carry
 * `detail`.
 */
export function encodingVerdict({
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
}: {
  tasks: TaskRow[];
  state: ParsedState;
  locks: LockRow[];
  task: TaskRow;
  author: string;
  changedPaths: string[];
  meiValid: boolean;
  joinFailed: boolean;
  detail: string;
  now: string;
  expired: LockRow[];
}):
  | { rejected: SubmitDecision }
  | { state: ParsedState; locks: LockRow[]; history: HistoryRow } {
  const verdict = checkEncoding({
    tasks,
    state,
    locks,
    intent: { task_id: task.task_id },
    author,
    changedPaths,
    meiValid,
    now,
    expired,
  });

  const reason = verdict.ok
    ? ""
    : joinFailed && verdict.reason === "mei_invalid"
      ? "splice_invalid"
      : verdict.reason;
  const history: HistoryRow = {
    timestamp: now,
    task_id: task.task_id,
    subtask_id: "",
    user_id: author,
    action: "submit_encoding",
    outcome: verdict.ok ? "accepted" : "rejected",
    detail: reason,
  };
  if (!verdict.ok) {
    return {
      rejected: {
        ok: false,
        reason,
        detail:
          reason === "mei_invalid" || reason === "splice_invalid" ? detail : "",
        history,
      },
    };
  }
  return { state: verdict.state, locks: verdict.locks, history };
}

/**
 * The side files of `task` the submission changed (a layout correction's raw
 * layout, a score setup's recognition record); they are taken from the fork
 * as they are.
 */
export const submittedSideFiles = (
  task: TaskRow,
  changedPaths: string[],
): string[] => sideFilesOf(task).filter((path) => changedPaths.includes(path));

/**
 * An accepted encoding's decision: the score, the side files read from the
 * fork (those missing there are left out), the task table when the piece's
 * page tasks are rebuilt, and the state and lock tables. `held` are the
 * author's locks the decision left out; they stay in lock.csv.
 */
export function acceptedEncoding({
  pr,
  task,
  tasks,
  mei,
  sideFiles,
  accepted,
  held,
  pastHistory,
}: {
  pr: BoundPullRequest;
  task: TaskRow;
  tasks: TaskRow[];
  mei: string;
  sideFiles: { path: string; content: string | null }[];
  accepted: { state: ParsedState; locks: LockRow[]; history: HistoryRow };
  held: LockRow[];
  pastHistory: HistoryRow[];
}): SubmitDecision {
  const files = sideFiles.flatMap(({ path, content }) =>
    content == null ? [] : [{ path, content }],
  );
  const nextLocks = [...accepted.locks, ...held];
  // An accepted measure or layout correction fixes which pages carry
  // measures: the piece's page tasks are rebuilt for those pages, so a page
  // without music gets no task.
  const replan =
    task.locator === "omr-layout" || task.locator === "measure-zones"
      ? replanPageTasks(
          tasks,
          accepted.state,
          nextLocks,
          pastHistory,
          task.fragment,
          measuredSurfaceIds(mei),
        )
      : null;
  const newState = replan
    ? { ...accepted.state, rows: replan.stateRows }
    : accepted.state;

  return {
    ok: true,
    history: accepted.history,
    files: [
      { path: task.fragment, content: mei },
      ...files,
      ...(replan
        ? [{ path: TASK_PATH, content: serializeTaskCsv(replan.tasks) }]
        : []),
      { path: STATE_PATH, content: serializeStateCsv(newState) },
      { path: LOCK_PATH, content: serializeLockCsv(nextLocks) },
    ],
    message: `Accept encoding of ${task.task_id} by ${authorLabelOf(pr)}`,
  };
}

/** A review verdict's intent, read from the PR's state.csv and comment.csv patches. */
export interface ValidationIntent {
  task_id: string;
  subtask_id: string;
  status: "pass" | "fail";
  /** The one comment row the PR appends; null when it appends none or several. */
  failComment: CommentRow | null;
  /** Whether the decision reads comment.csv. */
  wantsComments: boolean;
}

/**
 * The intent of a review verdict, read from the PR's own patch — the diff
 * against its merge base — so an unrelated commit landing after the PR was
 * opened cannot make it look malformed; the rejection when it is no verdict.
 * The comment table is read when the PR touches it (a fail's mandatory
 * comment) or for a pass (it resolves the task's change requests).
 */
export function validationIntent({
  prFiles,
  changedPaths,
  state,
  author,
  now,
}: {
  prFiles: ChangedFile[];
  changedPaths: string[];
  state: ParsedState;
  author: string;
  now: string;
}): ValidationIntent | { rejected: SubmitDecision } {
  const statePatch = prFiles.find((f) => f.filename === STATE_PATH)?.patch;
  const diff = validationIntentFromPatch(statePatch, state.header);
  if (!diff || !state.validationColumns.includes(diff.column))
    return { rejected: { ok: false, reason: "malformed_validation" } };
  const status = validationVerdict(diff.value);
  if (!status)
    return {
      rejected: {
        ok: false,
        reason: "invalid_verdict",
        history: {
          timestamp: now,
          task_id: diff.task_id,
          subtask_id: diff.subtask_id,
          user_id: author,
          action: "submit_validation",
          outcome: "rejected",
          detail: "invalid_verdict",
        },
      },
    };
  // A fail's mandatory comment rides the same PR as one appended comment row.
  let failComment: CommentRow | null = null;
  if (changedPaths.includes(COMMENT_PATH)) {
    const added = appendedCommentsFromPatch(
      prFiles.find((f) => f.filename === COMMENT_PATH)?.patch,
    );
    failComment = added?.length === 1 ? added[0] : null;
  }
  return {
    task_id: diff.task_id,
    subtask_id: diff.subtask_id,
    status,
    failComment,
    wantsComments: changedPaths.includes(COMMENT_PATH) || status === "pass",
  };
}

/**
 * The decision on a review verdict. The check re-applies the intent to the
 * freshly read tables, and the coordinator commits its own serialization; the
 * fork's file bytes never land. A fail's comment is re-authored — id
 * (`newId`), author and timestamp are never the fork's values. `held` are the
 * author's locks the decision left out; they stay in lock.csv.
 */
export function decideValidation({
  pr,
  intent,
  state,
  locks,
  configText,
  baseCommentCsv,
  changedPaths,
  now,
  expired,
  held,
  newId,
}: {
  pr: BoundPullRequest;
  intent: ValidationIntent;
  state: ParsedState;
  locks: LockRow[];
  configText: string | null;
  baseCommentCsv: string | null;
  changedPaths: string[];
  now: string;
  expired: LockRow[];
  held: LockRow[];
  newId: string;
}): SubmitDecision {
  const { task_id, subtask_id, status, failComment } = intent;
  let baseComments: CommentRow[] = [];
  if (intent.wantsComments)
    baseComments = parseCommentCsv(baseCommentCsv ?? "");

  const verdict = checkValidation({
    state,
    locks,
    intent: { task_id, subtask_id, verdict: status },
    author: pr.author,
    changedPaths,
    passThreshold: passThresholdOf(configText, state.validationColumns.length),
    failComment,
    now,
    expired,
  });

  const history: HistoryRow = {
    timestamp: now,
    task_id,
    subtask_id,
    user_id: pr.author,
    action: "submit_validation",
    outcome: verdict.ok ? "accepted" : "rejected",
    detail: verdict.ok ? status : verdict.reason,
  };
  if (!verdict.ok) return { ok: false, reason: verdict.reason, history };

  const files: TableFile[] = [
    { path: STATE_PATH, content: serializeStateCsv(verdict.state) },
    { path: LOCK_PATH, content: serializeLockCsv([...verdict.locks, ...held]) },
  ];
  if (status === "fail") {
    // The fail's comment is part of the verdict: it carries the verdict's own
    // timestamp, which is what pairs the two in the tables.
    const authoredComment: CommentRow = {
      ...failComment!,
      comment_id: newId,
      author_id: pr.author,
      timestamp: now,
      resolved: "",
      parent_id: "",
    };
    files.push({
      path: COMMENT_PATH,
      content: serializeCommentCsv([...baseComments, authoredComment]),
    });
  } else {
    const resolved = resolveChangeRequests(baseComments, task_id);
    if (resolved)
      files.push({
        path: COMMENT_PATH,
        content: serializeCommentCsv(resolved),
      });
  }
  const message = `Record ${status} validation of ${task_id}/${subtask_id} by ${authorLabelOf(pr)}`;

  return { ok: true, history, files, message };
}

/**
 * What a submission's decision commits, other than an audit-free rejection:
 * the decision's files, the history rows, and the lock table when locks
 * expired and the decision does not write it; with the history row the
 * decision recorded.
 */
export function submitCommit({
  pr,
  kind,
  outcome,
  locks,
  removed,
  keptWork,
  historyCsv,
  now,
  envelope,
}: {
  pr: BoundPullRequest;
  kind: "encoding" | "validation";
  outcome: SubmitDecision;
  locks: LockRow[];
  removed: LockRow[];
  keptWork: Set<LockRow>;
  historyCsv: string | null;
  now: string;
  envelope: CommandEnvelope | null;
}): TableCommit & { history: HistoryRow } {
  // Every decision other than an audit-free rejection carries its history
  // row, naming the task.
  const history: HistoryRow = {
    ...outcome.history!,
    ...historyColumns(envelope),
    pr: String(pr.number),
  };
  const files: TableFile[] = [
    ...(outcome.files ?? []),
    {
      path: HISTORY_PATH,
      content: appendHistory(historyCsv ?? "", [
        ...expiryRows(removed, now, keptWork),
        history,
      ]),
    },
  ];
  // An accepted outcome writes the lock table itself, from the kept locks.
  if (removed.length && !files.some((f) => f.path === LOCK_PATH))
    files.push({ path: LOCK_PATH, content: serializeLockCsv(locks) });
  const message = outcome.ok
    ? coAuthored(outcome.message!, pr)
    : `Reject ${kind} submission by ${authorLabelOf(pr)} (${outcome.reason})`;
  return { files, message, history };
}

/** The comment that closes a submission's pull request. */
export function submitComment(
  kind: "encoding" | "validation",
  verdict: Verdict,
): string {
  return verdict.ok
    ? `✅ Submission accepted (${kind === "validation" ? "review" : kind}).`
    : `❌ Submission rejected: ${explainReason(verdict.reason)}. ${rejectionOutcome(verdict.reason, kind === "encoding")}` +
        (verdict.detail ? ` ${rejectionDetail(verdict.detail)}` : "");
}
