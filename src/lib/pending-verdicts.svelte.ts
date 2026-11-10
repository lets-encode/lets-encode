// Background verdicts for PR commands that return before the campaign
// automation has processed their PR. Each optimistic command registers an
// entry when its PR opens; the entry settles when the automation's verdict
// lands. The entries render task-anchored (TaskRunState.svelte); rejections
// additionally take the viewport over (PendingVerdicts.svelte, in the
// layout); pages hook their table refresh into onSettled. Processing entries
// are kept in sessionStorage, so the tab goes on following them after a
// reload (resume). Loading this module
// plugs the store into the command layer's verdict sink — commands.ts itself
// stays free of runes so the Node test runner can import it.

import { resumeFollowing, sameKey, setVerdictSink } from "./commands.ts";
import type { CommandContext, FollowedPr, PendingKey } from "./commands.ts";

export type PendingState =
  | "opening"
  | "processing"
  | "accepted"
  | "rejected"
  | "timeout";

export interface PendingVerdict {
  id: string;
  /** What was submitted, e.g. "Encoding of T0002". */
  label: string;
  /** 0 while the PR is still being opened in the background. */
  prNumber: number;
  prUrl: string;
  /** What the submission acts on. */
  key: PendingKey;
  /** The campaign repo the submission acts on. */
  repoId: number;
  owner: string;
  repo: string;
  /** The account the submission was made with. */
  viewer: string;
  state: PendingState;
  /** The verdict or error text once settled; '' while processing. */
  message: string;
  /** The automation run itself failed, so no verdict was reached. */
  runFailed: boolean;
}

/** The campaign repo a background command acts on. */
type Target = { repoId: number; owner: string; repo: string };

/** A processing entry as sessionStorage keeps it across a reload. */
interface StoredVerdict {
  id: string;
  label: string;
  key: PendingKey;
  target: Target;
  pr: FollowedPr;
  /** When the PR was opened, epoch milliseconds. */
  openedAt: number;
  viewer: string;
}

/** How long an accepted entry stays visible before it removes itself. */
const ACCEPTED_LINGER_MS = 6_000;

/** How long a task stays highlighted on the board after an accepted submission. */
const FINISHED_HIGHLIGHT_MS = 60_000;

/** Submission kinds that finish work on a task, as the board understands it. */
const FINISH_KINDS = new Set<PendingKey["kind"]>(["encode", "validate"]);

/** Discussion kinds: their run state renders at the comment or composer they
 * act on (CommentCard, CommentComposer), never on the task. */
const DISCUSSION_KINDS = new Set<PendingKey["kind"]>(["comment", "resolve"]);

const STORAGE_KEY = "lets-encode:pending-verdicts";

function readStored(): StoredVerdict[] {
  try {
    const parsed: unknown = JSON.parse(
      sessionStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    return Array.isArray(parsed) ? (parsed as StoredVerdict[]) : [];
  } catch {
    return [];
  }
}

function writeStored(records: StoredVerdict[]): void {
  try {
    if (records.length)
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* without storage a reload forgets the entries */
  }
}

class PendingVerdictStore {
  entries = $state<PendingVerdict[]>([]);
  /** Tasks an accepted encoding or validation of the viewer's just
   * moved on the board, per repo — each highlighted for a short while. Raw
   * state: the expiry timeout removes its mark by identity, which the deep
   * proxy of plain $state would break. */
  recentlyFinished = $state.raw<{ repoId: number; task: string }[]>([]);
  /** Called on every settle with the settled entry; pages refresh their tables
   * when it acts on their campaign. */
  private settledListeners = new Set<(entry: PendingVerdict) => void>();
  /** The account whose stored entries were resumed; '' until resume. */
  private resumedFor = "";

  /** Register a settle listener. Returns the unsubscribe. */
  onSettled(listener: (entry: PendingVerdict) => void): () => void {
    this.settledListeners.add(listener);
    return () => {
      this.settledListeners.delete(listener);
    };
  }

  begin(entry: {
    label: string;
    key: PendingKey;
    target: Target & { viewer: string };
    pr?: FollowedPr;
  }): string {
    const id = crypto.randomUUID().slice(0, 8);
    const { repoId, owner, repo, viewer } = entry.target;
    this.entries = [
      ...this.entries,
      {
        id,
        label: entry.label,
        prNumber: entry.pr?.number ?? 0,
        prUrl: entry.pr?.html_url ?? "",
        key: entry.key,
        repoId,
        owner,
        repo,
        viewer,
        state: entry.pr ? "processing" : "opening",
        message: "",
        runFailed: false,
      },
    ];
    if (entry.pr) this.#store(id, entry.pr);
    return id;
  }

  /** The background-opened PR exists now; the entry moves to 'processing'. */
  attachPr(id: string, pr: FollowedPr): void {
    this.entries = this.entries.map((e) =>
      e.id === id
        ? {
            ...e,
            prNumber: pr.number,
            prUrl: pr.html_url,
            state: "processing" as const,
          }
        : e,
    );
    this.#store(id, pr);
  }

  /** The entry acting on `taskId` — processing first, else the latest
   * settled one still on screen; null when the task has none. Drives the
   * task-anchored run state (TaskRunState.svelte). Task ids repeat across
   * campaigns, so the lookup names the campaign's `repoId`. */
  forTask(taskId: string, repoId: number): PendingVerdict | null {
    if (!taskId) return null;
    const mine = this.entries.filter(
      (e) =>
        e.key.task === taskId &&
        e.repoId === repoId &&
        !DISCUSSION_KINDS.has(e.key.kind),
    );
    return (
      mine.find((e) => e.state === "opening" || e.state === "processing") ??
      mine[mine.length - 1] ??
      null
    );
  }

  /** Whether a submission for `key` is still being processed — its controls
   * should hold until the verdict lands (a repeat would only be rejected).
   * The check is limited to the campaign `repoId`. */
  isProcessing(key: PendingKey, repoId: number): boolean {
    return this.entries.some(
      (e) =>
        sameKey(e.key, key) &&
        e.repoId === repoId &&
        (e.state === "processing" || e.state === "opening"),
    );
  }

  /** The entry for `key` in campaign `repoId` whose wait ran out before its
   * verdict landed, if any. */
  timedOut(key: PendingKey, repoId: number): PendingVerdict | undefined {
    return this.entries.find(
      (e) =>
        sameKey(e.key, key) && e.repoId === repoId && e.state === "timeout",
    );
  }

  /** Whether any submission acting on `taskId` itself (claim, encoding,
   * verdict — not a discussion) is still being processed; the
   * task's controls hold until it lands. The check is limited to the
   * campaign `repoId`. */
  taskProcessing(taskId: string, repoId: number): boolean {
    return this.entries.some(
      (e) =>
        e.key.task === taskId &&
        !DISCUSSION_KINDS.has(e.key.kind) &&
        e.repoId === repoId &&
        (e.state === "processing" || e.state === "opening"),
    );
  }

  settle(
    id: string,
    state: Exclude<PendingState, "opening" | "processing">,
    message: string,
    runFailed = false,
  ): void {
    this.entries = this.entries.map((e) =>
      e.id === id ? { ...e, state, message, runFailed } : e,
    );
    this.#unstore(id);
    const entry = this.entries.find((e) => e.id === id);
    if (state === "accepted" && entry && FINISH_KINDS.has(entry.key.kind)) {
      const mark = { repoId: entry.repoId, task: entry.key.task };
      this.recentlyFinished = [...this.recentlyFinished, mark];
      setTimeout(() => {
        this.recentlyFinished = this.recentlyFinished.filter((m) => m !== mark);
      }, FINISHED_HIGHLIGHT_MS);
    }
    if (entry) for (const listener of this.settledListeners) listener(entry);
    if (state === "accepted")
      setTimeout(() => this.dismiss(id), ACCEPTED_LINGER_MS);
  }

  dismiss(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
  }

  /** Entries still being processed when their wait ran out are dropped once
   * the campaign's tables record their PR's decision: the tables show it. */
  recorded(repoId: number, prs: Set<number>): void {
    if (
      !this.entries.some(
        (e) =>
          e.state === "timeout" && e.repoId === repoId && prs.has(e.prNumber),
      )
    )
      return;
    this.entries = this.entries.filter(
      (e) =>
        !(e.state === "timeout" && e.repoId === repoId && prs.has(e.prNumber)),
    );
  }

  /**
   * Go on following the submissions `viewer` left processing in this tab
   * before a reload. `contextFor` builds a command context for a campaign
   * repo, or null without a session. Once per tab and account.
   */
  resume(
    viewer: string,
    contextFor: (target: Target) => CommandContext | null,
  ): void {
    if (!viewer || this.resumedFor === viewer) return;
    this.resumedFor = viewer;
    for (const record of readStored()) {
      if (
        record.viewer !== viewer ||
        this.entries.some((e) => e.id === record.id)
      )
        continue;
      const ctx = contextFor(record.target);
      if (!ctx) continue;
      const { repoId, owner, repo } = record.target;
      this.entries = [
        ...this.entries,
        {
          id: record.id,
          label: record.label,
          prNumber: record.pr.number,
          prUrl: record.pr.html_url,
          key: record.key,
          repoId,
          owner,
          repo,
          viewer,
          state: "processing",
          message: "",
          runFailed: false,
        },
      ];
      resumeFollowing(
        ctx,
        record.label,
        record.key,
        record.id,
        record.pr,
        record.openedAt,
      );
    }
  }

  // Keep a processing entry in sessionStorage, for resume after a reload.
  #store(id: string, pr: FollowedPr): void {
    const e = this.entries.find((x) => x.id === id);
    if (!e?.viewer) return;
    writeStored([
      ...readStored().filter((r) => r.id !== id),
      {
        id,
        label: e.label,
        key: e.key,
        target: { repoId: e.repoId, owner: e.owner, repo: e.repo },
        pr,
        openedAt: pr.openedAt ?? Date.now(),
        viewer: e.viewer,
      },
    ]);
  }

  #unstore(id: string): void {
    writeStored(readStored().filter((r) => r.id !== id));
  }
}

export const pendingVerdicts = new PendingVerdictStore();
setVerdictSink(pendingVerdicts);
