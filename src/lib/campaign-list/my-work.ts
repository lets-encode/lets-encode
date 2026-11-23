/**
 * The logged-in viewer's side of the campaign list, read from the loaded
 * campaigns: their claimed, reviewing, awaiting and done tasks, and what
 * needs their attention (change requests on their campaigns, unresolved
 * comments on their work).
 */
import { expiresIn, reviewWaitLabel, timeAgo } from "../campaign-board.ts";
import {
  changeRequestTasks,
  commentsOnMyWork,
  myTasksIn,
} from "../campaign-stats.ts";
import type { CampaignStats, FeedComment, MyTask } from "../campaign-stats.ts";
import { isOwned } from "./list-query.ts";

/**
 * Each side section lists at most SIDE_MAX items until the viewer asks for
 * all of them, so a long list cannot push the campaigns out of reach.
 */
export const SIDE_MAX = 5;
/** The work panel's waiting and done sections list this many tasks. */
export const WORK_MAX = 3;

/** The viewer's tasks; a claim past its expiry at `now` is no longer theirs. */
export function viewerTasks(
  stats: readonly CampaignStats[],
  viewer: string,
  now: number,
): MyTask[] {
  return viewer
    ? stats
        .flatMap((s) => myTasksIn(s, viewer))
        .filter((t) => !t.expiresAt || Date.parse(t.expiresAt) > now)
    : ([] as MyTask[]);
}

/** The done tasks, latest submission first. */
export function doneTasks(tasks: readonly MyTask[]): MyTask[] {
  return tasks
    .filter((t) => t.group === "done")
    .sort(
      (a, b) =>
        Date.parse(b.submittedAt || "0") - Date.parse(a.submittedAt || "0"),
    );
}

/** Unresolved discussion comments on the viewer's work, newest first. */
export function openComments(
  stats: readonly CampaignStats[],
  viewer: string,
): FeedComment[] {
  return viewer
    ? stats
        .flatMap((s) => commentsOnMyWork(s, viewer))
        .filter(
          (f) => f.comment.kind === "comment" && f.comment.resolved !== "true",
        )
        .sort(
          (a, b) =>
            Date.parse(b.comment.timestamp || "0") -
            Date.parse(a.comment.timestamp || "0"),
        )
    : ([] as FeedComment[]);
}

/** The month and year of the viewer's first recorded action, or "". */
export function contributingSince(
  stats: readonly CampaignStats[],
  viewer: string,
): string {
  let first = Infinity;
  for (const s of stats) {
    for (const h of s.history) {
      if (h.user_id !== viewer) continue;
      const t = Date.parse(h.timestamp);
      if (Number.isFinite(t)) first = Math.min(first, t);
    }
  }
  return Number.isFinite(first) && first !== Infinity
    ? new Date(first).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      })
    : "";
}

/**
 * Newest first by `key`, then by campaign and task, so the order does not
 * follow load timing.
 */
export const newestFirst =
  (key: (t: MyTask) => string) => (a: MyTask, b: MyTask) =>
    Date.parse(key(b) || "0") - Date.parse(key(a) || "0") ||
    a.campaignSlug.localeCompare(b.campaignSlug) ||
    a.task.localeCompare(b.task);

/** The tasks the viewer holds, encoding then reviews, each newest claim first. */
export function toDoOrder(
  encoding: readonly MyTask[],
  validating: readonly MyTask[],
): MyTask[] {
  return [
    ...[...encoding].sort(newestFirst((t) => t.claimedAt)),
    ...[...validating].sort(newestFirst((t) => t.claimedAt)),
  ];
}

/** The folded work bar's one-line summary. */
export function workSummary(counts: {
  incomplete: boolean;
  awaiting: number;
  done: number;
}): string {
  return [
    // First, so a cut-off summary still shows it.
    counts.incomplete ? "Incomplete" : "",
    counts.awaiting ? `${counts.awaiting} waiting` : "",
    `${counts.done} done`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A claim counts as ending soon in its last SOON_MS. */
const SOON_MS = 48 * 60 * 60 * 1000;

/** "claim expires in 5 h" for a claim that ends soon, else "". */
export function claimEndsSoon(t: MyTask, now: number): string {
  const end = Date.parse(t.expiresAt);
  return Number.isFinite(end) && end - now < SOON_MS
    ? `claim ${expiresIn(t.expiresAt, now)}`
    : "";
}

export interface DoneGroup {
  campaignSlug: string;
  campaign: string;
  tasks: MyTask[];
}

/**
 * Done tasks grouped by campaign, in the order of `done`: a group stands
 * where its first task does. `query` keeps the tasks whose title or campaign
 * title contains it; `campaignSlug` keeps one campaign.
 */
export function doneGroups(
  done: readonly MyTask[],
  query = "",
  campaignSlug = "",
): DoneGroup[] {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, DoneGroup>();
  for (const t of done) {
    if (campaignSlug && t.campaignSlug !== campaignSlug) continue;
    if (q && !`${t.title}\n${t.campaign}`.toLowerCase().includes(q)) continue;
    const g = groups.get(t.campaignSlug) ?? {
      campaignSlug: t.campaignSlug,
      campaign: t.campaign,
      tasks: [],
    };
    g.tasks.push(t);
    groups.set(t.campaignSlug, g);
  }
  return [...groups.values()];
}

/** When the claim was made and when it expires. */
export function claimMeta(t: MyTask, now: number): string {
  const e = expiresIn(t.expiresAt, now);
  const expiry = e && `claim ${e}`;
  return [`claimed ${timeAgo(t.claimedAt, now)}`.trim(), expiry]
    .filter(Boolean)
    .join(" · ");
}

/** When the work was submitted and how its reviews stand. */
export function reviewMeta(t: MyTask, now: number): string {
  return `${timeAgo(t.submittedAt, now) ? `submitted ${timeAgo(t.submittedAt, now)} · ` : ""}${reviewWaitLabel(t.passes, t.threshold, t.myReviews, t.otherReviews, t.needsAnother)}`;
}

export type Attention =
  | {
      kind: "change";
      key: string;
      campaignSlug: string;
      campaign: string;
      task: string;
      title: string;
    }
  | { kind: "comment"; key: string; feed: FeedComment };

/**
 * Open change requests on the viewer's own campaigns, by campaign title and
 * task so the order does not follow load timing, then the unresolved
 * comments on the viewer's work.
 */
export function attentionItems(
  stats: readonly CampaignStats[],
  user: { login: string } | null | undefined,
  comments: readonly FeedComment[],
): Attention[] {
  return [
    ...stats
      .filter((s) => isOwned(s, user))
      .flatMap((s) =>
        changeRequestTasks(s).map((c) => ({
          kind: "change" as const,
          key: `change:${s.repoId}:${c.task}`,
          campaignSlug: s.name,
          campaign: s.title,
          task: c.task,
          title: c.title,
        })),
      )
      .sort(
        (a, b) =>
          a.campaign.localeCompare(b.campaign) || a.task.localeCompare(b.task),
      ),
    ...comments.map((f) => ({
      kind: "comment" as const,
      key: `comment:${f.comment.comment_id || f.comment.timestamp + f.task}`,
      feed: f,
    })),
  ];
}
