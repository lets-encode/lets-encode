import { test } from "node:test";
import assert from "node:assert/strict";

import { claimRanOut, liveLocks, reapLocks } from "../campaign-reaper.ts";
import type { LockRow } from "../campaign-tables.ts";

const NOW = "2026-06-25T12:00:00Z";
const lock = (
  task_id: string,
  expires: string,
  kind = "encoding",
): LockRow => ({
  task_id,
  subtask_id: kind === "validation" ? "S0001" : "",
  user_id: "bob",
  timestamp: "2026-06-25T08:00:00Z",
  kind,
  expires,
});

test("removes expired locks, keeps unexpired ones", () => {
  const { kept, removed } = reapLocks({
    locks: [
      lock("T0001", "2026-06-25T13:00:00Z"), // expires in 60 min
      lock("T0002", "2026-06-25T11:00:00Z"), // expired 60 min ago
    ],
    now: NOW,
  });
  assert.deepEqual(
    kept.map((l) => l.task_id),
    ["T0001"],
  );
  assert.deepEqual(
    removed.map((l) => l.task_id),
    ["T0002"],
  );
});

test("the boundary is strict: exactly at expires is kept, just after is removed", () => {
  const at = reapLocks({
    locks: [lock("T1", "2026-06-25T12:00:00Z")],
    now: NOW,
  });
  assert.equal(at.removed.length, 0);

  const over = reapLocks({
    locks: [lock("T1", "2026-06-25T11:59:00Z")],
    now: NOW,
  });
  assert.equal(over.removed.length, 1);
});

test("keeps locks when either time is unparseable or expires is empty", () => {
  const { kept, removed } = reapLocks({
    locks: [lock("T1", "not-a-date"), lock("T2", "")],
    now: NOW,
  });
  assert.equal(kept.length, 2);
  assert.equal(removed.length, 0);

  const invalidNow = reapLocks({
    locks: [lock("T1", "2026-06-25T09:00:00Z")],
    now: "not-a-date",
  });
  assert.equal(invalidNow.kept.length, 1);
  assert.equal(invalidNow.removed.length, 0);
});

test("empty lock table yields nothing to do", () => {
  assert.deepEqual(reapLocks({ locks: [], now: NOW }), {
    kept: [],
    removed: [],
  });
});

test("liveLocks keeps the locks in force at the given time", () => {
  const locks = [
    lock("T1", "2026-06-25T13:00:00Z"),
    lock("T2", "2026-06-25T11:00:00Z"),
  ];
  assert.deepEqual(
    liveLocks(locks, Date.parse(NOW)).map((l) => l.task_id),
    ["T1"],
  );
});

test("claimRanOut matches only the author's own lock on the row and kind", () => {
  const expired = [lock("T1", "2026-06-25T11:00:00Z")];
  const key = { task_id: "T1", subtask_id: "", kind: "encoding" };
  assert.equal(claimRanOut(expired, key, "bob"), true);
  assert.equal(claimRanOut(expired, key, "carol"), false);
  assert.equal(
    claimRanOut(expired, { ...key, kind: "validation" }, "bob"),
    false,
  );
});
