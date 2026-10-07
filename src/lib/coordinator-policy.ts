import {
  COMMENT_COLUMNS,
  parseCsv,
  COMMENT_PATH,
  LOCK_PATH,
  STATE_PATH,
} from "./campaign-tables.ts";
import type { CommentRow, HistoryRow, TaskRow } from "./campaign-tables.ts";
import type { CommandEnvelope } from "./command-envelope.ts";

export type PullRequestKind =
  | "claim"
  | "review_edit"
  | "validation"
  | "comment"
  | "encoding";

/**
 * One quoted scalar field (`kind`, `preparation`, …) of the config.yaml piece
 * whose path is `path`, or null when no piece carries the path or the piece
 * has no such field. Reads the canonical shape configToYaml emits — each
 * piece entry opens with `- id:` and lists its fields as quoted scalars — so
 * the coordinator and the console need no YAML parser.
 */
export function pieceFieldForPath(
  configText: string | null,
  path: string,
  key: string,
): string | null {
  for (const entry of (configText ?? "").split(/^\s*- id:/m).slice(1)) {
    const entryPath = /^\s*path:\s*"((?:[^"\\]|\\.)*)"/m.exec(entry);
    if (!entryPath || JSON.parse(`"${entryPath[1]}"`) !== path) continue;
    const value = new RegExp(
      `^\\s*${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`,
      "m",
    ).exec(entry);
    return value ? JSON.parse(`"${value[1]}"`) : null;
  }
  return null;
}

/**
 * The kind of the piece at `path`: a physical piece's page spans are joined
 * wholesale, a facsimile piece's measures are matched by id.
 */
export function pieceKindForPath(
  configText: string | null,
  path: string,
): string | null {
  return pieceFieldForPath(configText, path, "kind");
}

/** Return the sole added CSV row in a patch that removes no rows. */
export function addedRowFromPatch(patch: string | undefined): string | null {
  if (!patch) return null;
  const added: string[] = [];
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed++;
  }
  return removed === 0 && added.length === 1 ? added[0] : null;
}

// The single row a release patch removes — the shape of a PR giving a claim
// back — or null for any other diff (additions, several removals, no patch).
export function removedRowFromPatch(patch: string | undefined): string | null {
  if (!patch) return null;
  const removed: string[] = [];
  let added = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("-")) removed.push(line.slice(1));
    else if (line.startsWith("+")) added++;
  }
  return added === 0 && removed.length === 1 ? removed[0] : null;
}

// The CSV records a unified-diff patch removes and adds, parsed with full CSV
// quoting (a quoted field may span several patch lines; the physical lines of
// one record are contiguous within their +/- group). Null when there is no
// patch at all.
function csvRowsFromPatch(
  patch: string | undefined,
): { added: string[][]; removed: string[][] } | null {
  if (!patch) return null;
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of patch.split("\n")) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("\\")
    )
      continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return {
    added: parseCsv(added.join("\n")),
    removed: parseCsv(removed.join("\n")),
  };
}

/**
 * The sole changed cell a state.csv patch carries — the shape a verdict PR
 * has, relative to the PR's own merge base — or null for any other diff.
 * The cell index is mapped to a column name via `header` (the current state
 * header; the base columns and validation slots are positionally stable).
 */
export function validationIntentFromPatch(
  patch: string | undefined,
  header: string[],
): {
  task_id: string;
  subtask_id: string;
  column: string;
  value: string;
} | null {
  const rows = csvRowsFromPatch(patch);
  if (!rows || rows.added.length !== 1 || rows.removed.length !== 1)
    return null;
  const [base] = rows.removed;
  const [head] = rows.added;
  if (
    (head[0] ?? "") === "" ||
    base[0] !== head[0] ||
    (base[1] ?? "") !== (head[1] ?? "")
  )
    return null;
  const width = Math.max(base.length, head.length, header.length);
  let diff: { column: string; value: string } | null = null;
  for (let i = 0; i < width; i++) {
    if ((base[i] ?? "") === (head[i] ?? "")) continue;
    if (diff || i >= header.length) return null;
    diff = { column: header[i], value: head[i] ?? "" };
  }
  return diff ? { task_id: head[0], subtask_id: head[1] ?? "", ...diff } : null;
}

export function validationVerdict(value: string): "pass" | "fail" | null {
  return value === "pass" || value === "fail" ? value : null;
}

/**
 * The rows a comment.csv patch appends — the shape a comment PR carries,
 * relative to the PR's own merge base — or null when it removes or edits
 * anything.
 */
export function appendedCommentsFromPatch(
  patch: string | undefined,
): CommentRow[] | null {
  const rows = csvRowsFromPatch(patch);
  if (!rows || rows.removed.length !== 0 || rows.added.length === 0)
    return null;
  return rows.added.map(
    (cells) =>
      Object.fromEntries(
        COMMENT_COLUMNS.map((column, i) => [column, cells[i] ?? ""]),
      ) as unknown as CommentRow,
  );
}

const RESOLVED_CELL = COMMENT_COLUMNS.indexOf("resolved");
const PARENT_CELL = COMMENT_COLUMNS.indexOf("parent_id");

/**
 * The top-level comment a comment.csv patch resolves — every changed row only
 * flips `resolved` '' → 'true', and exactly one of them is top-level (empty
 * parent_id) — or null for any other diff. Flipped replies ride along; the
 * coordinator resolves the root's whole thread authoritatively. Rows whose
 * cells are unchanged (a rewrite that only adds empty trailing cells) and the
 * header row are not changes; the coordinator writes its own header.
 */
export function resolvedCommentFromPatch(
  patch: string | undefined,
): { comment_id: string } | null {
  const rows = csvRowsFromPatch(patch);
  if (
    !rows ||
    rows.added.length === 0 ||
    rows.added.length !== rows.removed.length
  )
    return null;
  let root: string | null = null;
  for (let i = 0; i < rows.added.length; i++) {
    const base = rows.removed[i];
    const head = rows.added[i];
    if ((head[0] ?? "") === "" || (base[0] ?? "") !== (head[0] ?? ""))
      return null;
    if (head[0] === COMMENT_COLUMNS[0]) continue;
    const width = Math.max(base.length, head.length);
    if (
      Array.from({ length: width }).every(
        (_, j) => (base[j] ?? "") === (head[j] ?? ""),
      )
    )
      continue;
    for (let j = 0; j < width; j++) {
      if ((base[j] ?? "") === (head[j] ?? "")) continue;
      if (
        j !== RESOLVED_CELL ||
        (base[j] ?? "") !== "" ||
        (head[j] ?? "") !== "true"
      )
        return null;
    }
    if ((head[PARENT_CELL] ?? "") === "") {
      if (root !== null) return null;
      root = head[0];
    }
  }
  return root === null ? null : { comment_id: root };
}

/**
 * The task an encoding submission is for: the task its command envelope
 * names, else the one its head branch names (`encode-<task_id>`). The changed
 * files are not consulted — an encoding completed without changes has none;
 * the boundary check confines them to the resolved task's files.
 */
export function resolveEncodingTask(options: {
  tasks: TaskRow[];
  envelope: CommandEnvelope | null;
  headRef: string;
}): TaskRow | undefined {
  const { tasks, envelope, headRef } = options;
  const named =
    String(envelope?.input?.task_id ?? "") ||
    (headRef.startsWith("encode-") ? headRef.slice("encode-".length) : "");
  return named
    ? tasks.find((task) => task.subtask_id === "" && task.task_id === named)
    : undefined;
}

/**
 * Whether a pull request changes a tracking table or a source — the paths the
 * campaign workflow triggers on; any other pull request is not a campaign
 * operation.
 */
export function touchesCampaignPaths(changedPaths: string[]): boolean {
  return changedPaths.some(
    (p) => p.startsWith("tracking/") || p.startsWith("sources/"),
  );
}

export function classifyPullRequest(changedPaths: string[]): PullRequestKind {
  // A switch from review to editing gives up the review lock and carries the
  // fail comment.
  if (changedPaths.includes(LOCK_PATH) && changedPaths.includes(COMMENT_PATH))
    return "review_edit";
  if (changedPaths.includes(LOCK_PATH)) return "claim";
  if (changedPaths.includes(STATE_PATH)) return "validation";
  if (changedPaths.includes(COMMENT_PATH)) return "comment";
  return "encoding";
}

/**
 * Whether the author's current encoding claim on the task came from a switch
 * from review to editing: the task's latest accepted encoding claim or
 * review edit is the author's review edit.
 */
export function isReviewEdit(
  history: HistoryRow[],
  task_id: string,
  author: string,
): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.task_id !== task_id || h.outcome !== "accepted") continue;
    if (h.action === "review_edit") return h.user_id === author;
    if (h.action === "claim_encoding") return false;
  }
  return false;
}

/** The campaign branch holding the unsubmitted work of a task's expired claims. */
export const keptWorkBranch = (task_id: string): string => `wip-${task_id}`;

/**
 * Whether a commit on a task branch was made by the console rather than by
 * the claimer: an OMR page draft, the start from kept work, or the commit of
 * a task completed without changes.
 */
export const isAutomaticCommit = (message: string): boolean =>
  /^(Transcription draft of page |Let's Encode: )/.test(message);

/**
 * The pull request that gave `user_id` their current encoding claim on the
 * task — a claim or a review edit — as a number; null when the history has
 * none.
 */
export function claimPullRequest(
  history: HistoryRow[],
  task_id: string,
  user_id: string,
): number | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (
      h.task_id === task_id &&
      h.user_id === user_id &&
      h.outcome === "accepted" &&
      (h.action === "claim_encoding" || h.action === "review_edit")
    )
      return h.pr ? Number(h.pr) : null;
  }
  return null;
}

/**
 * The expired claims whose unsubmitted work the task carries: the
 * `released_with_work` rows since the task's last accepted submission or
 * review edit, oldest first.
 */
export function keptWorkSince(
  history: HistoryRow[],
  task_id: string,
): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.task_id !== task_id) continue;
    if (
      h.outcome === "accepted" &&
      ["submit_encoding", "review_edit"].includes(h.action)
    )
      break;
    if (h.action === "reap" && h.outcome === "released_with_work")
      rows.unshift(h);
  }
  return rows;
}

export function shouldCleanupSubmission(
  kind: "encoding" | "validation",
  accepted: boolean,
): boolean {
  return accepted || kind === "validation";
}

/**
 * The history row that decided pull request `prNumber`, or null when none
 * has. A pull request is one operation: a run that finds such a row reports
 * that decision instead of deciding the operation again.
 */
export function priorDecision(
  history: HistoryRow[],
  prNumber: number,
): HistoryRow | null {
  const pr = String(prNumber);
  for (let i = history.length - 1; i >= 0; i--)
    if (history[i].pr === pr) return history[i];
  return null;
}
