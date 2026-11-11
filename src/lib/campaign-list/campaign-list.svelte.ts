/**
 * The campaign list's state: the loaded campaigns with how their listing
 * went (CampaignList), and the search, filter, sort and page size applied to
 * them (ListView). Both are created while the list page initialises; the
 * page's effects decide when loading, polling and resetting happen.
 */
import { readForge } from "$lib/command-runner.svelte.ts";
import { provider } from "$lib/forge/config.ts";
import { RateLimitError } from "$lib/forge/github-rest.ts";
import {
  invalidateStats,
  loadAllCampaignStats,
  loadCampaignStats,
} from "$lib/campaign-stats.ts";
import type { CampaignListing, CampaignStats } from "$lib/campaign-stats.ts";
import { registeredAs } from "$lib/campaign-resolve.ts";
import {
  PER_PAGE,
  filterCampaigns,
  readQuery,
  type ListFilter,
  type ListSort,
  type ListViewer,
} from "./list-query.ts";

export class CampaignList {
  stats = $state<CampaignStats[]>([]);
  loading = $state(false);
  error = $state<Error | null>(null);
  loaded = $state(false);
  // Repositories the search found but whose tables could not be read.
  failed = $state(0);
  failure = $state<Error | null>(null);
  // GitHub's search stopped before it was done: campaigns may be missing.
  incomplete = $state(false);

  readonly rateLimit = $derived(
    this.error instanceof RateLimitError ? this.error : null,
  );
  readonly partialRateLimit = $derived(
    !this.error && this.failure instanceof RateLimitError ? this.failure : null,
  );

  // Stats arrive one campaign at a time; each resolves into the grid as it
  // lands rather than waiting for the slowest repository.
  // A listed repository is shown only under the name the registry holds for
  // it, so its links and commands reach that repository.
  #registered = (s: CampaignStats) => registeredAs(s.repoId, s.name);
  #placeRow = (s: CampaignStats) =>
    (this.stats = [...this.stats.filter((x) => x.repoId !== s.repoId), s]);

  // What a listing reports beyond its rows.
  #noteListing(listing: CampaignListing) {
    this.failed = listing.failed;
    this.failure = listing.failure;
    this.incomplete = listing.incomplete;
  }

  async #loadAll() {
    try {
      this.#noteListing(
        await loadAllCampaignStats(readForge(), provider.repoTopic, {
          onEach: this.#placeRow,
          registered: this.#registered,
        }),
      );
      this.error = null;
    } catch (err) {
      this.error = err as Error;
    }
  }

  /** Loads the listing; `loaded` is set once it has finished. */
  load() {
    this.loading = true;
    this.#loadAll().finally(() => {
      this.loading = false;
      this.loaded = true;
    });
  }

  // Loads the listing again; campaigns that already loaded keep their rows.
  retry = () => {
    this.error = null;
    this.failed = 0;
    this.failure = null;
    this.incomplete = false;
    this.loaded = false;
  };

  // Re-read one campaign's stats and swap its grid row in place, leaving the
  // rest of the listing as it is.
  // Of a campaign's reads that overlap, only the latest one started is shown.
  #refreshSeq = new Map<number, number>();
  // `rethrow`: a failed read is the caller's to report (the poll's notice).
  async refresh(s: CampaignStats, rethrow = false) {
    invalidateStats(s.repoId);
    const seq = (this.#refreshSeq.get(s.repoId) ?? 0) + 1;
    this.#refreshSeq.set(s.repoId, seq);
    try {
      const fresh = await loadCampaignStats(readForge(), {
        id: s.repoId,
        owner: s.owner,
        name: s.repo,
        full_name: `${s.owner}/${s.repo}`,
        html_url: readForge().repoWebUrl(s.owner, s.repo),
        private: s.isPrivate,
        description: null,
        updated_at: "",
        created_at: s.createdAt,
      });
      if (this.#refreshSeq.get(s.repoId) !== seq) return;
      this.stats = this.stats.map((x) =>
        x.repoId === fresh.repoId ? fresh : x,
      );
    } catch (e) {
      // The stale row stays; the next full listing load replaces it.
      if (rethrow) throw e;
    }
  }

  /**
   * One auto-refresh poll: a campaign whose default branch has moved since
   * its row was read is read again. The topic search, which finds new
   * campaigns, runs again only when the tab became visible (`resumed`).
   */
  async poll(resumed: boolean) {
    const f = readForge();
    if (resumed)
      this.#noteListing(
        await loadAllCampaignStats(f, provider.repoTopic, {
          onEach: this.#placeRow,
          registered: this.#registered,
        }),
      );
    // All heads in one batch read where the client can; else one each.
    const polled = this.stats;
    const heads = await f
      .getRepoFilesBatch(
        polled.map((s) => ({ owner: s.owner, repo: s.repo })),
        [],
      )
      .catch((err) => {
        if (err instanceof RateLimitError) throw err;
        return null;
      });
    await Promise.all(
      polled.map(async (s, i) => {
        const sha = heads
          ? heads[i]?.headSha
          : (await f.getRepoHead(s.owner, s.repo)).sha;
        if (sha !== undefined && sha !== s.headSha) await this.refresh(s, true);
      }),
    );
  }
}

/**
 * The search, filter, sort and number of rows shown, starting from the page
 * address, applied to the campaigns `scope` gives.
 */
export class ListView {
  search = $state("");
  filter = $state<ListFilter>("all");
  sort = $state<ListSort>("active");
  visibleCount = $state(PER_PAGE);
  #scope: ListViewer & { readonly stats: readonly CampaignStats[] };

  constructor(
    params: URLSearchParams,
    scope: ListViewer & { readonly stats: readonly CampaignStats[] },
  ) {
    const initial = readQuery(params);
    this.search = initial.search;
    this.filter = initial.filter;
    this.sort = initial.sort;
    this.#scope = scope;
  }

  readonly filtered = $derived.by(() =>
    filterCampaigns(this.#scope.stats, this, this.#scope),
  );
  readonly shown = $derived(this.filtered.slice(0, this.visibleCount));
  readonly more = $derived(this.filtered.length - this.shown.length);
}
