import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildBoard,
  cardTitle,
  doneLabel,
  buildThreads,
  expiresIn,
} from "../campaign-board.ts";
import {
  parseCommentCsv,
  parseStateCsv,
  parseTaskCsv,
} from "../campaign-tables.ts";
import { taskName, taskScope } from "../campaign-graph.ts";
import type { NodeSlot } from "../campaign-graph.ts";

const COMMENT_HEADER =
  "comment_id,task_id,subtask_id,kind,page,measure_start,measure_end,author_id,timestamp,resolved,parent_id,body\n";

const slot = (over: Partial<NodeSlot>): NodeSlot => ({
  sub: "S0001",
  slot: 0,
  key: "open",
  label: "",
  who: "",
  running: false,
  claimable: false,
  user: "",
  ts: "",
  ...over,
});

test("cardTitle is the task's name, then its piece: config name, else piece directory, else basename", () => {
  const names = { "sources/piece-1/score.mei": "Sonata in C" };
  assert.equal(
    cardTitle("sources/piece-1/score.mei", "surface-3", names),
    "Encode · p. 3 · Sonata in C",
  );
  assert.equal(
    cardTitle("sources/piece-1/score.mei", "score-setup", names),
    "Score setup · Sonata in C",
  );
  assert.equal(
    cardTitle("sources/piece-1/score.mei", "surface-2", names, true),
    "Correct the OMR draft · p. 2 · Sonata in C",
  );
  // Unnamed pieces fall back to the path's piece directory…
  assert.equal(
    cardTitle("sources/piece-2/score.mei", "", names),
    "Encode · piece-2",
  );
  // …and paths outside the sources/<piece>/score.mei layout to the basename.
  assert.equal(cardTitle("sources/score.mei", "", names), "Encode · score");
  assert.equal(
    cardTitle("sources/anthem.mei", "surface-1", {}),
    "Encode · p. 1 · anthem",
  );
});

test("taskName and taskScope: the page is the scope; pre-tasks cover the whole piece", () => {
  assert.equal(taskScope("surface-12"), "p. 12");
  assert.equal(taskScope("measure-zones"), "");
  assert.equal(taskName("omr-layout"), "Measure correction");
  assert.equal(taskName("score-setup", true), "Score setup");
  assert.equal(taskName("surface-4", true), "Correct the OMR draft · p. 4");
});

test("buildThreads lists a task's comments and fail comments in log order, with replies", () => {
  const comments = parseCommentCsv(
    COMMENT_HEADER +
      "c1,T0002,S0001,fail,1,1,2,111,2026-08-12T10:21:03.348Z,,,Not the correct notes\n" +
      "c2,T0002,S0001,fail,3,,,222,2026-08-12T10:37:24.390Z,true,,resolved earlier\n" +
      "c3,T0002,,comment,,,,333,2026-08-12T10:40:00.000Z,,,a comment\n" +
      "c4,T0001,S0001,fail,1,1,1,111,2026-08-12T09:00:00.000Z,,,other task\n" +
      "c5,T0002,S0001,fail,2,,,111,2026-08-12T11:00:00.000Z,,,later request\n" +
      "c6,T0002,,reply,,,,111,2026-08-12T11:05:00.000Z,,c3,a reply\n",
  );
  assert.deepEqual(
    buildThreads(comments, "T0002").map((t) => [
      t.root.comment_id,
      t.replies.map((r) => r.comment_id),
    ]),
    [
      ["c1", []],
      ["c2", []],
      ["c3", ["c6"]],
      ["c5", []],
    ],
  );
});

test("the done column lists the tasks finished last first", () => {
  const d = {
    taskDefs: parseTaskCsv(
      "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n" +
        "T0001,,sources/a.mei,,,,\n" +
        "T0001,S0001,sources/a.mei,,,,\n" +
        "T0002,,sources/a.mei,,,,\n" +
        "T0002,S0001,sources/a.mei,,,,\n",
    ),
    rows: parseStateCsv(
      "task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n" +
        "T0001,,completed,7,2026-08-01T00:00:00Z,\n" +
        "T0001,S0001,completed,,,pass|9|2026-08-10T00:00:00Z\n" +
        "T0002,,completed,7,2026-08-02T00:00:00Z,\n" +
        "T0002,S0001,completed,,,pass|9|2026-08-12T00:00:00Z\n",
    ).rows,
    validationColumns: ["validate_status_1"],
    locks: [],
    passThreshold: 1,
  };
  const board = buildBoard(d, [], []);
  const done = board.columns.find((c) => c.key === "done")!;
  assert.deepEqual(
    done.cards.map((c) => c.task),
    ["T0002", "T0001"],
  );
  assert.equal(done.cards[0].finishedAt, "2026-08-12T00:00:00Z");
});

test("attention counts skip replies once their root comment is resolved", () => {
  const d = {
    taskDefs: parseTaskCsv(
      "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n" +
        "T0001,,sources/a.mei,,,,\n" +
        "T0001,S0001,sources/a.mei,,,,\n",
    ),
    rows: parseStateCsv(
      "task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n" +
        "T0001,,validation_required,7,t,\n" +
        "T0001,S0001,validation_required,,,\n",
    ).rows,
    validationColumns: ["validate_status_1"],
    locks: [],
    passThreshold: 1,
  };
  // c1 answered and resolved: its reply c2 stays unresolved (replies have no
  // resolve control) but needs no attention. c3 is a live comment with a
  // reply c4 — both still count.
  const comments = parseCommentCsv(
    COMMENT_HEADER +
      "c1,T0001,,comment,,,,9,t1,true,,Answered?\n" +
      "c2,T0001,,reply,,,,7,t2,,c1,Yes\n" +
      "c3,T0001,,comment,,,,9,t3,,,Still open?\n" +
      "c4,T0001,,reply,,,,7,t4,,c3,Looking into it\n",
  );
  const board = buildBoard(d, comments, []);
  const card = board.columns.find((c) => c.key === "validation")!.cards[0];
  assert.deepEqual(card.counts, { fails: 0, comments: 2 });
  assert.equal(board.attention, 2);
});

test("a card in review knows whether the viewer submitted it", () => {
  const d = {
    taskDefs: parseTaskCsv(
      "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n" +
        "T0001,,sources/a.mei,,,,\n" +
        "T0001,S0001,sources/a.mei,,,,\n",
    ),
    rows: parseStateCsv(
      "task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n" +
        "T0001,,validation_required,7,2026-08-01T00:00:00Z,\n" +
        "T0001,S0001,validation_required,,,\n",
    ).rows,
    validationColumns: ["validate_status_1"],
    locks: [],
    passThreshold: 1,
  };
  const card = (viewer: string) =>
    buildBoard(d, [], [], viewer)
      .columns.flatMap((c) => c.cards)
      .find((c) => c.task === "T0001")!;
  assert.equal(card("7").column, "validation");
  assert.equal(card("7").submittedByViewer, true);
  assert.equal(
    card("7").slots.some((s) => s.claimable),
    false,
  );
  assert.equal(card("9").submittedByViewer, false);
  assert.equal(
    card("9").slots.some((s) => s.claimable),
    true,
  );
});

test("doneLabel gives the review count, or done, and when the task finished", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const at = "2026-09-29T12:00:00Z";
  assert.equal(
    doneLabel({ doneLine: "1 of 1 review", finishedAt: at }, now),
    "1 of 1 review · 7 d ago",
  );
  assert.equal(
    doneLabel({ doneLine: "", finishedAt: at }, now),
    "done · 7 d ago",
  );
  assert.equal(
    doneLabel({ doneLine: "", finishedAt: "2026-10-06T12:00:00Z" }, now),
    "done · just now",
  );
  assert.equal(
    doneLabel({ doneLine: "2 of 2 reviews", finishedAt: "" }, now),
    "2 of 2 reviews",
  );
});

test("expiresIn names the time left on a claim, or that it has run out", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  assert.equal(expiresIn("2026-10-08T13:00:00Z", now), "expires in 2 d");
  assert.equal(expiresIn("2026-10-06T17:30:00Z", now), "expires in 5 h");
  assert.equal(expiresIn("2026-10-06T12:20:00Z", now), "expires in 20 min");
  assert.equal(expiresIn("2026-10-06T11:00:00Z", now), "expired");
  assert.equal(expiresIn("not a date", now), "");
});
