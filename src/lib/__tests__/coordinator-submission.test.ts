import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseCommentCsv,
  parseHistoryCsv,
  parseLockCsv,
  parseStateCsv,
  parseTaskCsv,
  serializeStateCsv,
  COMMENT_PATH,
  HISTORY_PATH,
  LOCK_PATH,
  STATE_PATH,
  TASK_PATH,
} from "../campaign-tables.ts";
import type { CommentRow, HistoryRow, LockRow } from "../campaign-tables.ts";
import { buildFacsimileMei, initialFacsimileModel } from "../mei-facsimile.ts";
import { buildPieceHead, emptySourceMetadata } from "../source-metadata.ts";
import {
  acceptedEncoding,
  assembleEncoding,
  decideValidation,
  encodingContributions,
  encodingInputGap,
  encodingPrecheck,
  encodingVerdict,
  submitComment,
  submitCommit,
  submittedSideFiles,
  validationIntent,
} from "../coordinator-submission.ts";
import type { ValidationIntent } from "../coordinator-submission.ts";
import type { BoundPullRequest } from "../coordinator-operations.ts";

const NOW = "2026-06-25T10:00:00.000Z";
const PR: BoundPullRequest = { number: 7, author: "42", authorLogin: "bob" };
const TRAILER = "\n\nCo-authored-by: bob <42+bob@users.noreply.github.com>";
const TASK_HEADER =
  "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n";
const STATE_HEADER =
  "task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n";
const COMMENT_HEADER =
  "comment_id,task_id,subtask_id,kind,page,measure_start,measure_end,author_id,timestamp,resolved,parent_id,body,fragment\n";

const TASKS = parseTaskCsv(
  TASK_HEADER +
    "T0001,,sources/score.mei,,,,\n" +
    "T0001,S0001,sources/score.mei,,,,\n" +
    "P0001,,sources/piece/score.mei,omr-layout,,,\n",
);
const encodingState = () =>
  parseStateCsv(
    STATE_HEADER +
      "T0001,,encoding_required,,,\n" +
      "T0001,S0001,pending,,,\n" +
      "P0001,,encoding_required,,,\n",
  );
const reviewState = () =>
  parseStateCsv(
    STATE_HEADER +
      "T0001,,validation_required,99,2026-06-25T09:00:00Z,\n" +
      "T0001,S0001,validation_required,,,\n",
  );

const lock = (over: Partial<LockRow> = {}): LockRow => ({
  task_id: "T0001",
  subtask_id: "",
  user_id: "42",
  timestamp: "2026-06-25T08:00:00Z",
  kind: "encoding",
  expires: "2026-06-25T12:00:00Z",
  ...over,
});
const reviewLock = lock({ subtask_id: "S0001", kind: "validation" });
const history = (over: Partial<HistoryRow>): HistoryRow => ({
  timestamp: "2026-06-24T10:00:00Z",
  task_id: "T0001",
  subtask_id: "",
  user_id: "42",
  action: "claim_encoding",
  outcome: "accepted",
  detail: "",
  ...over,
});
const failComment = (over: Partial<CommentRow> = {}): CommentRow => ({
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
const T0001 = TASKS[0];

// --- Encoding --------------------------------------------------------------

test("an encoding precheck resolves the task and rejects before the file is read", () => {
  const args = {
    tasks: TASKS,
    state: encodingState(),
    locks: [lock()],
    envelope: null,
    headRef: "encode-T0001",
    author: "42",
    changedPaths: ["sources/score.mei"],
    now: NOW,
    expired: [],
  };
  assert.deepEqual(encodingPrecheck(args), { task: T0001 });
  const envelope = {
    command: "campaign.submitEncoding",
    version: 1,
    user_id: "42",
    timestamp: NOW,
    input: { task_id: "T0001" },
  };
  assert.deepEqual(encodingPrecheck({ ...args, headRef: "x", envelope }), {
    task: T0001,
  });
  assert.deepEqual(encodingPrecheck({ ...args, headRef: "encode-T0009" }), {
    rejected: { ok: false, reason: "unknown_task" },
  });
  assert.deepEqual(encodingPrecheck({ ...args, locks: [] }), {
    rejected: {
      ok: false,
      reason: "not_lock_holder",
      detail: "",
      history: {
        timestamp: NOW,
        task_id: "T0001",
        subtask_id: "",
        user_id: "42",
        action: "submit_encoding",
        outcome: "rejected",
        detail: "not_lock_holder",
      },
    },
  });
  const expired = encodingPrecheck({
    ...args,
    locks: [],
    expired: [lock()],
  });
  assert.equal(
    "rejected" in expired && expired.rejected.reason,
    "claim_expired",
  );
});

test("an encoding cannot be assembled without the fork's file, the score or config.yaml", () => {
  const args = {
    task: T0001,
    forkMei: "<mei/>",
    baseMei: "<mei/>",
    configText: null,
    isPageTask: false,
  };
  assert.equal(encodingInputGap(args), null);
  assert.deepEqual(
    encodingInputGap({ ...args, forkMei: null, baseMei: null }),
    {
      detail: "sources/score.mei is missing from the fork.",
      baseFailed: false,
    },
  );
  assert.deepEqual(encodingInputGap({ ...args, baseMei: null }), {
    detail: "sources/score.mei is missing from the campaign.",
    baseFailed: true,
  });
  assert.deepEqual(encodingInputGap({ ...args, isPageTask: true }), {
    detail: "config.yaml is missing from the campaign.",
    baseFailed: true,
  });
  assert.equal(
    encodingInputGap({ ...args, isPageTask: true, configText: "pieces:\n" }),
    null,
  );
});

test("an encoding's contributions name the kept work, then the author's newest message", () => {
  const kept = [
    {
      row: history({
        timestamp: "2026-06-20T10:00:00Z",
        user_id: "77",
        action: "reap",
        outcome: "released_with_work",
      }),
      login: "carol",
    },
    {
      row: history({
        timestamp: "2026-06-21T10:00:00Z",
        user_id: "78",
        action: "reap",
        outcome: "released_with_work",
      }),
      login: null,
    },
  ];
  const args = {
    task: T0001,
    kept,
    commitMessages: [
      "Fix the slurs",
      "Transcription draft of page 2",
      "Let's Encode: start from kept work",
    ],
    pr: PR,
    pastHistory: [history({})],
    now: NOW,
  };
  assert.deepEqual(encodingContributions(args), [
    {
      name: "carol",
      id: "77",
      message: "Unsubmitted work on T0001, kept when the claim expired.",
      isodate: "2026-06-20",
      application: "mei-friend",
    },
    {
      name: "ghost",
      id: "78",
      message: "Unsubmitted work on T0001, kept when the claim expired.",
      isodate: "2026-06-21",
      application: "mei-friend",
    },
    {
      name: "bob",
      id: "42",
      message: "Fix the slurs",
      isodate: "2026-06-25",
      application: "mei-friend",
    },
  ]);

  const [own] = encodingContributions({
    ...args,
    kept: [],
    commitMessages: [],
    pastHistory: [history({ action: "review_edit" })],
  });
  assert.equal(
    own.message,
    "Corrected during review: Encoding of T0001 accepted.",
  );
  const [preTask] = encodingContributions({
    ...args,
    task: TASKS[2],
    kept: [],
  });
  assert.equal(preTask.application, undefined);
  assert.throws(
    () => encodingContributions({ ...args, pr: { ...PR, authorLogin: "" } }),
    /^Error: Pull request #7 names no author login\.$/,
  );
});

const facsimileScore = () =>
  buildFacsimileMei(
    {
      ...initialFacsimileModel([
        {
          image: "img/01.jpg",
          width: 400,
          height: 200,
          measures: [{ ulx: 0, uly: 10, lrx: 90, lry: 90 }],
        },
      ]),
      headXml: buildPieceHead(
        { title: "Lied", composer: "" },
        emptySourceMetadata(),
        { date: "2026-11-06" },
      ),
    },
    { withBreaks: true },
  );

test("an encoding is assembled, or its splice failure says whose side failed", () => {
  const base = facsimileScore();
  const fork = base.replace(
    /<mRest\b[^>]*\/>/g,
    '<note dur="4" oct="4" pname="c"/>',
  );
  const contributions = [
    { name: "bob", message: "Encoding of T0001", isodate: "2026-06-25" },
  ];
  const whole = assembleEncoding({
    task: T0001,
    tasks: TASKS,
    configYaml: null,
    baseMei: base,
    forkMei: fork,
    contributions,
  });
  assert.equal(whole.detail, "");
  assert.equal(whole.baseFailed, false);
  assert.match(whole.mei ?? "", /<note /);
  assert.match(whole.mei ?? "", /Encoding of T0001/);

  const page = { ...T0001, locator: "surface-1" };
  const baseFault = assembleEncoding({
    task: page,
    tasks: [page],
    configYaml: null,
    baseMei: "<mei></mei>",
    forkMei: fork,
    contributions,
  });
  assert.deepEqual(baseFault, {
    mei: null,
    detail:
      "Could not splice page surface-1 into sources/score.mei: No page break found for surface-1.",
    baseFailed: true,
    spliceError: "No page break found for surface-1.",
  });
  const forkFault = assembleEncoding({
    task: page,
    tasks: [page],
    configYaml: null,
    baseMei: base,
    forkMei: "<mei></mei>",
    contributions,
  });
  assert.equal(forkFault.mei, null);
  assert.equal(forkFault.baseFailed, false);
});

test("an encoding's verdict names a join fault splice_invalid and keeps its detail", () => {
  const args = {
    tasks: TASKS,
    state: encodingState(),
    locks: [lock()],
    task: T0001,
    author: "42",
    changedPaths: ["sources/score.mei"],
    meiValid: true,
    joinFailed: false,
    detail: "",
    now: NOW,
    expired: [],
  };
  const accepted = encodingVerdict(args);
  assert.ok(!("rejected" in accepted));
  assert.deepEqual(accepted.locks, []);
  assert.equal(accepted.history.outcome, "accepted");
  assert.equal(accepted.history.detail, "");

  const invalid = encodingVerdict({
    ...args,
    meiValid: false,
    detail: "sources/score.mei:bad",
  });
  assert.deepEqual(invalid, {
    rejected: {
      ok: false,
      reason: "mei_invalid",
      detail: "sources/score.mei:bad",
      history: {
        timestamp: NOW,
        task_id: "T0001",
        subtask_id: "",
        user_id: "42",
        action: "submit_encoding",
        outcome: "rejected",
        detail: "mei_invalid",
      },
    },
  });
  const join = encodingVerdict({
    ...args,
    meiValid: false,
    joinFailed: true,
    detail: "d",
  });
  assert.equal("rejected" in join && join.rejected.reason, "splice_invalid");
  assert.equal("rejected" in join && join.rejected.detail, "d");
  // Only the MEI rejections carry the detail; joinFailed changes no other.
  const noClaim = encodingVerdict({
    ...args,
    locks: [],
    meiValid: false,
    joinFailed: true,
    detail: "d",
  });
  assert.equal(
    "rejected" in noClaim && noClaim.rejected.reason,
    "not_lock_holder",
  );
  assert.equal("rejected" in noClaim && noClaim.rejected.detail, "");
});

test("only the side files a submission changed are taken from the fork", () => {
  const layout = TASKS[2];
  assert.deepEqual(submittedSideFiles(T0001, ["sources/score.mei"]), []);
  const sides = submittedSideFiles(layout, [
    "sources/piece/score.mei",
    "sources/piece/layout.json",
    "sources/piece/layout-corrected.json",
  ]);
  assert.ok(sides.length > 0);
  assert.ok(sides.every((p) => p.startsWith("sources/piece/")));
  assert.deepEqual(submittedSideFiles(layout, ["sources/piece/score.mei"]), []);
});

test("an accepted encoding commits the score, side files, state and locks", () => {
  const state = encodingState();
  const held = lock({ task_id: "T0005" });
  const accepted = {
    state,
    locks: [lock({ task_id: "T0002" })],
    history: history({ action: "submit_encoding" }),
  };
  const decision = acceptedEncoding({
    pr: PR,
    task: T0001,
    tasks: TASKS,
    mei: "<mei/>",
    sideFiles: [
      { path: "a.json", content: "{}" },
      { path: "b.json", content: null },
    ],
    accepted,
    held: [held],
    pastHistory: [],
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.history, accepted.history);
  assert.deepEqual(
    decision.files!.map((f) => f.path),
    ["sources/score.mei", "a.json", STATE_PATH, LOCK_PATH],
  );
  assert.equal(fileOf(decision.files!, STATE_PATH), serializeStateCsv(state));
  assert.deepEqual(parseLockCsv(fileOf(decision.files!, LOCK_PATH)!), [
    ...accepted.locks,
    held,
  ]);
  assert.equal(decision.message, "Accept encoding of T0001 by bob");

  // A layout correction of a piece without page tasks rebuilds none.
  const layout = acceptedEncoding({
    pr: PR,
    task: TASKS[2],
    tasks: TASKS,
    mei: facsimileScore(),
    sideFiles: [],
    accepted,
    held: [],
    pastHistory: [],
  });
  assert.ok(!layout.files!.some((f) => f.path === TASK_PATH));
});

// --- Validation ------------------------------------------------------------

const PASS_PATCH =
  "@@ -3 +3 @@\n-T0001,S0001,validation_required,,,\n+T0001,S0001,validation_required,,,pass";
const FAIL_PATCH = PASS_PATCH.replace(/pass$/, "fail");
const COMMENT_APPEND =
  "@@ -1 +1,2 @@\n+,T0001,S0001,fail,,,,,,,,Slur missing.,";

test("a review verdict's intent is one validation cell and its fail comment", () => {
  const args = {
    prFiles: [{ filename: STATE_PATH, patch: PASS_PATCH }],
    changedPaths: [STATE_PATH],
    state: reviewState(),
    author: "42",
    now: NOW,
  };
  assert.deepEqual(validationIntent(args), {
    task_id: "T0001",
    subtask_id: "S0001",
    status: "pass",
    failComment: null,
    wantsComments: true,
  });
  const fail = validationIntent({
    ...args,
    prFiles: [
      { filename: STATE_PATH, patch: FAIL_PATCH },
      { filename: COMMENT_PATH, patch: COMMENT_APPEND },
    ],
    changedPaths: [STATE_PATH, COMMENT_PATH],
  });
  assert.ok(!("rejected" in fail));
  assert.equal(fail.status, "fail");
  assert.equal(fail.failComment?.body, "Slur missing.");
  assert.equal(fail.wantsComments, true);
  const bareFail = validationIntent({
    ...args,
    prFiles: [{ filename: STATE_PATH, patch: FAIL_PATCH }],
  });
  assert.ok(!("rejected" in bareFail));
  assert.equal(bareFail.wantsComments, false);

  assert.deepEqual(validationIntent({ ...args, prFiles: [] }), {
    rejected: { ok: false, reason: "malformed_validation" },
  });
  // A changed status cell is not a validation column.
  assert.deepEqual(
    validationIntent({
      ...args,
      prFiles: [
        {
          filename: STATE_PATH,
          patch:
            "@@\n-T0001,S0001,validation_required,,,\n+T0001,S0001,completed,,,",
        },
      ],
    }),
    { rejected: { ok: false, reason: "malformed_validation" } },
  );
  assert.deepEqual(
    validationIntent({
      ...args,
      prFiles: [
        { filename: STATE_PATH, patch: PASS_PATCH.replace(/pass$/, "maybe") },
      ],
    }),
    {
      rejected: {
        ok: false,
        reason: "invalid_verdict",
        history: {
          timestamp: NOW,
          task_id: "T0001",
          subtask_id: "S0001",
          user_id: "42",
          action: "submit_validation",
          outcome: "rejected",
          detail: "invalid_verdict",
        },
      },
    },
  );
});

const intent = (over: Partial<ValidationIntent> = {}): ValidationIntent => ({
  task_id: "T0001",
  subtask_id: "S0001",
  status: "pass",
  failComment: null,
  wantsComments: true,
  ...over,
});

test("an accepted pass records the verdict and resolves the change requests", () => {
  const held = lock({ task_id: "T0005" });
  const args = {
    pr: PR,
    intent: intent(),
    state: reviewState(),
    locks: [reviewLock],
    configText: null,
    baseCommentCsv: COMMENT_HEADER + "c1,T0001,S0001,fail,,,,99,t,,,Fix it,\n",
    changedPaths: [STATE_PATH],
    now: NOW,
    expired: [],
    held: [held],
    newId: "abcd1234",
  };
  const pass = decideValidation(args);
  assert.equal(pass.ok, true);
  assert.equal(pass.history?.detail, "pass");
  assert.equal(pass.history?.action, "submit_validation");
  assert.deepEqual(parseLockCsv(fileOf(pass.files!, LOCK_PATH)!), [held]);
  assert.equal(
    parseCommentCsv(fileOf(pass.files!, COMMENT_PATH)!)[0].resolved,
    "true",
  );
  assert.equal(pass.message, "Record pass validation of T0001/S0001 by bob");
  // No open change request: the comment table is not written.
  const clean = decideValidation({ ...args, baseCommentCsv: null });
  assert.deepEqual(
    clean.files!.map((f) => f.path),
    [STATE_PATH, LOCK_PATH],
  );
});

test("an accepted fail records the verdict with its re-authored comment", () => {
  const fail = decideValidation({
    pr: PR,
    intent: intent({
      status: "fail",
      failComment: failComment({ comment_id: "forged", author_id: "1" }),
    }),
    state: reviewState(),
    locks: [reviewLock],
    configText: null,
    baseCommentCsv: COMMENT_HEADER + "c1,T0001,,comment,,,,99,t,,,Hi,\n",
    changedPaths: [STATE_PATH, COMMENT_PATH],
    now: NOW,
    expired: [],
    held: [],
    newId: "abcd1234",
  });
  assert.equal(fail.ok, true);
  assert.equal(fail.history?.detail, "fail");
  const comments = parseCommentCsv(fileOf(fail.files!, COMMENT_PATH)!);
  assert.equal(comments.length, 2);
  assert.deepEqual(comments[1], {
    ...failComment(),
    comment_id: "abcd1234",
    author_id: "42",
    timestamp: NOW,
  });
  assert.equal(fail.message, "Record fail validation of T0001/S0001 by bob");
});

test("a rejected verdict carries only its history row", () => {
  const rejected = decideValidation({
    pr: PR,
    intent: intent({ status: "fail" }),
    state: reviewState(),
    locks: [reviewLock],
    configText: null,
    baseCommentCsv: null,
    changedPaths: [STATE_PATH],
    now: NOW,
    expired: [],
    held: [],
    newId: "abcd1234",
  });
  assert.deepEqual(rejected, {
    ok: false,
    reason: "fail_without_comment",
    history: {
      timestamp: NOW,
      task_id: "T0001",
      subtask_id: "S0001",
      user_id: "42",
      action: "submit_validation",
      outcome: "rejected",
      detail: "fail_without_comment",
    },
  });
});

// --- Commit and comment ----------------------------------------------------

test("a submission commits its files, history and the kept locks", () => {
  const expired = lock({ task_id: "T0009" });
  const kept = lock({ task_id: "T0002" });
  const base = {
    pr: PR,
    kind: "encoding" as const,
    locks: [kept],
    removed: [expired],
    keptWork: new Set([expired]),
    historyCsv: "",
    now: NOW,
    envelope: null,
  };
  const accepted = submitCommit({
    ...base,
    outcome: {
      ok: true,
      history: history({ action: "submit_encoding", timestamp: NOW }),
      files: [
        { path: "sources/score.mei", content: "<mei/>" },
        { path: LOCK_PATH, content: "own" },
      ],
      message: "Accept encoding of T0001 by bob",
    },
  });
  assert.deepEqual(
    accepted.files.map((f) => f.path),
    ["sources/score.mei", LOCK_PATH, HISTORY_PATH],
  );
  assert.equal(fileOf(accepted.files, LOCK_PATH), "own");
  const rows = parseHistoryCsv(fileOf(accepted.files, HISTORY_PATH)!);
  assert.deepEqual(
    rows.map((r) => [r.task_id, r.action, r.outcome]),
    [
      ["T0009", "reap", "released_with_work"],
      ["T0001", "submit_encoding", "accepted"],
    ],
  );
  assert.equal(rows[1].pr, "7");
  assert.equal(accepted.history.pr, "7");
  assert.equal(accepted.message, `Accept encoding of T0001 by bob${TRAILER}`);

  const rejected = submitCommit({
    ...base,
    kind: "validation",
    outcome: {
      ok: false,
      reason: "claim_expired",
      history: history({ action: "submit_validation", outcome: "rejected" }),
    },
  });
  assert.deepEqual(
    rejected.files.map((f) => f.path),
    [HISTORY_PATH, LOCK_PATH],
  );
  assert.deepEqual(parseLockCsv(fileOf(rejected.files, LOCK_PATH)!), [kept]);
  assert.equal(
    rejected.message,
    "Reject validation submission by bob (claim_expired)",
  );
  const noExpiry = submitCommit({
    ...base,
    removed: [],
    outcome: { ok: false, reason: "mei_invalid", history: history({}) },
  });
  assert.deepEqual(
    noExpiry.files.map((f) => f.path),
    [HISTORY_PATH],
  );
});

test("a submission's comment says what was accepted or why not, with its detail", () => {
  assert.equal(
    submitComment("validation", { ok: true }),
    "✅ Submission accepted (review).",
  );
  assert.equal(
    submitComment("encoding", { ok: true }),
    "✅ Submission accepted (encoding).",
  );
  assert.equal(
    submitComment("encoding", {
      ok: false,
      reason: "mei_invalid",
      detail: "sources/score.mei:bad `x`",
    }),
    "❌ Submission rejected: `mei_invalid` — the submitted MEI failed the machine check. No changes were made. `sources/score.mei:bad 'x'`",
  );
  assert.match(
    submitComment("encoding", { ok: false, reason: "claim_expired" }),
    /any unsubmitted work on its task branch was kept\.$/,
  );
  assert.match(
    submitComment("validation", { ok: false, reason: "claim_expired" }),
    /The claim had run out and has been released\.$/,
  );
});
