// The decisions of the coordinator's pull request operations over values the
// run has already read — claims, releases, review edits and comments, and
// what every operation shares: the verdict, the tables to commit with its
// message, the history row and the verdict comment. Submissions are decided
// in coordinator-submission.ts. scripts/coordinator.ts does the GitHub reads
// and writes around them.

import {
  appendHistory,
  configFlag,
  configNumber,
  DEFAULT_MAX_CLAIMS,
  DEFAULT_STALE_MINUTES,
  parseCommentCsv,
  parseHistoryCsv,
  parseLockCsv,
  parseStateCsv,
  parseTaskCsv,
  passThresholdOf,
  serializeCommentCsv,
  serializeLockCsv,
  serializeStateCsv,
  COMMENT_PATH,
  HISTORY_PATH,
  LOCK_PATH,
  STATE_PATH,
} from "./campaign-tables.ts";
import type { CommentRow, HistoryRow, LockRow } from "./campaign-tables.ts";
import { envelopeColumns } from "./command-envelope.ts";
import type { CommandEnvelope } from "./command-envelope.ts";
import { checkClaim } from "./campaign-claim.ts";
import type { ClaimIntent, ClaimResult } from "./campaign-claim.ts";
import {
  checkComment,
  checkResolveComment,
  checkReviewEdit,
} from "./campaign-submit.ts";
import {
  appendedCommentsFromPatch,
  lockIntentFromRow,
  locksAtOpening,
  priorDecision,
  REASON_TEXT,
  rejectionOutcome,
  removedRowFromPatch,
  resolvedCommentFromPatch,
} from "./coordinator-policy.ts";
import type { PendingOperation } from "./coordinator-policy.ts";
import { expiredLocks, expiryRows, reapAt } from "./coordinator-maintenance.ts";

/** The pull request a decision is for, as the coordinator run binds it. */
export interface BoundPullRequest {
  number: number;
  /** The author's numeric account id. */
  author: string;
  /** The author's login; empty when unknown. */
  authorLogin: string;
}

/** A file a decision commits. */
export interface TableFile {
  path: string;
  content: string;
}

/** The files a decision commits and the commit's message. */
export interface TableCommit {
  files: TableFile[];
  message: string;
}

/** A changed file of a pull request, as the decisions read it. */
export interface ChangedFile {
  filename: string;
  patch?: string;
}

// A rejection's `reason` is the machine-readable code recorded in the history
// table; `detail` is the human explanation behind it, for the PR comment only.
export type Verdict = { ok: boolean; reason?: string; detail?: string };

/** The author as commit messages and verdict comments name them. */
export const authorLabelOf = (pr: BoundPullRequest): string =>
  pr.authorLogin || pr.author;

/**
 * `message` with a Co-authored-by trailer for the pull request's author, so
 * GitHub attributes the automation's commit to them. The noreply address
 * needs both id and login.
 */
export function coAuthored(message: string, pr: BoundPullRequest): string {
  if (!pr.author || !pr.authorLogin) return message;
  return `${message}\n\nCo-authored-by: ${pr.authorLogin} <${pr.author}+${pr.authorLogin}@users.noreply.github.com>`;
}

// The envelope input recorded on a history row, as JSON, at most this many
// characters; a longer input is left out. The input comes from the PR body,
// and every history row is read by each later run and by the app.
export const MAX_HISTORY_INPUT = 4096;

/** The command columns of a history row for `envelope`. */
export const historyColumns = (
  envelope: CommandEnvelope | null,
): ReturnType<typeof envelopeColumns> => {
  const columns = envelopeColumns(envelope);
  return columns.input.length > MAX_HISTORY_INPUT
    ? { ...columns, input: "" }
    : columns;
};

// Rejections of pull requests that do not parse as any operation. They leave
// no history row: the closed pull request and its comment are the record, and
// the tables are not committed to for them. Every rejection of a well-formed
// operation (a lost race, a failed machine-check, a wrong state) is appended
// to history.csv.
export const AUDIT_FREE_REJECTS = new Set([
  "malformed_claim",
  "malformed_review_edit",
  "malformed_validation",
  "malformed_comment",
  "out_of_bounds",
  "unknown_task",
  "invalid_kind",
  "invalid_target",
]);
export const isAuditFree = (verdict: {
  ok: boolean;
  reason?: string;
}): boolean => !verdict.ok && AUDIT_FREE_REJECTS.has(verdict.reason ?? "");

/** "`code` — explanation" for a rejection comment; just the code when unmapped. */
export const explainReason = (reason: string | undefined): string => {
  const code = reason ?? "rejected";
  const text = REASON_TEXT[code];
  return text ? `\`${code}\` — ${text}` : `\`${code}\``;
};

/**
 * The decision history.csv already records for pull request `prNumber`, or
 * null. A run that finds one reports that decision and commits nothing, so a
 * pull request processed by two runs, or reopened after its decision, is
 * decided once.
 */
export function priorVerdict(
  historyCsv: string | null,
  prNumber: number,
): (Verdict & { row: HistoryRow }) | null {
  const row = priorDecision(parseHistoryCsv(historyCsv ?? ""), prNumber);
  if (!row) return null;
  const ok = row.outcome === "accepted";
  return { ok, reason: ok ? undefined : row.detail, row };
}

/** The `task/subtask` a lock or intent names; just the task without a subtask. */
const targetOf = (row: { task_id: string; subtask_id: string }): string =>
  `${row.task_id}${row.subtask_id && "/" + row.subtask_id}`;

/**
 * The locks a pull request opened at `submittedAt` is decided against: the
 * locks lock.csv keeps at that time (`locks`) and those it drops as expired
 * (`removed`, reapAt), the split of `locks` for the author (`opening`,
 * locksAtOpening), and every lock the decision counts as expired (`expired`,
 * expiredLocks).
 */
export function locksForDecision({
  lockCsv,
  historyCsv,
  submittedAt,
  pr,
  open,
}: {
  lockCsv: string | null;
  historyCsv: string | null;
  submittedAt: string;
  pr: BoundPullRequest;
  /** The campaign's open pull requests as the run last listed them. */
  open: PendingOperation[];
}): {
  locks: LockRow[];
  removed: LockRow[];
  opening: { decide: LockRow[]; expired: LockRow[] };
  expired: LockRow[];
} {
  const { kept: locks, removed } = reapAt(
    parseLockCsv(lockCsv ?? ""),
    submittedAt,
    open,
    pr.number,
  );
  const opening = locksAtOpening(locks, pr.author, submittedAt);
  return {
    locks,
    removed,
    opening,
    expired: expiredLocks([...removed, ...opening.expired], historyCsv),
  };
}

// ---------------------------------------------------------------------------
// Claim (a PR adding one row to lock.csv)

/** The lock an accepted claim's history row recorded. */
export const claimedLockOf = (row: HistoryRow): LockRow => ({
  task_id: row.task_id,
  subtask_id: row.subtask_id,
  user_id: row.user_id,
  timestamp: row.timestamp,
  kind: row.action.replace(/^claim_/, ""),
  expires: "",
});

/** The verdict on a claim of `intent` (null: the PR adds no lock row). */
export function decideClaim({
  taskCsv,
  stateCsv,
  configText,
  locks,
  intent,
  author,
  changedPaths,
  now,
}: {
  taskCsv: string | null;
  stateCsv: string | null;
  configText: string | null;
  locks: LockRow[];
  intent: ClaimIntent | null;
  author: string;
  changedPaths: string[];
  now: string;
}): ClaimResult {
  const claimState = parseStateCsv(stateCsv ?? "");
  return intent
    ? checkClaim({
        tasks: parseTaskCsv(taskCsv ?? ""),
        state: claimState,
        locks,
        intent,
        author,
        changedPaths,
        now,
        staleAfterMinutes: configNumber(
          configText,
          "stale_after_minutes",
          DEFAULT_STALE_MINUTES,
        ),
        allowSelfValidation: configFlag(configText, "allow_self_validation"),
        passThreshold: passThresholdOf(
          configText,
          claimState.validationColumns.length,
        ),
        maxClaims: configNumber(
          configText,
          "max_claims_per_person",
          DEFAULT_MAX_CLAIMS,
        ),
      })
    : { ok: false, reason: "malformed_claim" };
}

/**
 * What a claim's decision commits: the history rows and the lock table; null
 * for an audit-free rejection when no lock expired.
 */
export function claimCommit({
  pr,
  intent,
  verdict,
  locks,
  removed,
  keptWork,
  historyCsv,
  now,
  envelope,
}: {
  pr: BoundPullRequest;
  intent: ClaimIntent | null;
  verdict: ClaimResult;
  /** The locks lock.csv keeps. */
  locks: LockRow[];
  /** The locks dropped as expired. */
  removed: LockRow[];
  /** The expired locks whose unsubmitted work was kept. */
  keptWork: Set<LockRow>;
  historyCsv: string | null;
  now: string;
  envelope: CommandEnvelope | null;
}): TableCommit | null {
  const reapedHistory = expiryRows(removed, now, keptWork);
  const history: HistoryRow = {
    timestamp: now,
    task_id: intent?.task_id ?? "",
    subtask_id: intent?.subtask_id ?? "",
    user_id: pr.author,
    action: `claim_${intent?.kind || "unknown"}`,
    outcome: verdict.ok ? "accepted" : "rejected",
    detail: verdict.ok ? "" : verdict.reason!,
    ...historyColumns(envelope),
    pr: String(pr.number),
  };
  const auditFree = isAuditFree(verdict);
  if (auditFree && removed.length === 0) return null;
  const files: TableFile[] = [
    {
      path: HISTORY_PATH,
      content: appendHistory(
        historyCsv ?? "",
        auditFree ? reapedHistory : [...reapedHistory, history],
      ),
    },
  ];
  if (verdict.ok || removed.length) {
    files.push({
      path: LOCK_PATH,
      content: serializeLockCsv(verdict.ok ? [...locks, verdict.lock!] : locks),
    });
  }
  const authorLabel = authorLabelOf(pr);
  const message = verdict.ok
    ? coAuthored(
        `Lock ${verdict.lock!.task_id}${verdict.lock!.subtask_id && "/" + verdict.lock!.subtask_id} for ${authorLabel} (${verdict.lock!.kind})`,
        pr,
      )
    : `Reject claim by ${authorLabel} (${verdict.reason})`;
  return { files, message };
}

/** The comment that closes a claim's pull request. */
export function claimComment(
  verdict: Verdict & { lock?: LockRow },
  authorLabel: string,
): string {
  const target = verdict.lock ? `\`${targetOf(verdict.lock)}\`` : "";
  return verdict.ok
    ? `✅ Claim accepted — ${target} locked for ${authorLabel} (${verdict.lock!.kind === "validation" ? "review" : verdict.lock!.kind}).`
    : `❌ Claim rejected: ${explainReason(verdict.reason)}. No changes were made.`;
}

// ---------------------------------------------------------------------------
// Release (a PR removing one row from lock.csv: the author abandons a claim)

/** What an accepted or non-audit-free rejected release commits. */
export function releaseCommit({
  pr,
  intent,
  verdict,
  locks,
  removed,
  keptWork,
  historyCsv,
  now,
  envelope,
}: {
  pr: BoundPullRequest;
  intent: ClaimIntent;
  verdict: ClaimResult;
  locks: LockRow[];
  removed: LockRow[];
  keptWork: Set<LockRow>;
  historyCsv: string | null;
  now: string;
  envelope: CommandEnvelope | null;
}): TableCommit {
  const history: HistoryRow = {
    timestamp: now,
    task_id: intent.task_id,
    subtask_id: intent.subtask_id,
    user_id: pr.author,
    action: `release_${intent.kind}`,
    outcome: verdict.ok ? "accepted" : "rejected",
    detail: verdict.ok ? "" : verdict.reason!,
    ...historyColumns(envelope),
    pr: String(pr.number),
  };
  const files: TableFile[] = [
    {
      path: HISTORY_PATH,
      content: appendHistory(historyCsv ?? "", [
        ...expiryRows(removed, now, keptWork),
        history,
      ]),
    },
  ];
  if (verdict.ok || removed.length) {
    files.push({
      path: LOCK_PATH,
      content: serializeLockCsv(
        verdict.ok ? locks.filter((l) => l !== verdict.lock) : locks,
      ),
    });
  }
  const authorLabel = authorLabelOf(pr);
  const message = verdict.ok
    ? coAuthored(
        `Release ${targetOf(intent)} by ${authorLabel} (${intent.kind})`,
        pr,
      )
    : `Reject release by ${authorLabel} (${verdict.reason})`;
  return { files, message };
}

/** The comment that closes a release's pull request. */
export function releaseComment(
  verdict: Verdict,
  intent: ClaimIntent,
  authorLabel: string,
): string {
  return verdict.ok
    ? `✅ Release accepted — ${authorLabel} abandoned \`${targetOf(intent)}\`.`
    : `❌ Release rejected: ${explainReason(verdict.reason)}. ${rejectionOutcome(verdict.reason, intent.subtask_id === "")}`;
}

// ---------------------------------------------------------------------------
// Review edit (a PR removing the author's review lock from lock.csv and
// appending one fail comment: the reviewer switches to editing the task)

/**
 * The intent of a review edit, read from its own patches: the review lock it
 * removes and the comment rows it appends; null when it removes no single
 * review lock.
 */
export function reviewEditIntent(prFiles: ChangedFile[]): {
  intent: { task_id: string; subtask_id: string };
  added: CommentRow[] | null;
} | null {
  const removedRow = removedRowFromPatch(
    prFiles.find((f) => f.filename === LOCK_PATH)?.patch,
  );
  const { kind, ...intent } = lockIntentFromRow(removedRow ?? "");
  if (!removedRow || kind !== "validation" || !intent.subtask_id) return null;
  const added = appendedCommentsFromPatch(
    prFiles.find((f) => f.filename === COMMENT_PATH)?.patch,
  );
  return { intent, added };
}

/** The verdict on a review edit, judged against `locks`. */
export function decideReviewEdit({
  stateCsv,
  configText,
  locks,
  intent,
  added,
  author,
  changedPaths,
  now,
  expired,
}: {
  stateCsv: string | null;
  configText: string | null;
  locks: LockRow[];
  intent: { task_id: string; subtask_id: string };
  added: CommentRow[] | null;
  author: string;
  changedPaths: string[];
  now: string;
  expired: LockRow[];
}): ReturnType<typeof checkReviewEdit> {
  return checkReviewEdit({
    state: parseStateCsv(stateCsv ?? ""),
    locks,
    intent,
    author,
    changedPaths,
    failComment: added?.length === 1 ? added[0] : null,
    now,
    staleAfterMinutes: configNumber(
      configText,
      "stale_after_minutes",
      DEFAULT_STALE_MINUTES,
    ),
    expired,
  });
}

/** What a review edit's decision commits. `newId` names the fail comment. */
export function reviewEditCommit({
  pr,
  intent,
  added,
  verdict,
  locks,
  removed,
  openingExpired,
  keptWork,
  historyCsv,
  commentCsv,
  now,
  envelope,
  newId,
}: {
  pr: BoundPullRequest;
  intent: { task_id: string; subtask_id: string };
  added: CommentRow[] | null;
  verdict: ReturnType<typeof checkReviewEdit>;
  locks: LockRow[];
  removed: LockRow[];
  /** The author's locks kept in lock.csv but expired at the PR's opening. */
  openingExpired: LockRow[];
  keptWork: Set<LockRow>;
  historyCsv: string | null;
  commentCsv: string | null;
  now: string;
  envelope: CommandEnvelope | null;
  newId: string;
}): TableCommit {
  const history: HistoryRow = {
    timestamp: now,
    task_id: intent.task_id,
    subtask_id: intent.subtask_id,
    user_id: pr.author,
    action: "review_edit",
    outcome: verdict.ok ? "accepted" : "rejected",
    detail: verdict.ok ? "" : verdict.reason,
    ...historyColumns(envelope),
    pr: String(pr.number),
  };
  const files: TableFile[] = [
    {
      path: HISTORY_PATH,
      content: appendHistory(historyCsv ?? "", [
        ...expiryRows(removed, now, keptWork),
        history,
      ]),
    },
  ];
  if (verdict.ok) {
    // The fail comment carries the edit's own timestamp, as a fail verdict's
    // comment does.
    files.push(
      { path: STATE_PATH, content: serializeStateCsv(verdict.state) },
      {
        path: LOCK_PATH,
        content: serializeLockCsv([...verdict.locks, ...openingExpired]),
      },
      {
        path: COMMENT_PATH,
        content: serializeCommentCsv([
          ...parseCommentCsv(commentCsv ?? ""),
          {
            ...added![0],
            comment_id: newId,
            author_id: pr.author,
            timestamp: now,
            resolved: "",
            parent_id: "",
          },
        ]),
      },
    );
  } else if (removed.length) {
    files.push({ path: LOCK_PATH, content: serializeLockCsv(locks) });
  }
  const authorLabel = authorLabelOf(pr);
  const target = `${intent.task_id}/${intent.subtask_id}`;
  const message = verdict.ok
    ? coAuthored(
        `Edit ${intent.task_id} from review of ${target} by ${authorLabel}`,
        pr,
      )
    : `Reject review edit by ${authorLabel} (${verdict.reason})`;
  return { files, message };
}

/** The comment that closes a review edit's pull request. */
export function reviewEditComment(
  verdict: Verdict & { task?: string },
  authorLabel: string,
): string {
  return verdict.ok
    ? `✅ Review edit accepted — \`${verdict.task}\` is back in editing, claimed by ${authorLabel}.`
    : `❌ Review edit rejected: ${explainReason(verdict.reason)}. ${rejectionOutcome(verdict.reason, false)}`;
}

// ---------------------------------------------------------------------------
// Comment (a PR appending one discussion row to comment.csv, or resolving one)

/**
 * The intent of a comment PR, from its own patch (merge-base relative): the
 * rows it appends, or else the comment it resolves.
 */
export function commentIntent(prFiles: ChangedFile[]): {
  added: CommentRow[] | null;
  resolved: { comment_id: string } | null;
} {
  const commentPatch = prFiles.find((f) => f.filename === COMMENT_PATH)?.patch;
  const added = appendedCommentsFromPatch(commentPatch);
  const resolved = added ? null : resolvedCommentFromPatch(commentPatch);
  return { added, resolved };
}

/**
 * The decision on a comment PR, re-applied to the freshly read comment table:
 * its action, verdict, and the comment table it makes. An appended comment
 * gets `newId` and is stamped `submittedAt`; resolving someone else's comment
 * needs push access (`isCollaborator`).
 */
export function decideComment({
  stateCsv,
  commentCsv,
  intent,
  author,
  changedPaths,
  submittedAt,
  newId,
  isCollaborator,
}: {
  stateCsv: string | null;
  commentCsv: string | null;
  intent: ReturnType<typeof commentIntent>;
  author: string;
  changedPaths: string[];
  submittedAt: string;
  newId: string;
  isCollaborator: boolean;
}): {
  action: string;
  verdict: { ok: true; row: CommentRow } | { ok: false; reason: string };
  nextComments: CommentRow[];
} {
  const state = parseStateCsv(stateCsv ?? "");
  const comments = parseCommentCsv(commentCsv ?? "");
  const { added, resolved } = intent;
  let action = "submit_comment";
  let verdict: { ok: true; row: CommentRow } | { ok: false; reason: string };
  let nextComments = comments;
  if (added) {
    const check = checkComment({
      state,
      comments,
      added: added.length === 1 ? added[0] : null,
      author,
      changedPaths,
      now: submittedAt,
      newId,
    });
    verdict = check;
    if (check.ok) nextComments = [...comments, check.row];
  } else if (resolved) {
    action = "resolve_comment";
    const check = checkResolveComment({
      comments,
      comment_id: resolved.comment_id,
      author,
      changedPaths,
      isCollaborator,
    });
    verdict = check;
    if (check.ok) nextComments = check.comments;
  } else {
    verdict = { ok: false, reason: "malformed_comment" };
  }
  return { action, verdict, nextComments };
}

/** What a comment PR's decision commits, other than an audit-free rejection. */
export function commentCommit({
  pr,
  decision,
  historyCsv,
  now,
  envelope,
}: {
  pr: BoundPullRequest;
  decision: ReturnType<typeof decideComment>;
  historyCsv: string | null;
  now: string;
  envelope: CommandEnvelope | null;
}): TableCommit {
  const { action, verdict, nextComments } = decision;
  const row = verdict.ok ? verdict.row : null;
  const history: HistoryRow = {
    timestamp: now,
    task_id: row?.task_id ?? "",
    subtask_id: row?.subtask_id ?? "",
    user_id: pr.author,
    action,
    outcome: verdict.ok ? "accepted" : "rejected",
    detail: verdict.ok ? row!.kind : verdict.reason,
    ...historyColumns(envelope),
    pr: String(pr.number),
  };
  const files: TableFile[] = [
    { path: HISTORY_PATH, content: appendHistory(historyCsv ?? "", [history]) },
  ];
  if (verdict.ok)
    files.push({
      path: COMMENT_PATH,
      content: serializeCommentCsv(nextComments),
    });
  const authorLabel = authorLabelOf(pr);
  const message = verdict.ok
    ? coAuthored(
        action === "resolve_comment"
          ? `Resolve comment ${row!.comment_id} (by ${authorLabel})`
          : `Record ${row!.kind} comment on ${row!.task_id || "the campaign"} by ${authorLabel}`,
        pr,
      )
    : `Reject comment by ${authorLabel} (${verdict.reason})`;
  return { files, message };
}

/** The comment that closes a comment PR. */
export function commentComment(verdict: Verdict & { action: string }): string {
  return verdict.ok
    ? verdict.action === "resolve_comment"
      ? "✅ Comment resolved."
      : "✅ Comment recorded."
    : `❌ Comment rejected: ${explainReason(verdict.reason)}. No changes were made.`;
}

/** The comment that closes a pull request whose every attempt lost the commit. */
export const tablesBusyComment = (): string =>
  `❌ Not recorded: ${explainReason("tables_busy")}.`;

/**
 * How many open pull requests in `open` are non-drafts by `author`, the
 * count MAX_OPEN_PRS_PER_AUTHOR caps.
 */
export const openCountByAuthor = (
  open: { draft: boolean; user: { id: number } }[],
  author: string,
): number =>
  open.filter((pr) => !pr.draft && String(pr.user.id) === author).length;
