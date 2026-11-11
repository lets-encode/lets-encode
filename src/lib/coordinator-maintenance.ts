// The decisions of the coordinator's lock expiry and scheduled maintenance
// over values the run has already read: which locks expire, the history rows
// and table commit of the reaper, and which open pull requests the catch-up
// pass closes or processes. scripts/coordinator.ts does the GitHub reads and
// writes around them.

import {
  appendHistory,
  parseHistoryCsv,
  parseStateCsv,
  passThresholdOf,
  serializeLockCsv,
  serializeStateCsv,
  HISTORY_PATH,
  LOCK_PATH,
  STATE_PATH,
} from "./campaign-tables.ts";
import type { HistoryRow, LockRow } from "./campaign-tables.ts";
import { reapedLocks, reapLocks } from "./campaign-reaper.ts";
import type { ReapLocksResult } from "./campaign-reaper.ts";
import { completeReachedReviews } from "./campaign-submit.ts";
import { heldByOpenOperation } from "./coordinator-policy.ts";
import type { PendingOperation } from "./coordinator-policy.ts";

// The scheduled catch-up pass picks up open pull requests older than the
// minimum age — a run of their own may still be under way before that — and
// younger than the maximum, processing at most CATCHUP_MAX_PRS campaign pull
// requests per pass.
export const CATCHUP_MIN_AGE_MS = 3 * 60_000;
export const CATCHUP_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const CATCHUP_MAX_PRS = 20;

/**
 * Split `locks` into those in force at `now` and those dropped as expired. A
 * lock past its `expires` stays while another open pull request in `open` of
 * its holder still needs it (heldByOpenOperation): that pull request's run
 * judges it at its opening time. Pull request `prNumber`, the one being
 * decided, is decided against locksAtOpening, where such a lock of its author
 * counts as expired.
 */
export function reapAt(
  locks: LockRow[],
  now: string,
  open: PendingOperation[],
  prNumber: number,
): ReapLocksResult {
  const { removed } = reapLocks({ locks, now });
  const nowMs = Date.parse(now);
  const dropped = removed.filter(
    (lock) =>
      !heldByOpenOperation(
        lock,
        open.filter((pr) => pr.number !== prNumber),
        nowMs,
        CATCHUP_MAX_AGE_MS,
      ),
  );
  return {
    kept: locks.filter((lock) => !dropped.includes(lock)),
    removed: dropped,
  };
}

/**
 * The history rows for locks dropped as expired, stamped with the run's time;
 * `keptWork` holds the locks whose unsubmitted work was kept.
 */
export const expiryRows = (
  removed: LockRow[],
  now: string,
  keptWork: Set<LockRow>,
): HistoryRow[] =>
  removed.map((lock) => ({
    timestamp: now,
    task_id: lock.task_id,
    subtask_id: lock.subtask_id,
    user_id: lock.user_id,
    action: "reap",
    outcome: keptWork.has(lock) ? "released_with_work" : "released",
    detail: lock.kind,
  }));

/**
 * The locks a decision judged at the pull request's opening time counts as
 * expired: those past their `expires` at that time (`removed`), and those
 * another run reaped at its own, later time.
 */
export const expiredLocks = (
  removed: LockRow[],
  historyCsv: string | null,
): LockRow[] => [...removed, ...reapedLocks(parseHistoryCsv(historyCsv ?? ""))];

/**
 * The reviews whose passes reach a pass threshold lowered since they were
 * recorded, completed (completeReachedReviews against the `kept` locks);
 * nothing else can complete them. Null without a state table or such reviews.
 */
export function reachedReviews(
  stateCsv: string | null,
  configText: string | null,
  kept: LockRow[],
): ReturnType<typeof completeReachedReviews> {
  const state = stateCsv == null ? null : parseStateCsv(stateCsv);
  return (
    state &&
    completeReachedReviews(
      state,
      kept,
      passThresholdOf(configText, state.validationColumns.length),
    )
  );
}

/**
 * What the reaper commits: the history rows of the expired locks and the
 * completed reviews, the lock table when locks expired, and the state table
 * when reviews were completed.
 */
export function reapCommit({
  kept,
  removed,
  reached,
  keptWork,
  historyCsv,
  now,
}: {
  kept: LockRow[];
  removed: LockRow[];
  reached: ReturnType<typeof completeReachedReviews>;
  keptWork: Set<LockRow>;
  historyCsv: string | null;
  now: string;
}): { files: { path: string; content: string }[]; message: string } {
  const history = [
    ...expiryRows(removed, now, keptWork),
    ...(reached?.completed ?? []).map(
      (row): HistoryRow => ({
        timestamp: now,
        task_id: row.task_id,
        subtask_id: row.subtask_id,
        user_id: "",
        action: "complete_review",
        outcome: "accepted",
        detail: "pass_threshold",
      }),
    ),
  ];
  const files = [
    { path: HISTORY_PATH, content: appendHistory(historyCsv ?? "", history) },
  ];
  if (removed.length)
    files.push({ path: LOCK_PATH, content: serializeLockCsv(kept) });
  if (reached)
    files.push({ path: STATE_PATH, content: serializeStateCsv(reached.state) });
  const message = [
    removed.length
      ? `Release ${removed.length} stale lock(s): ${removed.map((l) => l.task_id).join(", ")}`
      : "",
    reached
      ? `Complete ${reached.completed.length} review(s) at the pass threshold: ${reached.completed.map((r) => `${r.task_id}/${r.subtask_id}`).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("; ");
  return { files, message };
}

/** An open pull request as the catch-up pass selects it. */
export interface CatchUpCandidate {
  created_at: string;
  draft: boolean;
  user: { type: string };
}

/**
 * The pull requests in `open` older than CATCHUP_MAX_AGE_MS at `now`, which
 * are no longer decided; drafts and pull requests from non-user accounts are
 * left alone.
 */
export const undecidedPullRequests = <T extends CatchUpCandidate>(
  open: T[],
  now: number,
): T[] =>
  open.filter(
    (pr) =>
      !pr.draft &&
      pr.user.type === "User" &&
      now - Date.parse(pr.created_at) > CATCHUP_MAX_AGE_MS,
  );

/**
 * The pull requests in `open` the catch-up pass processes at `now`, oldest
 * first: aged between CATCHUP_MIN_AGE_MS and CATCHUP_MAX_AGE_MS; drafts and
 * pull requests from non-user accounts are left alone.
 */
export const catchUpDue = <T extends CatchUpCandidate>(
  open: T[],
  now: number,
): T[] =>
  open
    .filter((pr) => {
      const age = now - Date.parse(pr.created_at);
      return (
        !pr.draft &&
        pr.user.type === "User" &&
        age >= CATCHUP_MIN_AGE_MS &&
        age <= CATCHUP_MAX_AGE_MS
      );
    })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

/** The comment that closes a campaign operation older than CATCHUP_MAX_AGE_MS. */
export const UNDECIDED_COMMENT =
  "❌ Not processed: this pull request was not decided within seven days of being opened. No changes were made. Submit it again.";
