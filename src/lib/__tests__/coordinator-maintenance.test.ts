import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseHistoryCsv,
  parseLockCsv,
  parseStateCsv,
  HISTORY_PATH,
  LOCK_PATH,
  STATE_PATH,
} from "../campaign-tables.ts";
import type { LockRow } from "../campaign-tables.ts";
import {
  CATCHUP_MAX_AGE_MS,
  CATCHUP_MIN_AGE_MS,
  catchUpDue,
  expiredLocks,
  expiryRows,
  reachedReviews,
  reapAt,
  reapCommit,
  undecidedPullRequests,
  UNDECIDED_COMMENT,
} from "../coordinator-maintenance.ts";

const NOW = "2026-06-25T10:00:00.000Z";
const HISTORY_HEADER =
  "timestamp,task_id,subtask_id,user_id,action,outcome,detail,command,version,input,pr\n";
const STATE_HEADER_2 =
  "task_id,subtask_id,status,encoder,encoded_at,validate_status_1,validate_status_2\n";

const lock = (over: Partial<LockRow> = {}): LockRow => ({
  task_id: "T0001",
  subtask_id: "",
  user_id: "42",
  timestamp: "2026-06-25T08:00:00Z",
  kind: "encoding",
  expires: "2026-06-25T09:00:00Z",
  ...over,
});
const openPr = (over: {
  number: number;
  created_at?: string;
  ref?: string;
  draft?: boolean;
}) => ({
  number: over.number,
  created_at: over.created_at ?? "2026-06-25T08:30:00Z",
  draft: over.draft ?? false,
  user: { id: 42 },
  head: { ref: over.ref ?? "encode-T0001" },
});

test("expired locks are dropped unless another open pull request still needs them", () => {
  const expired = lock();
  const live = lock({ task_id: "T0002", expires: "2026-06-25T12:00:00Z" });
  assert.deepEqual(reapAt([expired, live], NOW, [], 0), {
    kept: [live],
    removed: [expired],
  });
  // The holder's PR #8 on the task, opened before the lock ran out, needs it.
  assert.deepEqual(reapAt([expired, live], NOW, [openPr({ number: 8 })], 7), {
    kept: [expired, live],
    removed: [],
  });
  // The pull request being decided does not keep a lock for itself.
  assert.deepEqual(reapAt([expired, live], NOW, [openPr({ number: 7 })], 7), {
    kept: [live],
    removed: [expired],
  });
  // A draft, or one opened after the lock ran out, does not either.
  assert.deepEqual(
    reapAt(
      [expired],
      NOW,
      [
        openPr({ number: 8, draft: true }),
        openPr({ number: 9, created_at: "2026-06-25T09:30:00Z" }),
      ],
      7,
    ).removed,
    [expired],
  );
});

test("an expired lock's history row says whether its work was kept", () => {
  const a = lock();
  const b = lock({ task_id: "T0002", subtask_id: "S0001", kind: "validation" });
  assert.deepEqual(expiryRows([a, b], NOW, new Set([a])), [
    {
      timestamp: NOW,
      task_id: "T0001",
      subtask_id: "",
      user_id: "42",
      action: "reap",
      outcome: "released_with_work",
      detail: "encoding",
    },
    {
      timestamp: NOW,
      task_id: "T0002",
      subtask_id: "S0001",
      user_id: "42",
      action: "reap",
      outcome: "released",
      detail: "validation",
    },
  ]);
  assert.deepEqual(expiryRows([], NOW, new Set()), []);
});

test("the expired locks include those other runs reaped", () => {
  const removed = [lock()];
  assert.deepEqual(expiredLocks(removed, null), removed);
  const reaped = expiredLocks(
    removed,
    HISTORY_HEADER + "t,T0003,,42,reap,released,encoding,,,,\n",
  );
  assert.deepEqual(
    reaped.map((l) => [l.task_id, l.kind]),
    [
      ["T0001", "encoding"],
      ["T0003", "encoding"],
    ],
  );
  // A claim accepted after the reap holds the lock again.
  assert.deepEqual(
    expiredLocks(
      [],
      HISTORY_HEADER +
        "t,T0003,,42,reap,released,encoding,,,,\n" +
        "t,T0003,,42,claim_encoding,accepted,,,,,9\n",
    ),
    [],
  );
});

const LOWERED_STATE =
  STATE_HEADER_2 +
  "T0001,,validation_required,99,t,,\n" +
  "T0001,S0001,validation_required,,,pass|77|t,\n";

test("reviews reaching a lowered pass threshold are completed", () => {
  assert.equal(reachedReviews(null, "pass_threshold: 1\n", []), null);
  assert.equal(reachedReviews(LOWERED_STATE, null, []), null);
  const reached = reachedReviews(LOWERED_STATE, "pass_threshold: 1\n", [])!;
  assert.deepEqual(
    reached.completed.map((r) => [r.task_id, r.subtask_id]),
    [["T0001", "S0001"]],
  );
  // A held review claim leaves the completion to its verdict.
  assert.equal(
    reachedReviews(LOWERED_STATE, "pass_threshold: 1\n", [
      lock({ subtask_id: "S0001", kind: "validation" }),
    ]),
    null,
  );
});

test("the reaper commits expiries, the kept locks and completed reviews", () => {
  const expired = lock();
  const kept = lock({ task_id: "T0002", expires: "2026-06-25T12:00:00Z" });
  const reached = reachedReviews(LOWERED_STATE, "pass_threshold: 1\n", []);
  const both = reapCommit({
    kept: [kept],
    removed: [expired],
    reached,
    keptWork: new Set(),
    historyCsv: "",
    now: NOW,
  });
  assert.deepEqual(
    both.files.map((f) => f.path),
    [HISTORY_PATH, LOCK_PATH, STATE_PATH],
  );
  assert.deepEqual(
    parseHistoryCsv(both.files[0].content).map((r) => [
      r.task_id,
      r.subtask_id,
      r.user_id,
      r.action,
      r.outcome,
      r.detail,
    ]),
    [
      ["T0001", "", "42", "reap", "released", "encoding"],
      ["T0001", "S0001", "", "complete_review", "accepted", "pass_threshold"],
    ],
  );
  assert.deepEqual(parseLockCsv(both.files[1].content), [kept]);
  assert.equal(
    parseStateCsv(both.files[2].content).rows[1].status,
    "completed",
  );
  assert.equal(
    both.message,
    "Release 1 stale lock(s): T0001; Complete 1 review(s) at the pass threshold: T0001/S0001",
  );

  const locksOnly = reapCommit({
    kept: [],
    removed: [expired, lock({ task_id: "T0004" })],
    reached: null,
    keptWork: new Set(),
    historyCsv: "",
    now: NOW,
  });
  assert.deepEqual(
    locksOnly.files.map((f) => f.path),
    [HISTORY_PATH, LOCK_PATH],
  );
  assert.equal(locksOnly.message, "Release 2 stale lock(s): T0001, T0004");

  const reviewsOnly = reapCommit({
    kept: [kept],
    removed: [],
    reached,
    keptWork: new Set(),
    historyCsv: "",
    now: NOW,
  });
  assert.deepEqual(
    reviewsOnly.files.map((f) => f.path),
    [HISTORY_PATH, STATE_PATH],
  );
  assert.equal(
    reviewsOnly.message,
    "Complete 1 review(s) at the pass threshold: T0001/S0001",
  );
});

const nowMs = Date.parse(NOW);
const aged = (
  number: number,
  ageMs: number,
  over: { draft?: boolean; type?: string } = {},
) => ({
  number,
  created_at: new Date(nowMs - ageMs).toISOString(),
  draft: over.draft ?? false,
  user: { type: over.type ?? "User" },
});

test("the catch-up pass closes the oldest and processes the due, oldest first", () => {
  const open = [
    aged(1, CATCHUP_MIN_AGE_MS - 1),
    aged(2, CATCHUP_MIN_AGE_MS),
    aged(3, CATCHUP_MAX_AGE_MS),
    aged(4, CATCHUP_MAX_AGE_MS + 1),
    aged(5, 60 * 60_000),
    aged(6, 60 * 60_000, { draft: true }),
    aged(7, 60 * 60_000, { type: "Bot" }),
    aged(8, CATCHUP_MAX_AGE_MS + 1, { draft: true }),
    aged(9, CATCHUP_MAX_AGE_MS + 1, { type: "Bot" }),
  ];
  assert.deepEqual(
    undecidedPullRequests(open, nowMs).map((pr) => pr.number),
    [4],
  );
  assert.deepEqual(
    catchUpDue(open, nowMs).map((pr) => pr.number),
    [3, 5, 2],
  );
  assert.deepEqual(catchUpDue([], nowMs), []);
});

test("an undecided pull request's comment is a rejection", () => {
  assert.match(UNDECIDED_COMMENT, /^❌ Not processed: /);
  assert.match(UNDECIDED_COMMENT, /No changes were made\. Submit it again\.$/);
});
