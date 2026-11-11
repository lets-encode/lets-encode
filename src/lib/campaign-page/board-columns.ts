// The campaign page's board, derived from the tracking tables: the pieces
// the tasks address, the four rendered lanes and the filters over them, the
// per-piece counts of the piece rail, and the volunteer's standing line.

import type { BoardCard, BoardColumn, ColumnKey } from "../campaign-board.ts";
import { findRow } from "../campaign-tables.ts";
import type {
  HistoryRow,
  LockRow,
  PieceRef,
  TaskRow,
} from "../campaign-tables.ts";

/** The stats bar's board filter: every task, or only the claimable ones. */
export type BoardScope = "all" | "open";

/** Fragment path → not-done tasks per board category. */
export type RailCounts = Map<
  string,
  { open: number; encoding: number; validation: number }
>;

/** Fragment path → tasks done / tasks total. */
export type PieceProgress = Map<string, { done: number; total: number }>;

// The scores a viewer can read end to end: the pieces the tasks address,
// named from the campaign's config where it names them.
export function previewPiecesOf(
  taskDefs: TaskRow[],
  pieces: PieceRef[],
): PieceRef[] {
  const paths = [
    ...new Set(
      taskDefs
        .filter((t) => t.subtask_id === "" && t.fragment)
        .map((t) => t.fragment),
    ),
  ];
  return paths.map((path) => {
    const piece = pieces.find((p) => p.path === path);
    return { id: piece?.id ?? path, path, title: piece?.title ?? "" };
  });
}

// Only the tasks someone can act on right now: claimable encodings and
// validations with a free slot.
export const actionable = (c: BoardCard) =>
  c.column === "ready" ||
  (c.column === "validation" && c.slots.some((s) => s.key === "open"));

// Per-piece task progress, for the piece tiles.
export function pieceProgressOf(
  allCards: BoardCard[],
  taskDefs: TaskRow[],
): PieceProgress {
  const by: PieceProgress = new Map();
  for (const card of allCards) {
    const fragment = findRow(taskDefs, card.task, "")?.fragment ?? "";
    if (!fragment) continue;
    const p = by.get(fragment) ?? { done: 0, total: 0 };
    p.total++;
    if (card.column === "done") p.done++;
    by.set(fragment, p);
  }
  return by;
}

// Task id → index into the preview pieces, for grouping and tinting by piece.
export function pieceIndexByTaskOf(
  previewPieces: PieceRef[],
  taskDefs: TaskRow[],
): Map<string, number> {
  const index = new Map(previewPieces.map((p, i) => [p.path, i]));
  const by = new Map<string, number>();
  for (const t of taskDefs)
    if (t.subtask_id === "") by.set(t.task_id, index.get(t.fragment) ?? 0);
  return by;
}

// Tasks with unresolved fails or open comments, behind the hero's
// attention count.
export const attentionCardsOf = (allCards: BoardCard[]) =>
  allCards.filter(
    (c) => c.column !== "done" && c.counts.fails + c.counts.comments > 0,
  );

// Unresolved fails and comments per piece, for the rail.
export function attentionByPieceOf(
  attentionCards: BoardCard[],
  previewPieces: PieceRef[],
  pieceIndexByTask: Map<string, number>,
): Map<string, number> {
  const by = new Map<string, number>();
  for (const c of attentionCards) {
    const path = previewPieces[pieceIndexByTask.get(c.task) ?? 0]?.path;
    if (!path) continue;
    by.set(path, (by.get(path) ?? 0) + c.counts.fails + c.counts.comments);
  }
  return by;
}

// Tasks per board category for each piece, shown on its rail row. Ready and
// blocked share the board's Open column.
export function railCountsOf(
  allCards: BoardCard[],
  boardScope: BoardScope,
  previewPieces: PieceRef[],
  pieceIndexByTask: Map<string, number>,
): RailCounts {
  const by: RailCounts = new Map();
  for (const c of allCards) {
    if (c.column === "done") continue;
    // The Claimable filter counts what the board then shows.
    if (boardScope === "open" && !actionable(c)) continue;
    const path = previewPieces[pieceIndexByTask.get(c.task) ?? 0]?.path;
    if (!path) continue;
    const n = by.get(path) ?? { open: 0, encoding: 0, validation: 0 };
    if (c.column === "encoding") n.encoding++;
    else if (c.column === "validation") n.validation++;
    else n.open++;
    by.set(path, n);
  }
  return by;
}

// The board rendered as four columns: queued-but-blocked tasks share the
// Open column (dimmed, with what they wait for) instead of a fifth column.
export function displayColumnsOf(columns: BoardColumn[]): BoardColumn[] {
  const by = new Map(columns.map((c) => [c.key, c]));
  const ready = by.get("ready");
  const blocked = by.get("blocked");
  const encoding = by.get("encoding");
  const validation = by.get("validation");
  const done = by.get("done");
  return [
    {
      key: "ready" as ColumnKey,
      label: "Open",
      cards: [...(ready?.cards ?? []), ...(blocked?.cards ?? [])],
    },
    {
      key: "encoding" as ColumnKey,
      label: "Encoding",
      cards: encoding?.cards ?? [],
    },
    {
      key: "validation" as ColumnKey,
      label: "Review",
      cards: validation?.cards ?? [],
    },
    {
      key: "done" as ColumnKey,
      label: "Done",
      cards: done?.cards ?? [],
    },
  ];
}

// The rail's selection filters the rendered columns to one piece; the
// stats-bar toggle keeps only the claimable cards. Every column stays in
// view, however empty the filters leave it.
export function scopeColumns(
  displayColumns: BoardColumn[],
  selectedPiece: "all" | string,
  boardScope: BoardScope,
  previewPieces: PieceRef[],
  pieceIndexByTask: Map<string, number>,
): BoardColumn[] {
  let cols = displayColumns;
  if (selectedPiece !== "all")
    cols = cols.map((col) => ({
      ...col,
      cards: col.cards.filter(
        (c) =>
          previewPieces[pieceIndexByTask.get(c.task) ?? 0]?.path ===
          selectedPiece,
      ),
    }));
  if (boardScope === "open")
    cols = cols.map((col) => ({
      ...col,
      cards: col.cards.filter(actionable),
    }));
  return cols;
}

// The Open column across every piece, under the board filter, for the
// rail's "All pieces" count.
export const railOpenCountOf = (
  displayColumns: BoardColumn[],
  boardScope: BoardScope,
) =>
  boardScope === "open"
    ? displayColumns[0].cards.filter(actionable).length
    : displayColumns[0].cards.length;

// The lane a card shows in on the narrow board: blocked cards share Open.
export const laneOf = (c: BoardCard | null): ColumnKey | null =>
  !c ? null : c.column === "blocked" ? "ready" : c.column;

// Without a pick, a task or a next task, the first lane holding cards:
// review, then encoding, then open, then done.
export const firstFilledLaneOf = (scopedColumns: BoardColumn[]): ColumnKey =>
  (["validation", "encoding", "ready", "done"] as ColumnKey[]).find((key) =>
    scopedColumns.some((c) => c.key === key && c.cards.length > 0),
  ) ?? "ready";

// The viewer's own standing in this campaign: tasks they encoded that are
// done, tasks they hold a claim on, and reviews they hold a slot in.
export function volStandingOf(
  viewer: string,
  history: HistoryRow[],
  allCards: BoardCard[],
  locks: LockRow[],
): string {
  if (viewer === "") return "";
  const encoded = new Set(
    history
      .filter(
        (h) =>
          h.user_id === viewer &&
          h.action === "submit_encoding" &&
          h.outcome === "accepted",
      )
      .map((h) => h.task_id),
  );
  const done = allCards.filter(
    (c) => c.column === "done" && encoded.has(c.task),
  ).length;
  const claimed = locks.filter(
    (l) => l.user_id === viewer && l.kind !== "validation",
  ).length;
  const reviewing = locks.filter(
    (l) => l.user_id === viewer && l.kind === "validation",
  ).length;
  // A newcomer has nothing to count yet; the line appears with the first.
  if (!done && !claimed && !reviewing) return "";
  const parts = [`${done} done`, `${claimed} claimed`];
  if (reviewing) parts.push(`${reviewing} reviewing`);
  return `You: ${parts.join(" · ")}`;
}
