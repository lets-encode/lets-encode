import {
  COMMENT_COLUMNS,
  parseCsv,
  COMMENT_PATH,
  LOCK_PATH,
  STATE_PATH,
} from "./campaign-tables.ts";
import type {
  CommentRow,
  HistoryRow,
  LockRow,
  TaskRow,
} from "./campaign-tables.ts";
import type { CommandEnvelope } from "./command-envelope.ts";
import { MAX_ANCHOR_LENGTH, MAX_COMMENT_LENGTH } from "./campaign-submit.ts";

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
 * Whether a task of a piece prepared as `preparation` checks the piece's
 * opening score definition before its draft, and may change it (mei-page-splice spliceOpeningScoreDef): the
 * first page task of an 'omr-instruments' piece, the page task that depends
 * on the piece's layout task (planTasks).
 */
export function checksOpening(
  task: TaskRow,
  tasks: TaskRow[],
  preparation: string | null | undefined,
): boolean {
  return (
    task.locator.startsWith("surface-") &&
    preparation === "omr-instruments" &&
    tasks.some(
      (t) =>
        t.task_id === task.depends_on &&
        t.subtask_id === "" &&
        t.locator === "omr-layout",
    )
  );
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

// The lines of a unified diff from its first hunk on. Before the first "@@" a
// line starting with "+++" or "---" is a file header; inside a hunk it is an
// added or removed line whose text starts with "++" or "--".
function hunkLines(patch: string): string[] {
  const lines = patch.split("\n");
  const first = lines.findIndex((line) => line.startsWith("@@"));
  return first < 0
    ? lines.filter((line) => !line.startsWith("+++") && !line.startsWith("---"))
    : lines.slice(first);
}

/** Return the sole added CSV row in a patch that removes no rows. */
export function addedRowFromPatch(patch: string | undefined): string | null {
  if (!patch) return null;
  const added: string[] = [];
  let removed = 0;
  for (const line of hunkLines(patch)) {
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
  for (const line of hunkLines(patch)) {
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
  for (const line of hunkLines(patch)) {
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

/**
 * How long an operation branch without an open pull request is kept: the app
 * creates the branch and opens its pull request a moment later.
 */
export const OPERATION_BRANCH_GRACE_MS = 60 * 60_000;

// The branches the app opens operation pull requests from, each ending in a
// random suffix of eight hex digits.
const OPERATION_BRANCH =
  /^(claim|release|validate|review-edit|comment|setup|layout|zones)-.+-[0-9a-f]{8}$/;

/**
 * Whether a campaign branch is an operation branch left without a pull
 * request: its name is an operation branch's, no open pull request has it as
 * head, and its head commit is older than OPERATION_BRANCH_GRACE_MS. Task
 * branches (`encode-`) and kept work (`wip-`) never are.
 */
export function isLeftoverOperationBranch(
  branch: { name: string; committedAt: string },
  openHeads: Set<string>,
  now: number,
): boolean {
  return (
    OPERATION_BRANCH.test(branch.name) &&
    !openHeads.has(branch.name) &&
    now - Date.parse(branch.committedAt) > OPERATION_BRANCH_GRACE_MS
  );
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

/**
 * The latest submission made under the claim `lock` when it was rejected:
 * the holder's newest `submit_<kind>` row on the lock's task and subtask, if
 * it is newer than the accepted claim that gave them the lock (a
 * `claim_<kind>`, or for an encoding claim a review edit) and its outcome is
 * `rejected`. Null otherwise.
 */
export function rejectedSubmission(
  history: HistoryRow[],
  lock: LockRow,
): HistoryRow | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.task_id !== lock.task_id || h.user_id !== lock.user_id) continue;
    if (
      lock.kind === "encoding" &&
      h.action === "review_edit" &&
      h.outcome === "accepted"
    )
      return null;
    if (h.subtask_id !== lock.subtask_id) continue;
    if (h.action === `submit_${lock.kind}`)
      return h.outcome === "rejected" ? h : null;
    if (h.action === `claim_${lock.kind}` && h.outcome === "accepted")
      return null;
  }
  return null;
}

// Open non-draft pull requests one author may have on a campaign, counting
// the one being processed; beyond it a pull request is closed unprocessed and
// without a history row.
export const MAX_OPEN_PRS_PER_AUTHOR = 10;

// Explanations of the rejection codes, for the pull request comment and the
// app's task panel. The code itself stays in the comment and in the history
// row.
export const REASON_TEXT: Record<string, string> = {
  malformed_claim:
    "the submission does not add exactly one lock row or remove exactly one",
  malformed_validation: "the submission is not a single verdict",
  malformed_comment:
    "the submission does not append or resolve exactly one comment row",
  malformed_review_edit:
    "the submission does not remove exactly one review lock and add one comment",
  out_of_bounds:
    "the submission changes files outside the ones this operation may touch",
  invalid_kind: "unknown claim or comment kind",
  invalid_target: "the claim addresses the wrong row for its kind",
  unknown_task: "no such task",
  dependency_incomplete:
    "this task opens once the task it depends on is completed",
  wrong_state: "the task is not in the right state for this operation",
  already_locked: "someone already holds this claim",
  review_in_progress:
    "someone else is reviewing this task; reviews run one at a time",
  too_many_claims:
    "you hold as many claims as this campaign allows one person at once; submit or give back one of them first",
  self_validation: "the encoder cannot review their own work",
  already_validated: "this person already recorded a verdict on this subtask",
  no_open_validation_slot: "no review slot is open",
  not_lock_holder: "the author does not hold the required claim",
  claim_expired:
    "the author's claim had run out when the submission was opened",
  mei_invalid: "the submitted MEI failed the machine check",
  splice_invalid:
    "the page passes the machine check on its own but not joined into the score; this is an error of the platform, not of the encoding",
  invalid_verdict: "a review verdict must approve or request changes",
  fail_without_comment:
    "a change request must carry a note saying what needs to change",
  no_recorded_fail:
    "the task has no recorded change request to send it back for",
  not_permitted:
    "only a reviewer who requested changes or the campaign owner may do this",
  empty_comment: "the comment is empty",
  comment_too_long: `the comment is longer than ${MAX_COMMENT_LENGTH} characters`,
  invalid_anchor: `the comment's page or measures are longer than ${MAX_ANCHOR_LENGTH} characters, or its piece is not the path of an MEI file`,
  unknown_parent: "the reply's parent comment does not exist",
  invalid_parent:
    "a parent comment must be a top-level comment, and only replies carry one",
  unknown_comment: "no such comment",
  already_resolved: "the comment is already resolved",
  too_many_open_prs: `the author already has ${MAX_OPEN_PRS_PER_AUTHOR} open submissions on this campaign`,
};

/** The longest detail a rejection comment carries, in characters. */
export const MAX_REJECTION_DETAIL = 500;

/**
 * A rejection's detail as the pull request comment carries it: one line of at
 * most MAX_REJECTION_DETAIL characters, as inline code. The detail can quote
 * the fork's markup; as code, no mention, link or HTML in it is rendered.
 */
export function rejectionDetail(detail: string): string {
  const characters = Array.from(
    detail.replace(/[\u0000-\u001f\u007f]/g, " ").replaceAll("`", "'"),
  );
  const line = characters.slice(0, MAX_REJECTION_DETAIL).join("");
  return `\`${characters.length > MAX_REJECTION_DETAIL ? `${line}…` : line}\``;
}
