import { test } from "node:test";
import assert from "node:assert/strict";

import {
  actionable,
  attentionByPieceOf,
  attentionCardsOf,
  displayColumnsOf,
  firstFilledLaneOf,
  laneOf,
  pieceIndexByTaskOf,
  pieceProgressOf,
  previewPiecesOf,
  railCountsOf,
  railOpenCountOf,
  scopeColumns,
  volStandingOf,
} from "../campaign-page/board-columns.ts";
import type { BoardCard, BoardColumn, ColumnKey } from "../campaign-board.ts";
import type { NodeSlot } from "../campaign-graph.ts";
import type {
  HistoryRow,
  LockRow,
  PieceRef,
  TaskRow,
} from "../campaign-tables.ts";

const slot = (over: Partial<NodeSlot>): NodeSlot => ({
  sub: "S0001",
  slot: 0,
  key: "open",
  label: "",
  who: "",
  running: false,
  claimable: false,
  needsAnother: false,
  user: "",
  ts: "",
  ...over,
});

const card = (
  task: string,
  column: ColumnKey,
  over: Partial<BoardCard> = {},
): BoardCard =>
  ({
    task,
    column,
    slots: [],
    counts: { fails: 0, comments: 0 },
    ...over,
  }) as BoardCard;

const taskRow = (task_id: string, fragment: string, subtask_id = ""): TaskRow =>
  ({ task_id, subtask_id, fragment, locator: "" }) as TaskRow;

const taskDefs = [
  taskRow("T1", "a.mei"),
  taskRow("T2", "a.mei"),
  taskRow("T2", "a.mei", "S0001"),
  taskRow("T3", "b.mei"),
];
const pieces: PieceRef[] = [{ id: "P2", path: "b.mei", title: "Second" }];

test("previewPiecesOf lists each top-level task's piece once, named from the config where it is", () => {
  assert.deepEqual(previewPiecesOf(taskDefs, pieces), [
    { id: "a.mei", path: "a.mei", title: "" },
    { id: "P2", path: "b.mei", title: "Second" },
  ]);
});

test("pieceIndexByTaskOf maps each task to its piece's index", () => {
  const preview = previewPiecesOf(taskDefs, pieces);
  assert.deepEqual(
    [...pieceIndexByTaskOf(preview, taskDefs)],
    [
      ["T1", 0],
      ["T2", 0],
      ["T3", 1],
    ],
  );
});

test("pieceProgressOf counts done and total tasks per piece", () => {
  const cards = [card("T1", "done"), card("T2", "ready"), card("T3", "done")];
  assert.deepEqual(
    [...pieceProgressOf(cards, taskDefs)],
    [
      ["a.mei", { done: 1, total: 2 }],
      ["b.mei", { done: 1, total: 1 }],
    ],
  );
});

test("actionable keeps open tasks and reviews with a free slot", () => {
  assert.equal(actionable(card("T1", "ready")), true);
  assert.equal(actionable(card("T1", "encoding")), false);
  assert.equal(
    actionable(card("T1", "validation", { slots: [slot({ key: "open" })] })),
    true,
  );
  assert.equal(
    actionable(card("T1", "validation", { slots: [slot({ key: "review" })] })),
    false,
  );
});

test("attention counts unresolved fails and comments of tasks not done, per piece", () => {
  const preview = previewPiecesOf(taskDefs, pieces);
  const index = pieceIndexByTaskOf(preview, taskDefs);
  const cards = [
    card("T1", "encoding", { counts: { fails: 1, comments: 2 } }),
    card("T2", "done", { counts: { fails: 1, comments: 0 } }),
    card("T3", "ready", { counts: { fails: 0, comments: 1 } }),
  ];
  const attention = attentionCardsOf(cards);
  assert.deepEqual(
    attention.map((c) => c.task),
    ["T1", "T3"],
  );
  assert.deepEqual(
    [...attentionByPieceOf(attention, preview, index)],
    [
      ["a.mei", 3],
      ["b.mei", 1],
    ],
  );
});

test("railCountsOf counts not-done tasks per lane, under the Claimable filter only actionable ones", () => {
  const preview = previewPiecesOf(taskDefs, pieces);
  const index = pieceIndexByTaskOf(preview, taskDefs);
  const cards = [
    card("T1", "blocked"),
    card("T2", "encoding"),
    card("T3", "ready"),
  ];
  assert.deepEqual(
    [...railCountsOf(cards, "all", preview, index)],
    [
      ["a.mei", { open: 1, encoding: 1, validation: 0 }],
      ["b.mei", { open: 1, encoding: 0, validation: 0 }],
    ],
  );
  assert.deepEqual(
    [...railCountsOf(cards, "open", preview, index)],
    [["b.mei", { open: 1, encoding: 0, validation: 0 }]],
  );
});

const boardColumns: BoardColumn[] = [
  { key: "blocked", label: "", cards: [card("T1", "blocked")] },
  { key: "ready", label: "", cards: [card("T3", "ready")] },
  { key: "encoding", label: "", cards: [card("T2", "encoding")] },
  { key: "validation", label: "", cards: [] },
  { key: "done", label: "", cards: [] },
];

test("displayColumnsOf renders four lanes, blocked tasks after the open ones", () => {
  const cols = displayColumnsOf(boardColumns);
  assert.deepEqual(
    cols.map((c) => [c.key, c.label, c.cards.map((k) => k.task)]),
    [
      ["ready", "Open", ["T3", "T1"]],
      ["encoding", "Encoding", ["T2"]],
      ["validation", "Review", []],
      ["done", "Done", []],
    ],
  );
});

test("scopeColumns filters by piece and by the Claimable filter, keeping every lane", () => {
  const preview = previewPiecesOf(taskDefs, pieces);
  const index = pieceIndexByTaskOf(preview, taskDefs);
  const cols = displayColumnsOf(boardColumns);
  const byPiece = scopeColumns(cols, "a.mei", "all", preview, index);
  assert.deepEqual(
    byPiece.map((c) => c.cards.map((k) => k.task)),
    [["T1"], ["T2"], [], []],
  );
  const claimable = scopeColumns(cols, "all", "open", preview, index);
  assert.deepEqual(
    claimable.map((c) => c.cards.map((k) => k.task)),
    [["T3"], [], [], []],
  );
  assert.equal(scopeColumns(cols, "all", "all", preview, index), cols);
  assert.equal(railOpenCountOf(cols, "all"), 2);
  assert.equal(railOpenCountOf(cols, "open"), 1);
});

test("the lane tabs fall back to the first lane with cards: review, encoding, open, done", () => {
  const cols = displayColumnsOf(boardColumns);
  assert.equal(firstFilledLaneOf(cols), "encoding");
  assert.equal(
    firstFilledLaneOf(cols.map((c) => ({ ...c, cards: [] }))),
    "ready",
  );
  assert.equal(laneOf(card("T1", "blocked")), "ready");
  assert.equal(laneOf(card("T1", "done")), "done");
  assert.equal(laneOf(null), null);
});

test("volStandingOf counts the viewer's done encodings, claims and reviews", () => {
  const history = [
    {
      user_id: "7",
      action: "submit_encoding",
      outcome: "accepted",
      task_id: "T1",
    },
  ] as HistoryRow[];
  const locks = [
    { user_id: "7", kind: "encoding", task_id: "T2" },
    { user_id: "7", kind: "validation", task_id: "T3" },
    { user_id: "8", kind: "encoding", task_id: "T3" },
  ] as LockRow[];
  const cards = [card("T1", "done")];
  assert.equal(
    volStandingOf("7", history, cards, locks),
    "You: 1 done · 1 claimed · 1 reviewing",
  );
  assert.equal(
    volStandingOf("8", history, cards, locks),
    "You: 0 done · 1 claimed",
  );
  assert.equal(volStandingOf("9", history, cards, locks), "");
  assert.equal(volStandingOf("", history, cards, locks), "");
});
