/**
 * The campaign list's search, filter and sort: reading them from the page
 * address and writing them back, and applying them to the loaded campaigns.
 */
import { nextTask } from "../campaign-stats.ts";
import type { CampaignStats } from "../campaign-stats.ts";

/** Rows shown at first and added by each "Show more". */
export const PER_PAGE = 12;

export const FILTERS = ["all", "open", "nearly", "yours"] as const;
export type ListFilter = (typeof FILTERS)[number];
export const SORTS = ["active", "newest", "progress"] as const;
export type ListSort = (typeof SORTS)[number];

export const SORT_LABELS: Record<ListSort, string> = {
  active: "Recently active",
  newest: "Newest",
  progress: "Most progress",
};

export interface ListQuery {
  search: string;
  filter: ListFilter;
  sort: ListSort;
}

const oneOf = <T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
): T => (allowed.includes(value as T) ? (value as T) : fallback);

/** The query a page address carries; unknown values fall back to the defaults. */
export function readQuery(params: URLSearchParams): ListQuery {
  return {
    search: params.get("q") ?? "",
    filter: oneOf(params.get("filter"), FILTERS, "all"),
    sort: oneOf(params.get("sort"), SORTS, "active"),
  };
}

/** The query as address parameters, leaving out the defaults. */
export function queryString(q: ListQuery): string {
  const query = new URLSearchParams();
  if (q.search) query.set("q", q.search);
  if (q.filter !== "all") query.set("filter", q.filter);
  if (q.sort !== "active") query.set("sort", q.sort);
  return query.toString();
}

/** The campaign belongs to the logged-in account. */
export const isOwned = (
  s: CampaignStats,
  user: { login: string } | null | undefined,
): boolean => Boolean(user) && s.owner === user!.login;

/** The search text appears in the campaign's name, title, composer or a piece. */
export function matchesSearch(s: CampaignStats, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return [s.name, s.title, s.composer, ...Object.values(s.pieceNames)].some(
    (v) => v.toLowerCase().includes(q),
  );
}

/**
 * A logged-in viewer sees only campaigns whose next task they can claim;
 * logged out (`viewer` empty), every campaign with an open task.
 */
export function openToClaim(s: CampaignStats, viewer: string): boolean {
  if (!viewer) return s.ready > 0 || s.toValidate > 0;
  const next = nextTask(s, viewer);
  return next?.action === "encode" || next?.action === "review";
}

/**
 * Who is looking. Read only by the filters that need it, so it can be given
 * as getters over reactive state.
 */
export interface ListViewer {
  /** The viewer's account id; empty when logged out. */
  readonly viewer: string;
  readonly user: { login: string } | null | undefined;
}

export function matchesFilter(
  s: CampaignStats,
  filter: ListFilter,
  who: ListViewer,
): boolean {
  return filter === "open"
    ? openToClaim(s, who.viewer)
    : filter === "nearly"
      ? s.nearlyDone
      : filter === "yours"
        ? isOwned(s, who.user)
        : true;
}

/** The campaigns the query matches, in its sort order. */
export function filterCampaigns(
  stats: readonly CampaignStats[],
  q: ListQuery,
  who: ListViewer,
): CampaignStats[] {
  const list = stats
    .filter((s) => matchesSearch(s, q.search))
    .filter((s) => matchesFilter(s, q.filter, who));
  const ts = (v: string) => Date.parse(v || "0") || 0;
  if (q.sort === "newest")
    list.sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
  else if (q.sort === "progress")
    list.sort(
      (a, b) =>
        (b.total ? b.done / b.total : 0) - (a.total ? a.done / a.total : 0),
    );
  else {
    const active = (s: CampaignStats) => ts(s.lastActivity || s.createdAt);
    list.sort((a, b) => active(b) - active(a));
  }
  return list;
}
