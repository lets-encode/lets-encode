// The task projection: a pure projection of the tracking tables into per-task
// display state — status keys, validation slots and the viewer's next step.
// No authoritative state lives here — everything derives from task.csv,
// state.csv, lock.csv and config.yaml, so the projection re-derives on every
// table refresh. No Svelte, no GitHub.

import { isPassVerdict } from "./campaign-tables.ts";
import { claimRefusal, waitsFor } from "./campaign-claim.ts";
import type { TaskRow, StateRow, LockRow } from "./campaign-tables.ts";

/**
 * Numeric account id → current login. The tables key people by their stable
 * numeric id; the console resolves logins for display and passes them in. An
 * unresolved id falls back to showing the id itself.
 */
export type Logins = Record<string, string>;

/** The display handle for a stored user id: its login, or the id if unresolved. */
export const handle = (logins: Logins, id: string): string => logins[id] || id;

/** The tables (and config) the projection is derived from. */
export interface GraphData {
  taskDefs: TaskRow[];
  rows: StateRow[];
  validationColumns: string[];
  locks: LockRow[];
  passThreshold: number;
  /** validation.allow_self_validation from config.yaml: the encoder may validate their own work. */
  allowSelfValidation?: boolean;
}

/** Status keys shared by node pills, chips and the tables view. */
export type StatusKey =
  | "completed"
  | "encoding_required"
  | "encoding"
  | "claimed"
  | "validation_required"
  | "pending"
  | "blocked"
  | "pass"
  | "review"
  | "open";

// The statuses state.csv holds on a task row.
const TASK_STATUSES = new Set<string>([
  "encoding_required",
  "validation_required",
  "completed",
]);

/** One validation slot on its task node. */
export interface NodeSlot {
  sub: string;
  slot: number;
  key: StatusKey;
  label: string;
  who: string;
  running: boolean;
  /** The slot is open and the encoding is in — it can be claimed for review. */
  claimable: boolean;
  /** The slot is open and the viewer may not review it: they encoded the
      task or already recorded a verdict on it. */
  needsAnother: boolean;
  /** The stored user id behind the slot (verdict author or lock holder); '' when open. */
  user: string;
  /** The verdict's or lock's timestamp; '' when open. */
  ts: string;
}

/** One task's projected display state. */
export interface TaskNode {
  task: string;
  kind: "pre" | "encode";
  statusKey: StatusKey;
  slots: NodeSlot[];
  passes: number;
  threshold: number;
  /** The first node the viewer can act on right now. */
  nextUp: boolean;
}

/**
 * Whether a task is a pre-task: score setup (the score's staves, clefs, key
 * signature and meter, filled in the setup editor), measure correction
 * (`measure-zones`, or `omr-layout` for an OMR-prepared piece, which also
 * corrects the staff boxes; both in the zone editor) or encoding alignment
 * (`encoding-align`: an uploaded encoding's measures placed in the corrected
 * ones, in the alignment editor). Encoding tasks — whole-file
 * (empty locator) and per-page (`surface-N`) — are not pre-tasks and use
 * mei-friend.
 */
export function isPreTask(locator: string): boolean {
  return Object.hasOwn(PRE_TASKS, locator);
}

/** A task's work stage. */
export type WorkStage =
  | "score setup"
  | "measure correction"
  | "encoding alignment"
  | "encoding";

/** What the app knows of each kind of pre-task: the route segment of its own
    editor, its work stage, its name, and what it asks for, briefly (the
    board's card) and in full (the task box). */
const PRE_TASKS: Record<
  string,
  {
    route: "setup" | "zones" | "align";
    stage: WorkStage;
    name: string;
    brief: string;
    full: string;
  }
> = {
  "score-setup": {
    route: "setup",
    stage: "score setup",
    name: "Score setup",
    brief:
      "Copy the staves, clefs, key signature and time signature from the source's first measure.",
    full: "Copy the staves, clefs, key signature and time signature from the source's first measure, shown with its staves level with the preview's; the divider between them resizes the two. In step 2, mark each brace or bracket by clicking or tapping its first and last staff in the preview.",
  },
  "omr-layout": {
    route: "zones",
    stage: "measure correction",
    name: "Measure correction",
    brief:
      "Check the staff boxes, then the grand staves, then the measures on each page and correct the wrong ones.",
    full: "Check the staff boxes, then the grand staves, then the measures on each page and correct the wrong ones.",
  },
  "measure-zones": {
    route: "zones",
    stage: "measure correction",
    name: "Measure correction",
    brief: "Check the measure boxes on each page and correct the wrong ones.",
    full: "Check the measure boxes on each page and correct the wrong ones.",
  },
  "encoding-align": {
    route: "align",
    stage: "encoding alignment",
    name: "Encoding alignment",
    brief:
      "Check which measure of the uploaded encoding each measure box received and correct the wrong ones.",
    full: "Check which measure of the uploaded encoding each measure box received and correct the wrong ones.",
  },
};

/** What a pre-task asks for, briefly or in full; '' for any other locator. */
export function preTaskInstruction(locator: string, full = false): string {
  if (!isPreTask(locator)) return "";
  return full ? PRE_TASKS[locator].full : PRE_TASKS[locator].brief;
}

/** The console route segment a pre-task's own editor lives under. */
export function preTaskRoute(locator: string): string {
  return isPreTask(locator) ? PRE_TASKS[locator].route : "zones";
}

/** The console route of a pre-task's own editor. */
export const preTaskHref = (
  campaign: string,
  locator: string,
  task: string,
): string => `/${campaign}/${preTaskRoute(locator)}/${task}`;

/** Where a review of the task happens: a pre-task's own editor, else the review view. */
export const reviewHref = (
  campaign: string,
  locator: string,
  task: string,
): string =>
  isPreTask(locator)
    ? preTaskHref(campaign, locator, task)
    : `/${campaign}/review/${task}`;

/** A task's work stage from its locator; a send-back returns the task to it. */
export const workStage = (locator: string): WorkStage =>
  isPreTask(locator) ? PRE_TASKS[locator].stage : "encoding";

/** Where a task's work happens: mei-friend for an encoding, the pre-task's own page otherwise. */
export const workPlace = (locator: string): string =>
  isPreTask(locator) ? workStage(locator) : "mei-friend";

/**
 * The button label that claims a task: an encoding also opens mei-friend, a
 * different site, so its label says so.
 */
export const claimLabel = (locator: string): string =>
  isPreTask(locator)
    ? `Claim & open ${workStage(locator)}`
    : "Claim & open in mei-friend";

/** What the viewer is about to do with a task: claim its encoding (or
    pre-task), continue the one they hold, claim a review, or continue it. */
export type TaskActionMode =
  | "claim"
  | "continue"
  | "claim-review"
  | "continue-review";

/** A task's main button: its label, its tooltip, where it leads and the
    stage whose colour it takes. */
export interface TaskAction {
  label: string;
  title: string;
  /** mei-friend (another site, opened by the editor command), the score
      check, a pre-task's own editor, or the review view. */
  target: "mei-friend" | "check" | "pre" | "review";
  stage: "enc" | "pre" | "review";
}

/**
 * The main button for `task` in `mode`, the same wherever a task is offered.
 * A pre-task is worked on and reviewed in its own editor; an encoding that
 * starts with a check of the score definition (checksOpening) goes through
 * the score check, any other encoding to mei-friend.
 */
export function taskAction(
  task: { locator: string; pre: boolean; checksOpening: boolean },
  mode: TaskActionMode,
): TaskAction {
  const place = workPlace(task.locator);
  if (mode === "claim-review")
    return {
      label: "Claim to review",
      title: task.pre
        ? `Claims a review of this task for you and opens the ${place}.`
        : "Claims a review of this task for you and opens the review.",
      target: task.pre ? "pre" : "review",
      stage: "review",
    };
  if (mode === "continue-review")
    return task.pre
      ? {
          label: `Continue in ${place}`,
          title: `Opens the ${place} to review the submitted work.`,
          target: "pre",
          stage: "review",
        }
      : {
          label: "Continue in review",
          title:
            "Opens the review view: score and facsimile side by side, with the Approve and Request changes buttons.",
          target: "review",
          stage: "review",
        };
  const claim = mode === "claim";
  if (task.pre)
    return {
      label: claim ? claimLabel(task.locator) : `Continue in ${place}`,
      title: claim
        ? `Claims this task for you and opens the ${place}.`
        : `Opens the ${place} of the task you hold.`,
      target: "pre",
      stage: "pre",
    };
  if (task.checksOpening)
    return {
      label: claim ? "Claim & open score check" : "Continue in score check",
      title: claim
        ? "Claims this task for you and opens the score check of the clefs, key signatures, meter and transpositions, before the draft opens in mei-friend."
        : "Opens the score check of the task you hold, which opens the draft in mei-friend.",
      target: "check",
      stage: "enc",
    };
  return {
    label: claim ? claimLabel(task.locator) : "Continue in mei-friend",
    title: claim
      ? "Claims this task for you and opens the score in mei-friend."
      : "Opens the task you hold in mei-friend. Completing it there submits it for review.",
    target: "mei-friend",
    stage: "enc",
  };
}

/** The app page a task's button leads to; null for mei-friend, which the
    editor command opens. */
export function taskActionHref(
  campaign: string,
  task: { task: string; locator: string },
  action: TaskAction,
): string | null {
  if (action.target === "pre")
    return preTaskHref(campaign, task.locator, task.task);
  if (action.target === "check") return `/${campaign}/check/${task.task}`;
  if (action.target === "review") return `/${campaign}/review/${task.task}`;
  return null;
}

/**
 * How many pass verdicts complete a task: the per-subtask threshold times its
 * subtask count. A task without validation subtasks has a threshold of 0 — it
 * completes on its accepted submission, with no validation record.
 */
export const taskThreshold = (
  passThreshold: number,
  subtaskCount: number,
): number => passThreshold * subtaskCount;

/** The page number of a per-page (`surface-N`) locator; null for any other. */
export function pageOfLocator(locator: string): number | null {
  const m = /^surface-(\d+)$/.exec(locator);
  return m ? Number(m[1]) : null;
}

/** What the task asks for, from its locator. An encoding task is called
    "Encode" whether it starts from scratch or from a recognised draft. */
export function taskDescription(locator: string): string {
  return isPreTask(locator) ? PRE_TASKS[locator].name : "Encode";
}

/** The part of the piece a task covers ("p. 3"); '' for the whole piece. */
export function taskScope(locator: string): string {
  const page = pageOfLocator(locator);
  return page === null ? "" : `p. ${page}`;
}

/** A task's name without its piece: description, then scope. */
export function taskName(locator: string): string {
  const scope = taskScope(locator);
  const description = taskDescription(locator);
  return scope ? `${description} · ${scope}` : description;
}

// ---------------------------------------------------------------------------
// Table lookups. The tables arrive as freshly parsed arrays on every refresh,
// so each index is built once per array (keyed on array identity) and every
// lookup after it is O(1). The contract this relies on: parsed table arrays
// are replaced, never mutated in place.

const defIndexes = new WeakMap<TaskRow[], Map<string, TaskRow>>();
function taskDefIndex(defs: TaskRow[]): Map<string, TaskRow> {
  let index = defIndexes.get(defs);
  if (!index) {
    index = new Map();
    for (const t of defs) if (t.subtask_id === "") index.set(t.task_id, t);
    defIndexes.set(defs, index);
  }
  return index;
}

const stateIndexes = new WeakMap<
  StateRow[],
  { main: Map<string, StateRow>; subs: Map<string, StateRow[]> }
>();
function stateIndex(rows: StateRow[]) {
  let index = stateIndexes.get(rows);
  if (!index) {
    index = { main: new Map(), subs: new Map() };
    for (const r of rows) {
      if (r.subtask_id === "") index.main.set(r.task_id, r);
      else {
        const list = index.subs.get(r.task_id);
        if (list) list.push(r);
        else index.subs.set(r.task_id, [r]);
      }
    }
    stateIndexes.set(rows, index);
  }
  return index;
}

const lockIndexes = new WeakMap<LockRow[], Map<string, LockRow[]>>();
function lockIndex(locks: LockRow[]): Map<string, LockRow[]> {
  let index = lockIndexes.get(locks);
  if (!index) {
    index = new Map();
    for (const l of locks) {
      const key = `${l.task_id}|${l.subtask_id}|${l.kind}`;
      const list = index.get(key);
      if (list) list.push(l);
      else index.set(key, [l]);
    }
    lockIndexes.set(locks, index);
  }
  return index;
}

const taskDef = (d: GraphData, task: string) =>
  taskDefIndex(d.taskDefs).get(task);
const taskState = (d: GraphData, task: string) =>
  stateIndex(d.rows).main.get(task);
const subRowsOf = (d: GraphData, task: string) =>
  stateIndex(d.rows).subs.get(task) ?? [];

const encodingLock = (d: GraphData, task: string) =>
  lockIndex(d.locks).get(`${task}||encoding`)?.[0];
// Table order is preserved per key, which the slot assignment relies on.
const validationLocks = (d: GraphData, task: string, sub: string) =>
  lockIndex(d.locks).get(`${task}|${sub}|validation`) ?? [];

/**
 * Whether `viewer` may claim the task (`sub` '') or a review of its subtask
 * `sub` now, by the rule the campaign automation decides claims with.
 */
export function canClaim(
  d: GraphData,
  viewer: string,
  task: string,
  sub = "",
): boolean {
  return (
    viewer !== "" &&
    claimRefusal({
      tasks: d.taskDefs,
      state: d,
      locks: d.locks,
      intent: {
        task_id: task,
        subtask_id: sub,
        kind: sub ? "validation" : "encoding",
      },
      author: viewer,
      allowSelfValidation: d.allowSelfValidation,
      passThreshold: d.passThreshold,
    }) === null
  );
}

/** The incomplete task this task waits for (task.csv depends_on), or ''. */
export const blockedBy = (d: GraphData, task: string): string =>
  waitsFor(taskDef(d, task)?.depends_on, (t) => taskState(d, t)?.status);

const isEncoded = (status: string) =>
  status === "validation_required" || status === "completed";

const cellsOf = (d: GraphData, row: StateRow) =>
  d.validationColumns.map((c) => row[c] ?? "");
const passesOf = (d: GraphData, row: StateRow) =>
  cellsOf(d, row).filter(isPassVerdict).length;

// Validation locks do not carry a slot number. Assign them in table order to
// the still-empty validation cells, which is the same order submissions fill.
const validationLockForSlot = (d: GraphData, row: StateRow, slot: number) => {
  const cells = cellsOf(d, row);
  if (cells[slot] !== "") return undefined;
  const emptyIndex = cells.slice(0, slot).filter((cell) => cell === "").length;
  return validationLocks(d, row.task_id, row.subtask_id)[emptyIndex];
};

const nextUnreservedSlot = (d: GraphData, row: StateRow): number =>
  cellsOf(d, row).findIndex(
    (cell, slot) => cell === "" && !validationLockForSlot(d, row, slot),
  );

// Whether `viewer` already recorded a pass on this subtask row. One
// verdict per person (unless self-validation is allowed), matching checkClaim.
const hasVerdictBy = (d: GraphData, row: StateRow, viewer: string): boolean =>
  cellsOf(d, row).some(
    (cell) => isPassVerdict(cell) && cell.split("|")[1] === viewer,
  );

// The main node's status key: blocked wins, then a held encoding lock, then
// the state.csv status itself. A claimed facsimile pre-task (measure
// correction) reads as 'claimed' rather than 'encoding' — the work is a
// correction on the facsimile, not an encoding pass.
function mainStatusKey(d: GraphData, task: string): StatusKey {
  if (blockedBy(d, task)) return "blocked";
  const status = taskState(d, task)?.status ?? "pending";
  if (status === "encoding_required" && encodingLock(d, task)) {
    return isPreTask(taskDef(d, task)?.locator ?? "") ? "claimed" : "encoding";
  }
  if (TASK_STATUSES.has(status)) return status as StatusKey;
  return "pending";
}

/** One validation slot's derived display state. */
interface SlotState {
  key: StatusKey;
  sub: string;
  running: boolean;
  user: string;
  ts: string;
  needsAnother?: boolean;
}

// The slot's state from its validate_status cell: a pass renders solid,
// active locks occupy separate empty slots, and the rest are open.
// `viewer` tailors the open-slot text: the encoder — and a validator who
// already recorded a verdict on the subtask — sees that another volunteer is
// needed rather than a claim prompt.
function slotState(
  d: GraphData,
  row: StateRow,
  slot: number,
  viewer = "",
  logins: Logins = {},
): SlotState {
  const cell = cellsOf(d, row)[slot] ?? "";
  if (isPassVerdict(cell)) {
    const [, user, ts] = cell.split("|");
    return {
      key: "pass",
      sub: `@${handle(logins, user)} · approved`,
      running: false,
      user,
      ts,
    };
  }
  if (cell !== "") {
    return {
      key: "pending",
      sub: "invalid review data",
      running: false,
      user: "",
      ts: "",
    };
  }
  const lock = validationLockForSlot(d, row, slot);
  if (lock) {
    return {
      key: "review",
      sub: `@${handle(logins, lock.user_id)} · in review`,
      running: true,
      user: lock.user_id,
      ts: lock.timestamp,
    };
  }
  const taskStatus = taskState(d, row.task_id);
  const waiting = !isEncoded(taskStatus?.status ?? "");
  const locator = taskDef(d, row.task_id)?.locator ?? "";
  // The slot needs someone else: the viewer encoded the task or already
  // recorded a verdict on this subtask (unless self-validation is allowed).
  const needsAnother =
    viewer !== "" &&
    !d.allowSelfValidation &&
    (taskStatus?.encoder === viewer || hasVerdictBy(d, row, viewer));
  return {
    key: "open",
    sub: waiting
      ? `waiting for ${workStage(locator)}`
      : needsAnother
        ? "open — needs another volunteer"
        : "open — claim to review",
    running: false,
    user: "",
    ts: "",
    needsAnother,
  };
}

/**
 * Project the tables into one node per task, in task.csv order. `viewer` is
 * only used to pick the "next up" node — the first one the viewer can act on.
 */
export function buildGraph(
  d: GraphData,
  viewer = "",
  logins: Logins = {},
): TaskNode[] {
  const reqVal = d.validationColumns.length;
  const defs = d.taskDefs.filter((t) => t.subtask_id === "");
  const nodes: TaskNode[] = [];

  let nextUpTaken = false;
  for (const def of defs) {
    const task = def.task_id;
    const statusKey = mainStatusKey(d, task);
    const subRows = subRowsOf(d, task);

    const slots: NodeSlot[] = subRows.flatMap((row) =>
      Array.from({ length: reqVal }, (_, slot) => {
        const s = slotState(d, row, slot, viewer, logins);
        return {
          sub: row.subtask_id,
          slot,
          key: s.key,
          label: `${row.subtask_id}·${slot + 1}`,
          who: s.sub,
          running: s.running,
          // The slot a claim would take, when the viewer may claim one.
          claimable:
            slot === nextUnreservedSlot(d, row) &&
            canClaim(d, viewer, row.task_id, row.subtask_id),
          needsAnother: s.needsAnother ?? false,
          user: s.user,
          ts: s.ts,
        };
      }),
    );

    // The viewer's next step: work they already hold, else the first open
    // claim (encoding, or a validation they are allowed to take).
    const mineLock =
      viewer !== "" &&
      d.locks.some((l) => l.task_id === task && l.user_id === viewer);
    const claimableEncoding = canClaim(d, viewer, task);
    const claimableValidation = slots.some((slot) => slot.claimable);
    const nextUp =
      viewer !== "" &&
      !nextUpTaken &&
      (mineLock || claimableEncoding || claimableValidation);
    if (nextUp) nextUpTaken = true;

    nodes.push({
      task,
      kind: isPreTask(def.locator) ? "pre" : "encode",
      statusKey,
      slots,
      passes: subRows.reduce((n, r) => n + passesOf(d, r), 0),
      threshold: taskThreshold(d.passThreshold, subRows.length),
      nextUp,
    });
  }
  return nodes;
}
