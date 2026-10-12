// Submission validation (encoding and validation outcome), with state
// advancement + attribution folded in. Pure decision logic: current tables +
// PR facts in, accept (with the mutated tables) or reject out. No GitHub.
// See DESIGN.md §6 (volunteer PR contract).
//
// Addressing follows the (task_id, subtask_id) convention: an encoding targets
// the task row (empty subtask_id), a validation targets one subtask row.
// The Action authors all table mutations: encoder/validator identity is the
// PR author and timestamps are the injected `now`, never values the fork
// supplied. The volunteer's MEI *content* is handled by the coordinator (it
// merges/commits the fork's bytes after `meiValid`); these functions only
// produce the authoritative table changes.

import { boundaryCheck } from "./campaign-claim.ts";
import { claimRanOut } from "./campaign-reaper.ts";
import { correctedLayoutPath, layoutRecordPath } from "./omr-layout.ts";
import { omrRecordPath } from "./omr-record.ts";
import {
  findRow,
  isFinalValidation,
  COMMENT_PATH,
  LOCK_PATH,
  STATE_PATH,
} from "./campaign-tables.ts";
import type {
  ParsedState,
  StateRow,
  TaskRow,
  LockRow,
  CommentRow,
} from "./campaign-tables.ts";

/** Encoding submission intent: just the task being encoded. */
export interface EncodingIntent {
  task_id: string;
}

/** Validation submission intent: the subtask and the verdict being recorded. */
export interface ValidationIntent {
  task_id: string;
  subtask_id: string;
  verdict: string;
}

export interface CheckEncodingArgs {
  tasks: TaskRow[];
  state: ParsedState;
  locks: LockRow[];
  intent: EncodingIntent;
  author: string;
  changedPaths: string[];
  meiValid: boolean;
  now: string;
  /**
   * Locks dropped as expired before this decision; the author's own lock
   * among them rejects the submission as `claim_expired`.
   */
  expired?: LockRow[];
}

export interface CheckValidationArgs {
  state: ParsedState;
  locks: LockRow[];
  intent: ValidationIntent;
  author: string;
  changedPaths: string[];
  passThreshold: number;
  /**
   * The comment row the PR adds to comment.csv, when it adds exactly one
   * (parsed by the coordinator); null otherwise. A fail verdict requires it —
   * the validator cannot fail an encoding without saying why.
   */
  failComment: CommentRow | null;
  now: string;
  /**
   * Locks dropped as expired before this decision; the author's own lock
   * among them rejects the submission as `claim_expired`.
   */
  expired?: LockRow[];
}

export type SubmitResult =
  | { ok: true; state: ParsedState; locks: LockRow[] }
  | { ok: false; reason: string };

const reject = (reason: string): SubmitResult => ({ ok: false, reason });

function cloneState(state: ParsedState): ParsedState {
  return {
    header: [...state.header],
    validationColumns: [...state.validationColumns],
    rows: state.rows.map((r) => ({ ...r })),
  };
}

/**
 * Reset a task's state rows to the encoding stage: the task row to
 * encoding_required with attribution cleared, its subtasks to pending, every
 * validation cell emptied. Mutates the given rows in place. Shared by the
 * fail verdict (checkValidation) and the review edit (checkReviewEdit), so
 * both return a task to the same state.
 */
export function resetTaskRows(
  rows: StateRow[],
  validationColumns: string[],
  task_id: string,
): void {
  for (const r of rows) {
    if (r.task_id !== task_id) continue;
    if (r.subtask_id === "") {
      r.status = "encoding_required";
      r.encoder = "";
      r.encoded_at = "";
    } else {
      r.status = "pending";
    }
    for (const column of validationColumns) r[column] = "";
  }
}

/**
 * The files a pre-task's submission may commit beside its score: the
 * corrected boxes (`layout-corrected.json`) and the layout model's raw output
 * (`layout.json`) for a layout correction, the recognition record (`omr.xml`)
 * for a score setup.
 */
export function sideFilesOf(task: {
  locator: string;
  fragment: string;
}): string[] {
  if (task.locator === "omr-layout")
    return [
      correctedLayoutPath(task.fragment),
      layoutRecordPath(task.fragment),
    ];
  if (task.locator === "score-setup") return [omrRecordPath(task.fragment)];
  return [];
}

/**
 * Encoding submission. The PR may change only the task's fragment (plus its
 * side files, see sideFilesOf), or nothing at all, the author
 * must hold the active encoding lock, and the MEI must pass the machine-check
 * (`meiValid`, computed by the coordinator). On accept: the task row advances
 * to validation_required with encoder/encoded_at set, its pending subtasks
 * open for validation, and the encoding lock is removed. A task with no
 * validation subtasks completes directly on its accepted submission.
 */
export function checkEncoding({
  tasks,
  state,
  locks,
  intent,
  author,
  changedPaths,
  meiValid,
  now,
  expired = [],
}: CheckEncodingArgs): SubmitResult {
  const task = findRow(tasks, intent.task_id, "");
  const row = findRow(state.rows, intent.task_id, "");
  if (!task || !row) return reject("unknown_task");
  // An encoding completed without changes changes no file at all.
  if (
    changedPaths.length > 0 &&
    !boundaryCheck(changedPaths, [task.fragment, ...sideFilesOf(task)])
  )
    return reject("out_of_bounds");
  if (row.status !== "encoding_required") return reject("wrong_state");

  const holdsLock = locks.some(
    (l) =>
      l.task_id === intent.task_id &&
      l.subtask_id === "" &&
      l.kind === "encoding" &&
      l.user_id === author,
  );
  if (!holdsLock)
    return reject(
      claimRanOut(
        expired,
        { task_id: intent.task_id, subtask_id: "", kind: "encoding" },
        author,
      )
        ? "claim_expired"
        : "not_lock_holder",
    );
  if (!meiValid) return reject("mei_invalid");

  const hasSubtasks = state.rows.some(
    (r) => r.task_id === intent.task_id && r.subtask_id !== "",
  );
  const next = cloneState(state);
  for (const r of next.rows) {
    if (r.task_id !== intent.task_id) continue;
    if (r.subtask_id === "") {
      r.status = hasSubtasks ? "validation_required" : "completed";
      r.encoder = author;
      r.encoded_at = now;
    } else if (r.status === "pending") {
      r.status = "validation_required";
    }
  }

  const nextLocks = locks.filter(
    (l) =>
      !(
        l.task_id === intent.task_id &&
        l.subtask_id === "" &&
        l.kind === "encoding" &&
        l.user_id === author
      ),
  );
  return { ok: true, state: next, locks: nextLocks };
}

/**
 * Validation outcome. The PR may change only state.csv (as the verdict
 * vehicle) — plus comment.csv on a fail, whose one added row carries the
 * mandatory explanation. The author must hold the subtask's active validation
 * lock, and there must be an open validate_status slot. On accept: the first
 * open slot becomes `<verdict>|<author>|<now>` and the validation lock is
 * removed. A fail sends the task back for encoding in the same step: it is
 * reset by resetTaskRows and every lock on it is released; the fail stays on
 * record in history.csv and its comment in comment.csv. On passes, the
 * subtask completes once `passThreshold` pass cells accumulate, and the task
 * row completes once every subtask has.
 */
export function checkValidation({
  state,
  locks,
  intent,
  author,
  changedPaths,
  passThreshold,
  failComment,
  now,
  expired = [],
}: CheckValidationArgs): SubmitResult {
  const row = findRow(state.rows, intent.task_id, intent.subtask_id);
  if (!row || intent.subtask_id === "") return reject("unknown_task");
  if (intent.verdict !== "pass" && intent.verdict !== "fail")
    return reject("invalid_verdict");
  if (intent.verdict === "fail") {
    if (!boundaryCheck(changedPaths, [STATE_PATH, COMMENT_PATH])) {
      return reject("out_of_bounds");
    }
    if (
      !failComment ||
      failComment.kind !== "fail" ||
      failComment.task_id !== intent.task_id ||
      failComment.subtask_id !== intent.subtask_id ||
      failComment.body.trim() === ""
    ) {
      return reject("fail_without_comment");
    }
  } else if (!boundaryCheck(changedPaths, [STATE_PATH])) {
    return reject("out_of_bounds");
  }
  if (row.status !== "validation_required") return reject("wrong_state");

  const holdsLock = locks.some(
    (l) =>
      l.task_id === intent.task_id &&
      l.subtask_id === intent.subtask_id &&
      l.kind === "validation" &&
      l.user_id === author,
  );
  if (!holdsLock)
    return reject(
      claimRanOut(expired, { ...intent, kind: "validation" }, author)
        ? "claim_expired"
        : "not_lock_holder",
    );

  const slot = state.validationColumns.find((c) => (row[c] ?? "") === "");
  if (!slot) return reject("no_open_validation_slot");

  const next = cloneState(state);
  if (intent.verdict === "fail") {
    resetTaskRows(next.rows, next.validationColumns, intent.task_id);
    return {
      ok: true,
      state: next,
      locks: locks.filter((l) => l.task_id !== intent.task_id),
    };
  }
  const nextRow = findRow(next.rows, intent.task_id, intent.subtask_id)!;
  nextRow[slot] = `${intent.verdict}|${author}|${now}`;

  const passCount = next.validationColumns.filter((c) => {
    const cell = nextRow[c] ?? "";
    return isFinalValidation(cell) && cell.startsWith("pass|");
  }).length;
  if (passCount >= passThreshold) nextRow.status = "completed";

  // The task completes when its last subtask does.
  const subtasks = next.rows.filter(
    (r) => r.task_id === intent.task_id && r.subtask_id !== "",
  );
  if (subtasks.every((r) => r.status === "completed")) {
    findRow(next.rows, intent.task_id, "")!.status = "completed";
  }

  const nextLocks = locks.filter(
    (l) =>
      !(
        l.task_id === intent.task_id &&
        l.subtask_id === intent.subtask_id &&
        l.kind === "validation" &&
        l.user_id === author
      ),
  );
  return { ok: true, state: next, locks: nextLocks };
}

/** Edit-from-review intent: the subtask whose review switches to editing. */
export interface ReviewEditIntent {
  task_id: string;
  subtask_id: string;
}

export interface CheckReviewEditArgs {
  state: ParsedState;
  locks: LockRow[];
  intent: ReviewEditIntent;
  author: string;
  changedPaths: string[];
  /** The fail comment row the PR adds to comment.csv; null when it adds none or several. */
  failComment: CommentRow | null;
  now: string;
  /** Lock lifetime (locking.stale_after_minutes); sets the new lock's `expires`. */
  staleAfterMinutes: number;
  /**
   * Locks dropped as expired before this decision; the author's own review
   * lock among them rejects the switch as `claim_expired`.
   */
  expired?: LockRow[];
}

/**
 * A reviewer switching to editing: a fail and a send-back in one step, with
 * the task's encoding claim going to the reviewer. The PR may change only
 * lock.csv (removing the reviewer's own review lock) and comment.csv (one
 * added fail comment saying what the edit is for). The author must hold the
 * subtask's review lock while it is in review. On accept: the task is reset
 * as by a fail verdict (checkValidation), every lock on it is released, and the
 * author holds a fresh encoding lock.
 */
export function checkReviewEdit({
  state,
  locks,
  intent,
  author,
  changedPaths,
  failComment,
  now,
  staleAfterMinutes,
  expired = [],
}: CheckReviewEditArgs): SubmitResult {
  if (!boundaryCheck(changedPaths, [LOCK_PATH, COMMENT_PATH]))
    return reject("out_of_bounds");
  const row = findRow(state.rows, intent.task_id, intent.subtask_id);
  if (!row || intent.subtask_id === "") return reject("unknown_task");
  if (
    !failComment ||
    failComment.kind !== "fail" ||
    failComment.task_id !== intent.task_id ||
    failComment.subtask_id !== intent.subtask_id ||
    failComment.body.trim() === ""
  )
    return reject("fail_without_comment");
  if (row.status !== "validation_required") return reject("wrong_state");
  const holdsLock = locks.some(
    (l) =>
      l.task_id === intent.task_id &&
      l.subtask_id === intent.subtask_id &&
      l.kind === "validation" &&
      l.user_id === author,
  );
  if (!holdsLock)
    return reject(
      claimRanOut(expired, { ...intent, kind: "validation" }, author)
        ? "claim_expired"
        : "not_lock_holder",
    );

  const next = cloneState(state);
  resetTaskRows(next.rows, next.validationColumns, intent.task_id);
  return {
    ok: true,
    state: next,
    locks: [
      ...locks.filter((l) => l.task_id !== intent.task_id),
      {
        task_id: intent.task_id,
        subtask_id: "",
        user_id: author,
        timestamp: now,
        kind: "encoding",
        expires: new Date(
          Date.parse(now) + staleAfterMinutes * 60_000,
        ).toISOString(),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Comments (discussion): adding and resolving rows of comment.csv.

export interface CheckCommentArgs {
  state: ParsedState;
  /** The base comment table the PR builds on. */
  comments: CommentRow[];
  /** The one row the PR appends to comment.csv; null when the PR is not a clean single-row append. */
  added: CommentRow | null;
  author: string;
  changedPaths: string[];
  now: string;
  /** The comment_id the automation assigns to the accepted row. */
  newId: string;
}

export type CommentResult =
  | { ok: true; row: CommentRow }
  | { ok: false; reason: string };

const DISCUSSION_KINDS = ["comment", "reply"];

/**
 * A discussion comment. The PR may only append one row to comment.csv; `fail`
 * comments never arrive this way (they ride the fail-validation PR). An empty
 * task_id makes it a campaign comment, which names no subtask. The
 * automation authors the id, author and timestamp — never the fork's values.
 */
export function checkComment({
  state,
  comments,
  added,
  author,
  changedPaths,
  now,
  newId,
}: CheckCommentArgs): CommentResult {
  if (!boundaryCheck(changedPaths, [COMMENT_PATH]))
    return { ok: false, reason: "out_of_bounds" };
  if (!added) return { ok: false, reason: "malformed_comment" };
  if (!DISCUSSION_KINDS.includes(added.kind))
    return { ok: false, reason: "invalid_kind" };
  if (added.body.trim() === "") return { ok: false, reason: "empty_comment" };
  if (
    added.task_id === ""
      ? added.subtask_id !== ""
      : !findRow(state.rows, added.task_id, "")
  )
    return { ok: false, reason: "unknown_task" };
  if (added.kind === "reply") {
    const parent = comments.find((c) => c.comment_id === added.parent_id);
    if (!parent) return { ok: false, reason: "unknown_parent" };
    // Replies attach to the top-level discussion comments only — the ones
    // the threads projection renders as roots — of the same task, or of the
    // campaign.
    if (parent.kind !== "comment" || parent.task_id !== added.task_id) {
      return { ok: false, reason: "invalid_parent" };
    }
  } else if (added.parent_id !== "") {
    return { ok: false, reason: "invalid_parent" };
  }
  return {
    ok: true,
    row: {
      ...added,
      comment_id: newId,
      author_id: author,
      timestamp: now,
      resolved: "",
    },
  };
}

export interface CheckResolveCommentArgs {
  comments: CommentRow[];
  /** The comment the PR marks resolved. */
  comment_id: string;
  author: string;
  changedPaths: string[];
  /** Whether the author has push access to the campaign repo. */
  isCollaborator: boolean;
}

/**
 * The comment table with `comment_id` and every reply chaining to it via
 * parent_id marked resolved. Rows outside the thread are untouched.
 */
export function resolveCommentThread(
  comments: CommentRow[],
  comment_id: string,
): CommentRow[] {
  const thread = new Set([comment_id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of comments) {
      if (c.parent_id && thread.has(c.parent_id) && !thread.has(c.comment_id)) {
        thread.add(c.comment_id);
        grew = true;
      }
    }
  }
  return comments.map((c) =>
    thread.has(c.comment_id) && c.resolved !== "true"
      ? { ...c, resolved: "true" }
      : c,
  );
}

/**
 * The comment table with a task's open fail comments (change requests)
 * marked resolved, or null when it has none. An accepted pass approves the
 * resubmission those requests sent back for.
 */
export function resolveChangeRequests(
  comments: CommentRow[],
  task_id: string,
): CommentRow[] | null {
  const open = (c: CommentRow) =>
    c.task_id === task_id && c.kind === "fail" && c.resolved !== "true";
  if (!comments.some(open)) return null;
  return comments.map((c) => (open(c) ? { ...c, resolved: "true" } : c));
}

export type ResolveCommentResult =
  | { ok: true; row: CommentRow; comments: CommentRow[] }
  | { ok: false; reason: string };

/**
 * Resolving a comment (greying it out of the attention counts) is
 * owner/author-only: the comment's author or anyone with push access.
 * Resolving a comment resolves its replies with it — replies carry no resolve
 * control of their own. `comments` in the accepted result is the full updated
 * table.
 */
export function checkResolveComment({
  comments,
  comment_id,
  author,
  changedPaths,
  isCollaborator,
}: CheckResolveCommentArgs): ResolveCommentResult {
  if (!boundaryCheck(changedPaths, [COMMENT_PATH]))
    return { ok: false, reason: "out_of_bounds" };
  const row = comments.find((c) => c.comment_id === comment_id);
  if (!row) return { ok: false, reason: "unknown_comment" };
  if (row.resolved === "true") return { ok: false, reason: "already_resolved" };
  if (!isCollaborator && row.author_id !== author)
    return { ok: false, reason: "not_permitted" };
  return {
    ok: true,
    row: { ...row, resolved: "true" },
    comments: resolveCommentThread(comments, comment_id),
  };
}
