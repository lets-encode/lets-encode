// Stale-lock reaper. Pure: given the current locks, split them into those
// still fresh and those past their `expires` time, so abandoned claims free
// up. `now` and each lock `expires` are ISO-8601 strings; the comparison uses
// real time, so it does not depend on how frequently or punctually the reaper
// runs. See DESIGN.md §5.

import type { HistoryRow, LockRow } from "./campaign-tables.ts";

export interface ReapLocksArgs {
  locks: LockRow[];
  now: string;
}

export interface ReapLocksResult {
  kept: LockRow[];
  removed: LockRow[];
}

export function reapLocks({ locks, now }: ReapLocksArgs): ReapLocksResult {
  const nowMs = Date.parse(now);
  const kept: LockRow[] = [];
  const removed: LockRow[] = [];
  for (const lock of locks) {
    const expiresMs = Date.parse(lock.expires);
    // A lock with an unparseable `expires` is stale; with an unparseable
    // `now`, none is.
    const stale =
      Number.isFinite(nowMs) &&
      !(Number.isFinite(expiresMs) && nowMs <= expiresMs);
    (stale ? removed : kept).push(lock);
  }
  return { kept, removed };
}

/** The locks still in force at `now` (epoch milliseconds). */
export const liveLocks = (locks: LockRow[], now = Date.now()): LockRow[] =>
  reapLocks({ locks, now: new Date(now).toISOString() }).kept;

/**
 * Whether `expired` holds the author's lock on the row and kind: the author
 * held the claim and it ran out, as opposed to never having held it.
 */
export const claimRanOut = (
  expired: LockRow[],
  key: { task_id: string; subtask_id: string; kind: string },
  author: string,
): boolean =>
  expired.some(
    (l) =>
      l.task_id === key.task_id &&
      l.subtask_id === key.subtask_id &&
      l.kind === key.kind &&
      l.user_id === author,
  );

/**
 * The locks earlier runs reaped, read from history.csv: per holder, row and
 * kind, a `reap` row with no accepted claim by that holder after it. A run
 * that judges a pull request at its opening time no longer finds these in
 * lock.csv when another run reaped them first.
 */
export function reapedLocks(history: HistoryRow[]): LockRow[] {
  const reaped = new Map<string, LockRow>();
  for (const row of history) {
    const kind =
      row.action === "reap"
        ? row.detail
        : row.outcome === "accepted" && row.action.startsWith("claim_")
          ? row.action.slice("claim_".length)
          : null;
    if (kind === null) continue;
    const key = [row.task_id, row.subtask_id, row.user_id, kind].join("\0");
    if (row.action === "reap")
      reaped.set(key, {
        task_id: row.task_id,
        subtask_id: row.subtask_id,
        user_id: row.user_id,
        timestamp: row.timestamp,
        kind,
        expires: "",
      });
    else reaped.delete(key);
  }
  return [...reaped.values()];
}
