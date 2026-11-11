import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseCommentCsv,
  parseHistoryCsv,
  parseLockCsv,
  parseStateCsv,
  COMMENT_PATH,
  HISTORY_PATH,
  LOCK_PATH,
  STATE_PATH,
} from "../campaign-tables.ts";
import type { CommentRow, LockRow } from "../campaign-tables.ts";
import type { CommandEnvelope } from "../command-envelope.ts";
import {
  authorLabelOf,
  claimComment,
  claimCommit,
  claimedLockOf,
  coAuthored,
  commentComment,
  commentCommit,
  commentIntent,
  decideClaim,
  decideComment,
  decideReviewEdit,
  explainReason,
  historyColumns,
  isAuditFree,
  locksForDecision,
  MAX_HISTORY_INPUT,
  openCountByAuthor,
  priorVerdict,
  releaseComment,
  releaseCommit,
  reviewEditComment,
  reviewEditCommit,
  reviewEditIntent,
  tablesBusyComment,
} from "../coordinator-operations.ts";
import type { BoundPullRequest } from "../coordinator-operations.ts";

const NOW = "2026-06-25T10:00:00.000Z";
const PR: BoundPullRequest = { number: 7, author: "42", authorLogin: "bob" };
const TRAILER = "\n\nCo-authored-by: bob <42+bob@users.noreply.github.com>";
const TASK_HEADER =
  "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n";
const STATE_HEADER =
  "task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n";
const LOCK_HEADER = "task_id,subtask_id,user_id,timestamp,kind,expires\n";
const HISTORY_HEADER =
  "timestamp,task_id,subtask_id,user_id,action,outcome,detail,command,version,input,pr\n";
const COMMENT_HEADER =
  "comment_id,task_id,subtask_id,kind,page,measure_start,measure_end,author_id,timestamp,resolved,parent_id,body,fragment\n";

const TASKS =
  TASK_HEADER +
  "T0001,,sources/score.mei,,,,\n" +
  "T0001,S0001,sources/score.mei,,,,\n";
const ENCODING_STATE =
  STATE_HEADER + "T0001,,encoding_required,,,\n" + "T0001,S0001,pending,,,\n";
const REVIEW_STATE =
  STATE_HEADER +
  "T0001,,validation_required,99,2026-06-25T09:00:00Z,\n" +
  "T0001,S0001,validation_required,,,\n";

const lock = (over: Partial<LockRow> = {}): LockRow => ({
  task_id: "T0001",
  subtask_id: "",
  user_id: "42",
  timestamp: "2026-06-25T08:00:00Z",
  kind: "encoding",
  expires: "2026-06-25T12:00:00Z",
  ...over,
});
const comment = (over: Partial<CommentRow> = {}): CommentRow => ({
  comment_id: "",
  task_id: "T0001",
  subtask_id: "S0001",
  kind: "fail",
  page: "",
  measure_start: "",
  measure_end: "",
  author_id: "",
  timestamp: "",
  resolved: "",
  parent_id: "",
  body: "Slur missing.",
  fragment: "",
  ...over,
});
const fileOf = (files: { path: string; content: string }[], path: string) =>
  files.find((f) => f.path === path)?.content;
const historyOf = (files: { path: string; content: string }[]) =>
  parseHistoryCsv(fileOf(files, HISTORY_PATH) ?? "");

const ENVELOPE: CommandEnvelope = {
  command: "campaign.claim",
  version: 1,
  user_id: "42",
  timestamp: NOW,
  input: { task_id: "T0001" },
};

test("the author is named by login, else by id, and co-authors accepted commits", () => {
  assert.equal(authorLabelOf(PR), "bob");
  assert.equal(authorLabelOf({ ...PR, authorLogin: "" }), "42");
  assert.equal(coAuthored("Lock T0001", PR), `Lock T0001${TRAILER}`);
  assert.equal(
    coAuthored("Lock T0001", { ...PR, authorLogin: "" }),
    "Lock T0001",
  );
  assert.equal(coAuthored("Lock T0001", { ...PR, author: "" }), "Lock T0001");
});

test("history columns carry the envelope, without an overlong input", () => {
  assert.deepEqual(historyColumns(null), {
    command: "",
    version: "",
    input: "",
  });
  assert.deepEqual(historyColumns(ENVELOPE), {
    command: "campaign.claim",
    version: "1",
    input: '{"task_id":"T0001"}',
  });
  const long = historyColumns({
    ...ENVELOPE,
    input: { body: "x".repeat(MAX_HISTORY_INPUT) },
  });
  assert.equal(long.input, "");
  assert.equal(long.command, "campaign.claim");
});

test("only rejections of unparseable operations are audit-free", () => {
  assert.equal(isAuditFree({ ok: false, reason: "malformed_claim" }), true);
  assert.equal(isAuditFree({ ok: false, reason: "out_of_bounds" }), true);
  assert.equal(isAuditFree({ ok: false, reason: "claim_expired" }), false);
  assert.equal(isAuditFree({ ok: true }), false);
});

test("a rejection reason is explained when its code is mapped", () => {
  assert.equal(explainReason("unknown_task"), "`unknown_task` — no such task");
  assert.equal(explainReason("odd_code"), "`odd_code`");
  assert.equal(explainReason(undefined), "`rejected`");
});

test("a prior decision of the pull request is reported from history", () => {
  const history =
    HISTORY_HEADER +
    "t1,T0001,,42,claim_encoding,accepted,,,,,7\n" +
    "t2,T0002,,42,claim_encoding,rejected,already_locked,,,,8\n";
  assert.equal(priorVerdict(history, 9), null);
  assert.equal(priorVerdict(null, 7), null);
  const accepted = priorVerdict(history, 7)!;
  assert.equal(accepted.ok, true);
  assert.equal(accepted.reason, undefined);
  assert.equal(accepted.row.task_id, "T0001");
  const rejected = priorVerdict(history, 8)!;
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "already_locked");
});

test("the locks a pull request is decided against are judged at its opening", () => {
  const lockCsv =
    LOCK_HEADER +
    // Expired, and no other open pull request needs it: dropped.
    "T0002,,42,t,encoding,2026-06-25T09:00:00Z\n" +
    // Expired, but the author's open PR #8 on T0003 still needs it: kept in
    // lock.csv, expired for this pull request.
    "T0003,,42,t,encoding,2026-06-25T09:30:00Z\n" +
    "T0001,,42,t,encoding,2026-06-25T12:00:00Z\n";
  const open = [
    {
      number: 8,
      created_at: "2026-06-25T09:00:00Z",
      draft: false,
      user: { id: 42 },
      head: { ref: "encode-T0003" },
    },
    // The pull request being decided does not hold a lock for itself.
    {
      number: 7,
      created_at: "2026-06-25T09:00:00Z",
      draft: false,
      user: { id: 42 },
      head: { ref: "encode-T0002" },
    },
  ];
  const historyCsv =
    HISTORY_HEADER + "t,T0004,,42,reap,released,encoding,,,,\n";
  const result = locksForDecision({
    lockCsv,
    historyCsv,
    submittedAt: NOW,
    pr: PR,
    open,
  });
  assert.deepEqual(
    result.removed.map((l) => l.task_id),
    ["T0002"],
  );
  assert.deepEqual(
    result.locks.map((l) => l.task_id),
    ["T0003", "T0001"],
  );
  assert.deepEqual(
    result.opening.expired.map((l) => l.task_id),
    ["T0003"],
  );
  assert.deepEqual(
    result.opening.decide.map((l) => l.task_id),
    ["T0001"],
  );
  assert.deepEqual(
    result.expired.map((l) => l.task_id),
    ["T0002", "T0003", "T0004"],
  );
});

test("an accepted claim's history row gives back its lock", () => {
  const [row] = parseHistoryCsv(
    HISTORY_HEADER + "t1,T0001,S0001,42,claim_validation,accepted,,,,,7\n",
  );
  assert.deepEqual(claimedLockOf(row), {
    task_id: "T0001",
    subtask_id: "S0001",
    user_id: "42",
    timestamp: "t1",
    kind: "validation",
    expires: "",
  });
});

test("a claim is decided with the campaign's lock lifetime", () => {
  const args = {
    taskCsv: TASKS,
    stateCsv: ENCODING_STATE,
    configText: "locking:\n  stale_after_minutes: 60\n",
    locks: [],
    intent: { task_id: "T0001", subtask_id: "", kind: "encoding" },
    author: "42",
    changedPaths: [LOCK_PATH],
    now: NOW,
  };
  const accepted = decideClaim(args);
  assert.equal(accepted.ok, true);
  if (accepted.ok)
    assert.equal(accepted.lock.expires, "2026-06-25T11:00:00.000Z");
  const byDefault = decideClaim({ ...args, configText: null });
  if (byDefault.ok)
    assert.equal(byDefault.lock.expires, "2026-06-26T10:00:00.000Z");
  else assert.fail("the claim is accepted");
  assert.deepEqual(decideClaim({ ...args, intent: null }), {
    ok: false,
    reason: "malformed_claim",
  });
  assert.deepEqual(decideClaim({ ...args, locks: [lock({ user_id: "99" })] }), {
    ok: false,
    reason: "already_locked",
  });
});

test("an accepted claim commits its history row and lock", () => {
  const intent = { task_id: "T0001", subtask_id: "", kind: "encoding" };
  const newLock = lock({ timestamp: NOW });
  const commit = claimCommit({
    pr: PR,
    intent,
    verdict: { ok: true, lock: newLock },
    locks: [],
    removed: [],
    keptWork: new Set(),
    historyCsv: "",
    now: NOW,
    envelope: ENVELOPE,
  })!;
  assert.deepEqual(historyOf(commit.files), [
    {
      timestamp: NOW,
      task_id: "T0001",
      subtask_id: "",
      user_id: "42",
      action: "claim_encoding",
      outcome: "accepted",
      detail: "",
      command: "campaign.claim",
      version: "1",
      input: '{"task_id":"T0001"}',
      pr: "7",
    },
  ]);
  assert.deepEqual(parseLockCsv(fileOf(commit.files, LOCK_PATH)!), [newLock]);
  assert.equal(commit.message, `Lock T0001 for bob (encoding)${TRAILER}`);
});

test("a rejected claim commits its history row, an audit-free one only expiries", () => {
  const expired = lock({ task_id: "T0002", expires: "2026-06-25T09:00:00Z" });
  const base = {
    pr: PR,
    intent: { task_id: "T0001", subtask_id: "", kind: "encoding" },
    locks: [lock({ user_id: "99" })],
    removed: [],
    keptWork: new Set<LockRow>(),
    historyCsv: "",
    now: NOW,
    envelope: null,
  };
  const rejected = claimCommit({
    ...base,
    verdict: { ok: false, reason: "already_locked" },
  })!;
  assert.deepEqual(
    rejected.files.map((f) => f.path),
    [HISTORY_PATH],
  );
  assert.equal(historyOf(rejected.files)[0].detail, "already_locked");
  assert.equal(rejected.message, "Reject claim by bob (already_locked)");

  assert.equal(
    claimCommit({
      ...base,
      intent: null,
      verdict: { ok: false, reason: "malformed_claim" },
    }),
    null,
  );

  const withExpiry = claimCommit({
    ...base,
    intent: null,
    removed: [expired],
    keptWork: new Set([expired]),
    verdict: { ok: false, reason: "malformed_claim" },
  })!;
  const rows = historyOf(withExpiry.files);
  assert.deepEqual(
    rows.map((r) => [r.task_id, r.action, r.outcome, r.detail]),
    [["T0002", "reap", "released_with_work", "encoding"]],
  );
  assert.deepEqual(parseLockCsv(fileOf(withExpiry.files, LOCK_PATH)!), [
    lock({ user_id: "99" }),
  ]);
  assert.equal(withExpiry.message, "Reject claim by bob (malformed_claim)");
});

test("a claim's comment names the lock or the rejection", () => {
  assert.equal(
    claimComment(
      { ok: true, lock: lock({ subtask_id: "S0001", kind: "validation" }) },
      "bob",
    ),
    "✅ Claim accepted — `T0001/S0001` locked for bob (review).",
  );
  assert.equal(
    claimComment({ ok: true, lock: lock() }, "bob"),
    "✅ Claim accepted — `T0001` locked for bob (encoding).",
  );
  assert.equal(
    claimComment({ ok: false, reason: "unknown_task" }, "bob"),
    "❌ Claim rejected: `unknown_task` — no such task. No changes were made.",
  );
});

test("an accepted release removes the lock; a rejected one records only history", () => {
  const intent = { task_id: "T0001", subtask_id: "", kind: "encoding" };
  const held = lock();
  const other = lock({ task_id: "T0002" });
  const base = {
    pr: PR,
    intent,
    locks: [held, other],
    removed: [],
    keptWork: new Set<LockRow>(),
    historyCsv: "",
    now: NOW,
    envelope: null,
  };
  const accepted = releaseCommit({
    ...base,
    verdict: { ok: true, lock: held },
  });
  assert.deepEqual(parseLockCsv(fileOf(accepted.files, LOCK_PATH)!), [other]);
  assert.equal(historyOf(accepted.files)[0].action, "release_encoding");
  assert.equal(historyOf(accepted.files)[0].pr, "7");
  assert.equal(accepted.message, `Release T0001 by bob (encoding)${TRAILER}`);

  const rejected = releaseCommit({
    ...base,
    verdict: { ok: false, reason: "not_lock_holder" },
  });
  assert.deepEqual(
    rejected.files.map((f) => f.path),
    [HISTORY_PATH],
  );
  assert.equal(historyOf(rejected.files)[0].outcome, "rejected");
  assert.equal(rejected.message, "Reject release by bob (not_lock_holder)");

  const expired = lock({ task_id: "T0003" });
  const withExpiry = releaseCommit({
    ...base,
    removed: [expired],
    verdict: { ok: false, reason: "claim_expired" },
  });
  assert.deepEqual(
    historyOf(withExpiry.files).map((r) => r.action),
    ["reap", "release_encoding"],
  );
  assert.deepEqual(parseLockCsv(fileOf(withExpiry.files, LOCK_PATH)!), [
    held,
    other,
  ]);
});

test("a release's comment names the task or what the rejection left", () => {
  const intent = { task_id: "T0001", subtask_id: "", kind: "encoding" };
  assert.equal(
    releaseComment({ ok: true }, intent, "bob"),
    "✅ Release accepted — bob abandoned `T0001`.",
  );
  assert.match(
    releaseComment({ ok: false, reason: "claim_expired" }, intent, "bob"),
    /^❌ Release rejected: `claim_expired` — .* any unsubmitted work on its task branch was kept\.$/,
  );
  assert.match(
    releaseComment(
      { ok: false, reason: "claim_expired" },
      { ...intent, subtask_id: "S0001", kind: "validation" },
      "bob",
    ),
    /The claim had run out and has been released\.$/,
  );
});

const LOCK_REMOVAL = "@@ -1,2 +1 @@\n-T0001,S0001,42,t,validation,x";
const COMMENT_APPEND =
  "@@ -1 +1,2 @@\n+,T0001,S0001,fail,,,,,,,,Slur missing.,";

test("a review edit's intent is the review lock it removes and its comments", () => {
  const parsed = reviewEditIntent([
    { filename: LOCK_PATH, patch: LOCK_REMOVAL },
    { filename: COMMENT_PATH, patch: COMMENT_APPEND },
  ])!;
  assert.deepEqual(parsed.intent, { task_id: "T0001", subtask_id: "S0001" });
  assert.equal(parsed.added?.length, 1);
  assert.equal(parsed.added?.[0].body, "Slur missing.");
  assert.equal(
    reviewEditIntent([{ filename: LOCK_PATH, patch: LOCK_REMOVAL }])?.added,
    null,
  );
  assert.equal(
    reviewEditIntent([
      { filename: LOCK_PATH, patch: "@@\n-T0001,,42,t,encoding,x" },
    ]),
    null,
  );
  assert.equal(reviewEditIntent([{ filename: COMMENT_PATH }]), null);
});

test("a review edit is decided with its one fail comment", () => {
  const args = {
    stateCsv: REVIEW_STATE,
    configText: null,
    locks: [lock({ subtask_id: "S0001", kind: "validation" })],
    intent: { task_id: "T0001", subtask_id: "S0001" },
    added: [comment()],
    author: "42",
    changedPaths: [LOCK_PATH, COMMENT_PATH],
    now: NOW,
    expired: [],
  };
  const accepted = decideReviewEdit(args);
  assert.equal(accepted.ok, true);
  if (accepted.ok)
    assert.deepEqual(accepted.locks, [
      lock({ timestamp: NOW, expires: "2026-06-26T10:00:00.000Z" }),
    ]);
  assert.deepEqual(decideReviewEdit({ ...args, added: null }), {
    ok: false,
    reason: "fail_without_comment",
  });
  assert.deepEqual(
    decideReviewEdit({ ...args, added: [comment(), comment()] }),
    { ok: false, reason: "fail_without_comment" },
  );
});

test("an accepted review edit commits state, locks and the re-authored comment", () => {
  const intent = { task_id: "T0001", subtask_id: "S0001" };
  const newLock = lock({ timestamp: NOW });
  const heldExpired = lock({ task_id: "T0005" });
  const state = parseStateCsv(ENCODING_STATE);
  const base = {
    pr: PR,
    intent,
    added: [comment({ comment_id: "forged", author_id: "1", timestamp: "x" })],
    locks: [lock({ subtask_id: "S0001", kind: "validation" })],
    removed: [],
    openingExpired: [heldExpired],
    keptWork: new Set<LockRow>(),
    historyCsv: "",
    commentCsv: COMMENT_HEADER + "c1,T0001,,comment,,,,9,t,,,Earlier,\n",
    now: NOW,
    envelope: null,
    newId: "abcd1234",
  };
  const accepted = reviewEditCommit({
    ...base,
    verdict: { ok: true, state, locks: [newLock] },
  });
  assert.deepEqual(
    accepted.files.map((f) => f.path),
    [HISTORY_PATH, STATE_PATH, LOCK_PATH, COMMENT_PATH],
  );
  assert.equal(historyOf(accepted.files)[0].action, "review_edit");
  assert.equal(historyOf(accepted.files)[0].detail, "");
  assert.deepEqual(parseLockCsv(fileOf(accepted.files, LOCK_PATH)!), [
    newLock,
    heldExpired,
  ]);
  const comments = parseCommentCsv(fileOf(accepted.files, COMMENT_PATH)!);
  assert.equal(comments.length, 2);
  assert.deepEqual(comments[1], {
    ...comment(),
    comment_id: "abcd1234",
    author_id: "42",
    timestamp: NOW,
  });
  assert.equal(
    accepted.message,
    `Edit T0001 from review of T0001/S0001 by bob${TRAILER}`,
  );

  const rejected = reviewEditCommit({
    ...base,
    verdict: { ok: false, reason: "claim_expired" },
  });
  assert.deepEqual(
    rejected.files.map((f) => f.path),
    [HISTORY_PATH],
  );
  assert.equal(historyOf(rejected.files)[0].detail, "claim_expired");
  assert.equal(rejected.message, "Reject review edit by bob (claim_expired)");
  const withExpiry = reviewEditCommit({
    ...base,
    removed: [lock({ task_id: "T0009" })],
    verdict: { ok: false, reason: "claim_expired" },
  });
  assert.deepEqual(
    parseLockCsv(fileOf(withExpiry.files, LOCK_PATH)!),
    base.locks,
  );
});

test("a review edit's comment names the task or what the rejection left", () => {
  assert.equal(
    reviewEditComment({ ok: true, task: "T0001" }, "bob"),
    "✅ Review edit accepted — `T0001` is back in editing, claimed by bob.",
  );
  assert.equal(
    reviewEditComment({ ok: false, reason: "wrong_state" }, "bob"),
    "❌ Review edit rejected: `wrong_state` — the task is not in the right state for this operation. No changes were made.",
  );
});

const DISCUSSION_APPEND = "@@ -1 +1,2 @@\n+,T0001,,comment,,,,,,,,Looks good.,";
const RESOLVE =
  "@@ -2 +2 @@\n-c1,T0001,,comment,,,,9,t,,,Earlier,\n+c1,T0001,,comment,,,,9,t,true,,Earlier,";

test("a comment PR's intent is the rows it appends or the comment it resolves", () => {
  const appended = commentIntent([
    { filename: COMMENT_PATH, patch: DISCUSSION_APPEND },
  ]);
  assert.equal(appended.added?.length, 1);
  assert.equal(appended.resolved, null);
  assert.deepEqual(
    commentIntent([{ filename: COMMENT_PATH, patch: RESOLVE }]),
    { added: null, resolved: { comment_id: "c1" } },
  );
  assert.deepEqual(commentIntent([{ filename: LOCK_PATH, patch: RESOLVE }]), {
    added: null,
    resolved: null,
  });
});

test("a comment PR is decided as an append, a resolve or malformed", () => {
  const commentCsv = COMMENT_HEADER + "c1,T0001,,comment,,,,9,t,,,Earlier,\n";
  const base = {
    stateCsv: ENCODING_STATE,
    commentCsv,
    author: "42",
    changedPaths: [COMMENT_PATH],
    submittedAt: "2026-06-25T09:59:00Z",
    newId: "abcd1234",
    isCollaborator: false,
  };
  const appended = decideComment({
    ...base,
    intent: commentIntent([
      { filename: COMMENT_PATH, patch: DISCUSSION_APPEND },
    ]),
  });
  assert.equal(appended.action, "submit_comment");
  assert.equal(appended.verdict.ok, true);
  assert.equal(appended.nextComments.length, 2);
  assert.deepEqual(
    [
      appended.nextComments[1].comment_id,
      appended.nextComments[1].author_id,
      appended.nextComments[1].timestamp,
    ],
    ["abcd1234", "42", "2026-06-25T09:59:00Z"],
  );

  const resolveIntent = commentIntent([
    { filename: COMMENT_PATH, patch: RESOLVE },
  ]);
  const refused = decideComment({ ...base, intent: resolveIntent });
  assert.equal(refused.action, "resolve_comment");
  assert.deepEqual(refused.verdict, { ok: false, reason: "not_permitted" });
  assert.equal(refused.nextComments.length, 1);
  assert.equal(refused.nextComments[0].resolved, "");
  const resolved = decideComment({
    ...base,
    intent: resolveIntent,
    isCollaborator: true,
  });
  assert.equal(resolved.verdict.ok, true);
  assert.equal(resolved.nextComments[0].resolved, "true");

  const malformed = decideComment({
    ...base,
    intent: { added: null, resolved: null },
  });
  assert.equal(malformed.action, "submit_comment");
  assert.deepEqual(malformed.verdict, {
    ok: false,
    reason: "malformed_comment",
  });
});

test("a comment PR's decision commits history and the comment table", () => {
  const row = comment({
    comment_id: "abcd1234",
    subtask_id: "",
    kind: "comment",
  });
  const accepted = commentCommit({
    pr: PR,
    decision: {
      action: "submit_comment",
      verdict: { ok: true, row },
      nextComments: [row],
    },
    historyCsv: "",
    now: NOW,
    envelope: null,
  });
  assert.deepEqual(parseCommentCsv(fileOf(accepted.files, COMMENT_PATH)!), [
    row,
  ]);
  const [history] = historyOf(accepted.files);
  assert.deepEqual(
    [history.task_id, history.action, history.outcome, history.detail],
    ["T0001", "submit_comment", "accepted", "comment"],
  );
  assert.equal(
    accepted.message,
    `Record comment comment on T0001 by bob${TRAILER}`,
  );
  const campaign = commentCommit({
    pr: PR,
    decision: {
      action: "submit_comment",
      verdict: { ok: true, row: { ...row, task_id: "" } },
      nextComments: [],
    },
    historyCsv: "",
    now: NOW,
    envelope: null,
  });
  assert.equal(
    campaign.message,
    `Record comment comment on the campaign by bob${TRAILER}`,
  );
  const resolved = commentCommit({
    pr: PR,
    decision: {
      action: "resolve_comment",
      verdict: { ok: true, row },
      nextComments: [row],
    },
    historyCsv: "",
    now: NOW,
    envelope: null,
  });
  assert.equal(resolved.message, `Resolve comment abcd1234 (by bob)${TRAILER}`);

  const rejected = commentCommit({
    pr: PR,
    decision: {
      action: "submit_comment",
      verdict: { ok: false, reason: "empty_comment" },
      nextComments: [],
    },
    historyCsv: "",
    now: NOW,
    envelope: null,
  });
  assert.deepEqual(
    rejected.files.map((f) => f.path),
    [HISTORY_PATH],
  );
  const [rejectedRow] = historyOf(rejected.files);
  assert.deepEqual(
    [rejectedRow.task_id, rejectedRow.outcome, rejectedRow.detail],
    ["", "rejected", "empty_comment"],
  );
  assert.equal(rejected.message, "Reject comment by bob (empty_comment)");
});

test("a comment PR's comment and the busy-tables comment", () => {
  assert.equal(
    commentComment({ ok: true, action: "submit_comment" }),
    "✅ Comment recorded.",
  );
  assert.equal(
    commentComment({ ok: true, action: "resolve_comment" }),
    "✅ Comment resolved.",
  );
  assert.equal(
    commentComment({
      ok: false,
      reason: "empty_comment",
      action: "submit_comment",
    }),
    "❌ Comment rejected: `empty_comment` — the comment is empty. No changes were made.",
  );
  assert.match(tablesBusyComment(), /^❌ Not recorded: `tables_busy` — .*\.$/);
});

test("an author's open pull requests are counted without drafts", () => {
  const pr = (id: number, draft = false) => ({ draft, user: { id } });
  assert.equal(
    openCountByAuthor([pr(42), pr(42, true), pr(99), pr(42)], "42"),
    2,
  );
  assert.equal(openCountByAuthor([], "42"), 0);
});
