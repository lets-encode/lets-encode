// Stale-lock reaper. Pure: given the current locks, split them into those
// still fresh and those past their `expires` time, so abandoned claims free
// up. `now` and each lock `expires` are ISO-8601 strings; the comparison uses
// real time, so it does not depend on how frequently or punctually the reaper
// runs. See DESIGN.md §5.

import type { LockRow } from "./campaign-tables.ts";

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
    // A lock is stale only if we can read both times and it has expired;
    // anything with an unparseable `expires` is kept (don't free what we
    // can't reason about).
    const stale =
      Number.isFinite(expiresMs) && Number.isFinite(nowMs) && nowMs > expiresMs;
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
