// The pipeline board: a pure projection of the tracking tables and the
// comment log into five status columns with task cards, the attention counts
// and the overlay's validation record and discussion threads. Builds on the task projection in campaign-graph.ts (statuses,
// slots, next-up) — no authoritative state lives here. No Svelte, no GitHub.

import {
  buildGraph,
  blockedBy,
  handle,
  taskDescription,
  taskName,
  taskScope,
} from "./campaign-graph.ts";
import type {
  GraphData,
  Logins,
  NodeSlot,
  StatusKey,
} from "./campaign-graph.ts";
import { findRow, isFinalValidation } from "./campaign-tables.ts";
import { keptWorkSince } from "./coordinator-policy.ts";
import type {
  CommentRow,
  HistoryRow,
  PieceNames,
  PiecePreparations,
} from "./campaign-tables.ts";

// ---------------------------------------------------------------------------
// Shared display helpers

/** Compact elapsed-time label for an ISO timestamp: "now", "25 min", "3 h", "2 d". */
export function elapsed(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const minutes = Math.floor(Math.max(0, now - t) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** When a claim's lock runs out, from its `expires` time: "expires in
    2 d", "expired", or '' when unreadable. */
export function expiresIn(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  if (t <= now) return "expired";
  const minutes = Math.ceil((t - now) / 60_000);
  if (minutes < 60) return `expires in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `expires in ${hours} h`;
  return `expires in ${Math.floor(hours / 24)} d`;
}

/** The avatar initial for a display handle. */
export const initialOf = (name: string): string =>
  name[0]?.toUpperCase() ?? "?";

/**
 * The piece behind a fragment path, for card titles: its configured name, else
 * the piece directory of the standard sources/<piece>/score.mei layout, else
 * the basename without extension.
 */
export const fragmentPieceName = (
  fragment: string,
  names: PieceNames,
): string => {
  const named = names[fragment];
  if (named) return named;
  const parts = fragment.split("/");
  const base = (parts.pop() ?? fragment).replace(/\.mei$/i, "");
  const dir = parts.pop();
  return base === "score" && dir && dir !== "sources" ? dir : base;
};

/** A task's one-line title: its name (description and scope), then its
    piece. */
export function cardTitle(
  fragment: string,
  locator: string,
  names: PieceNames = {},
  omr = false,
): string {
  return `${taskName(locator, omr)} · ${fragmentPieceName(fragment, names)}`;
}

/** A card's name without its piece: description, then scope. */
export const cardName = (card: BoardCard): string =>
  card.scope ? `${card.description} · ${card.scope}` : card.description;

// ---------------------------------------------------------------------------
// Comments per task

/** The attention chips of one task: open change requests and open comments. */
export interface TaskCounts {
  fails: number;
  comments: number;
}

/**
 * Chip counts for a task: its unresolved fail comments (change requests) and
 * its other unresolved comments.
 */
function taskCounts(comments: CommentRow[], task: string): TaskCounts {
  const byId = new Map(comments.map((c) => [c.comment_id, c]));
  // A reply is closed with its thread: once the root it chains to (via
  // parent_id) is resolved, the reply no longer needs attention.
  const rootResolved = (reply: CommentRow): boolean => {
    const seen = new Set<string>();
    let c: CommentRow | undefined = reply;
    while (c && c.parent_id && !seen.has(c.comment_id)) {
      seen.add(c.comment_id);
      c = byId.get(c.parent_id);
    }
    return c?.resolved === "true";
  };
  let fails = 0;
  let other = 0;
  for (const c of comments) {
    if (c.task_id !== task || c.resolved === "true") continue;
    if (c.kind === "reply" && rootResolved(c)) continue;
    if (c.kind === "fail") fails++;
    else other++;
  }
  return { fails, comments: other };
}

const countsTotal = (c: TaskCounts): number => c.fails + c.comments;

/** When a task was finished: its last final verdict, else its encoding time. */
function finishedAt(d: GraphData, task: string): string {
  let last = "";
  for (const row of d.rows) {
    if (row.task_id !== task || row.subtask_id === "") continue;
    for (const column of d.validationColumns) {
      const cell = row[column] ?? "";
      if (isFinalValidation(cell)) {
        const ts = cell.split("|")[2];
        if (ts > last) last = ts;
      }
    }
  }
  return last || (findRow(d.rows, task, "")?.encoded_at ?? "");
}

// ---------------------------------------------------------------------------
// The board

export type ColumnKey =
  | "blocked"
  | "ready"
  | "encoding"
  | "validation"
  | "done";

const COLUMN_OF: Record<StatusKey, ColumnKey> = {
  blocked: "blocked",
  encoding_required: "ready",
  pending: "ready",
  encoding: "encoding",
  claimed: "encoding",
  validation_required: "validation",
  completed: "done",
  // Slot-level keys; never a task status, but the record is total.
  pass: "done",
  review: "validation",
  open: "ready",
};

/** One task card on the board. */
export interface BoardCard {
  task: string;
  column: ColumnKey;
  /** The one-line title: description, scope, piece (cardTitle). */
  title: string;
  /** What the task asks for ("Encode", "Correct the OMR draft", "Measure correction", "Score setup"). */
  description: string;
  /** The part of the piece the task covers ("p. 3"); '' for the whole piece. */
  scope: string;
  /** The display name of the task's piece. */
  piece: string;
  pre: boolean;
  /** A page task of an OMR-prepared piece: it starts from the OMR draft. */
  omr: boolean;
  /** The task's locator, for routing a pre-task to its own editor. */
  locator: string;
  statusKey: StatusKey;
  /** Blocked column: the name of the task this one waits for, without its
      piece (cardName). */
  waitsFor: string;
  /** Ready column: the viewer may claim it right now. */
  claimable: boolean;
  /** The viewer submitted the task's current encoding. */
  submittedByViewer: boolean;
  /** Open column: who left unsubmitted work when their claim expired, which
      the next claim continues from; '' for none. */
  keptFrom: string;
  /** Encoding column: who holds the claim, and when it expires ("expires in 2 d"). */
  worker: { login: string; expires: string; mine: boolean } | null;
  /** Validation column: pass progress. */
  passes: number;
  threshold: number;
  counts: TaskCounts;
  /** Done column: the completion line ("3 of 3 reviews"), rendered behind a
      pass icon; '' for a task without reviews. */
  doneLine: string;
  /** Done column: when the last pass verdict landed (else the encoding time); '' elsewhere. */
  finishedAt: string;
  /** The first card the viewer can act on right now. */
  nextUp: boolean;
  /** The underlying slots, for the overlay's validation record. */
  slots: NodeSlot[];
}

export interface BoardColumn {
  key: ColumnKey;
  label: string;
  cards: BoardCard[];
}

export interface Board {
  columns: BoardColumn[];
  /** Tasks done, of all tasks. */
  done: number;
  total: number;
  attention: number;
  /** Tasks someone is actively working on (claims and running reviews). */
  inFlight: number;
  /** Distinct people the history records within the last 7 days. */
  contributorsWeek: number;
  /** The task of the first card the viewer can act on, or null. */
  nextUp: string | null;
}

const COLUMN_LABELS: Record<ColumnKey, string> = {
  blocked: "Blocked",
  ready: "Open",
  encoding: "Encoding",
  validation: "Review",
  done: "Done",
};

/** A finished card's line: its review count, or "done" where it has none,
    and when it finished ("1 of 1 review · 7 d ago", "done · just now"). */
export function doneLabel(
  card: Pick<BoardCard, "doneLine" | "finishedAt">,
  now = Date.now(),
): string {
  const e = card.finishedAt ? elapsed(card.finishedAt, now) : "";
  const when = e === "" ? "" : e === "now" ? " · just now" : ` · ${e} ago`;
  return `${card.doneLine || "done"}${when}`;
}

/**
 * The one-line status pill of a card: the current stage (the task's heading
 * names its kind), the worker on a claimed task, and numeric pass progress
 * ("n of m") in validation and done.
 */
export function cardPill(card: BoardCard, viewer = ""): string {
  switch (card.column) {
    case "blocked":
      return "blocked";
    case "ready":
      return card.keptFrom
        ? `open · unsubmitted changes by ${card.keptFrom}`
        : "open";
    case "encoding": {
      const w = card.worker;
      const who = w ? (w.mine ? "you" : w.login) : "";
      return `in progress${who ? ` · ${who}` : ""}${w?.expires ? ` · ${w.expires}` : ""}`;
    }
    case "validation": {
      const held = card.slots.filter((s) => s.key === "review");
      const reviewing = viewer !== "" && held.some((s) => s.user === viewer);
      return `in review · ${card.passes} of ${card.threshold}${reviewing ? " · reviewing" : held.length ? " · being reviewed" : ""}`;
    }
    case "done":
      return card.threshold > 0
        ? `done · ${card.passes} of ${card.threshold} review${card.threshold === 1 ? "" : "s"}`
        : "done";
  }
}

/** Project the tables into the five-column pipeline board. */
export function buildBoard(
  d: GraphData,
  comments: CommentRow[],
  history: HistoryRow[],
  viewer = "",
  logins: Logins = {},
  names: PieceNames = {},
  now = Date.now(),
  preparations: PiecePreparations = {},
): Board {
  const nodes = buildGraph(d, viewer, logins);
  const columns: BoardColumn[] = (
    Object.keys(COLUMN_LABELS) as ColumnKey[]
  ).map((key) => ({
    key,
    label: COLUMN_LABELS[key],
    cards: [],
  }));
  const columnByKey = new Map(columns.map((c) => [c.key, c]));

  for (const n of nodes) {
    const def = findRow(d.taskDefs, n.task, "")!;
    const column = COLUMN_OF[n.statusKey] ?? "ready";
    const lock = d.locks.find(
      (l) =>
        l.task_id === n.task && l.subtask_id === "" && l.kind === "encoding",
    );
    const dep = blockedBy(d, n.task);
    const depDef = dep ? findRow(d.taskDefs, dep, "") : undefined;
    const counts = taskCounts(comments, n.task);
    const omr = preparations[def.fragment] === "omr";
    columnByKey.get(column)!.cards.push({
      task: n.task,
      column,
      title: cardTitle(def.fragment, def.locator, names, omr),
      description: taskDescription(def.locator, omr),
      scope: taskScope(def.locator),
      piece: fragmentPieceName(def.fragment, names),
      pre: n.kind === "pre",
      omr: omr && n.kind !== "pre",
      locator: def.locator,
      statusKey: n.statusKey,
      waitsFor: depDef
        ? taskName(depDef.locator, preparations[depDef.fragment] === "omr")
        : dep,
      claimable: viewer !== "" && column === "ready" && !lock,
      submittedByViewer:
        viewer !== "" && findRow(d.rows, n.task, "")?.encoder === viewer,
      keptFrom:
        column === "ready"
          ? handle(logins, keptWorkSince(history, n.task).at(-1)?.user_id ?? "")
          : "",
      worker:
        column === "encoding" && lock
          ? {
              login: handle(logins, lock.user_id),
              expires: expiresIn(lock.expires, now),
              mine: viewer !== "" && lock.user_id === viewer,
            }
          : null,
      passes: n.passes,
      threshold: n.threshold,
      counts,
      doneLine:
        n.kind === "pre" || n.threshold === 0
          ? ""
          : `${n.passes} of ${n.threshold} review${n.threshold === 1 ? "" : "s"}`,
      finishedAt: column === "done" ? finishedAt(d, n.task) : "",
      nextUp: n.nextUp,
      slots: n.slots,
    });
  }

  // The Done column reads newest first, so the tasks finished last stay in
  // view above its collapse.
  columnByKey
    .get("done")!
    .cards.sort((a, b) =>
      a.finishedAt < b.finishedAt ? 1 : a.finishedAt > b.finishedAt ? -1 : 0,
    );

  // The campaign's attention count (the hero counter): unresolved comments
  // plus open change requests, on non-completed tasks — summed from the card counts
  // computed above.
  const attention = columns
    .filter((column) => column.key !== "done")
    .reduce(
      (n, column) =>
        n + column.cards.reduce((m, card) => m + countsTotal(card.counts), 0),
      0,
    );

  const reviewTasks = new Set(
    d.locks.filter((l) => l.kind === "validation").map((l) => l.task_id),
  );
  const inFlight = columnByKey.get("encoding")!.cards.length + reviewTasks.size;

  const weekAgo = now - 7 * 24 * 3600_000;
  const contributorsWeek = new Set(
    history
      .filter((h) => Date.parse(h.timestamp) >= weekAgo && h.user_id)
      .map((h) => h.user_id),
  ).size;

  return {
    columns,
    done: columnByKey.get("done")!.cards.length,
    total: nodes.length,
    attention,
    inFlight,
    contributorsWeek,
    nextUp: nodes.find((n) => n.nextUp)?.task ?? null,
  };
}

// ---------------------------------------------------------------------------
// The overlay's right rail

/** One row of the overlay's validation record. */
export interface RecordRow {
  sub: string;
  slot: number;
  key: StatusKey;
  /** Verdict author or reviewing lock holder; '' when open. */
  login: string;
  /** The stored user id behind the row, for permission checks; '' when open. */
  userId: string;
  elapsed: string;
  claimable: boolean;
  /** The viewer holds this slot's review lock. */
  mine: boolean;
}

/** The validation record for a task card, one row per slot. */
export function buildRecord(
  card: Pick<BoardCard, "task" | "slots">,
  viewer = "",
  logins: Logins = {},
  now = Date.now(),
): RecordRow[] {
  return card.slots.map((s) => ({
    sub: s.sub,
    slot: s.slot,
    key: s.key,
    login: s.user ? handle(logins, s.user) : "",
    userId: s.user,
    elapsed: s.ts ? elapsed(s.ts, now) : "",
    claimable: s.claimable,
    mine: viewer !== "" && s.key === "review" && s.user === viewer,
  }));
}

/** A task's unresolved fail comments (change requests), newest first. */
export function openChangeRequests(
  task: string,
  comments: CommentRow[],
): CommentRow[] {
  return comments
    .filter(
      (c) => c.task_id === task && c.kind === "fail" && c.resolved !== "true",
    )
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** One discussion thread: a top-level comment and its replies, oldest first. */
export interface Thread {
  root: CommentRow;
  replies: CommentRow[];
}

/**
 * The overlay's discussion: the task's top-level comments
 * with their replies. Fail comments live in the validation record instead.
 */
export function buildThreads(comments: CommentRow[], task: string): Thread[] {
  const ofTask = comments.filter((c) => c.task_id === task);
  const roots = ofTask.filter((c) => c.kind === "comment");
  return roots.map((root) => ({
    root,
    replies: ofTask.filter(
      (c) => c.kind === "reply" && c.parent_id === root.comment_id,
    ),
  }));
}
