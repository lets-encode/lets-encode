<!--
  The main screen — the app's only dashboard. Top to bottom, for a logged-in
  viewer: what needs their attention (unresolved comments on their work),
  their open work, every campaign as a searchable list of
  full-width rows (each carrying its suggested next task, claimable in
  place), and unfinished wizard drafts. Logged out, only the list renders.
  From 1280px the attention and work sections sit in a side column beside
  the list; narrower, the work folds behind a one-line summary bar.
  Campaign creation lives behind the top bar's New campaign button. One stats
  load serves the whole screen.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { MediaQuery } from "svelte/reactivity";
  import { auth, login } from "$lib/auth.svelte.ts";
  import {
    CommandRunner,
    readForge,
    viewerId,
    openMeiFriend,
  } from "$lib/command-runner.svelte.ts";
  import { provider } from "$lib/forge/config.ts";
  import { RateLimitError } from "$lib/forge/github-rest.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import type { CommandContext, Result } from "$lib/commands.ts";
  import { elapsed, expiresIn } from "$lib/campaign-board.ts";
  import {
    handle,
    isPreTask,
    preTaskHref,
    reviewHref,
    workPlace,
  } from "$lib/campaign-graph.ts";
  import {
    changeRequestTasks,
    commentsOnMyWork,
    invalidateStats,
    loadAllCampaignStats,
    loadCampaignStats,
    myTasksIn,
    nextTask,
  } from "$lib/campaign-stats.ts";
  import type {
    CampaignStats,
    FeedComment,
    MyTask,
    NextTask,
  } from "$lib/campaign-stats.ts";
  import CampaignRow from "$lib/components/CampaignRow.svelte";
  import CampaignDrafts from "$lib/components/CampaignDrafts.svelte";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import RunnerBanner from "$lib/components/RunnerBanner.svelte";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";

  const PER_PAGE = 12;

  const viewer = $derived(viewerId());

  let stats = $state<CampaignStats[]>([]);
  let listLoading = $state(false);
  let listError = $state<Error | null>(null);
  let listLoaded = $state(false);
  // Repositories the search found but whose tables could not be read.
  let listFailed = $state(0);
  let listFailure = $state<Error | null>(null);

  $effect(() => {
    if (auth.status === "loading" || listLoaded || listLoading) return;
    listLoading = true;
    loadAll().finally(() => {
      listLoading = false;
      listLoaded = true;
    });
  });

  // Stats arrive one campaign at a time; each resolves into the grid as it
  // lands rather than waiting for the slowest repository.
  async function loadAll() {
    try {
      const listing = await loadAllCampaignStats(
        readForge(),
        provider.repoTopic,
        {
          onEach: (s) =>
            (stats = [...stats.filter((x) => x.repoId !== s.repoId), s]),
        },
      );
      listFailed = listing.failed;
      listFailure = listing.failure;
      listError = null;
    } catch (err) {
      listError = err as Error;
    }
  }

  // Loads the listing again; campaigns that already loaded keep their rows.
  function retryList() {
    listError = null;
    listFailed = 0;
    listFailure = null;
    listLoaded = false;
  }

  const listRateLimit = $derived(
    listError instanceof RateLimitError ? listError : null,
  );
  const partialRateLimit = $derived(
    !listError && listFailure instanceof RateLimitError ? listFailure : null,
  );

  // ----------------------------------------------------- the viewer's work
  const tasks = $derived(
    viewer ? stats.flatMap((s) => myTasksIn(s, viewer)) : ([] as MyTask[]),
  );
  const encoding = $derived(tasks.filter((t) => t.group === "encoding"));
  const validating = $derived(tasks.filter((t) => t.group === "validating"));
  const awaiting = $derived(tasks.filter((t) => t.group === "awaiting"));
  const done = $derived(
    tasks
      .filter((t) => t.group === "done")
      .sort(
        (a, b) =>
          Date.parse(b.submittedAt || "0") - Date.parse(a.submittedAt || "0"),
      ),
  );
  let showCompleted = $state(false);

  // Unresolved discussion comments on the viewer's work.
  const openComments = $derived(
    viewer
      ? stats
          .flatMap((s) => commentsOnMyWork(s, viewer))
          .filter(
            (f) =>
              f.comment.kind === "comment" && f.comment.resolved !== "true",
          )
          .sort(
            (a, b) =>
              Date.parse(b.comment.timestamp || "0") -
              Date.parse(a.comment.timestamp || "0"),
          )
      : ([] as FeedComment[]),
  );

  // The viewer's first recorded action anywhere, for "contributing since".
  const since = $derived.by(() => {
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
  });

  // ------------------------------------------------------------ commands
  const runner = new CommandRunner();

  const ctxOf = (s: CampaignStats): CommandContext =>
    runner.context(readForge(), {
      repoId: s.repoId,
      owner: s.owner,
      repo: s.repo,
    });

  const ctxFor = (t: MyTask): CommandContext | null => {
    const s = stats.find((x) => x.name === t.campaignSlug);
    return s ? ctxOf(s) : null;
  };

  // Re-read one campaign's stats and swap its grid row in place, leaving the
  // rest of the listing as it is.
  async function refreshStats(s: CampaignStats) {
    invalidateStats(s.repoId);
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
      stats = stats.map((x) => (x.repoId === fresh.repoId ? fresh : x));
    } catch {
      // The stale row stays; the next full listing load replaces it.
    }
  }

  async function run(
    t: MyTask,
    command: (c: CommandContext) => Promise<Result>,
  ) {
    const c = ctxFor(t);
    if (!c) return null;
    return runner.run(
      () => command(c),
      async () => {
        runner.log.step("Refreshing…");
        const s = stats.find((x) => x.repoId === c.repoId);
        if (s) await refreshStats(s);
      },
    );
  }

  // Background verdicts settle against a campaign the viewer has work in;
  // refresh those campaigns' rows so the settled task moves group.
  $effect(() =>
    pendingVerdicts.onSettled(() => {
      if (runner.busy) return;
      const mine = new Set(
        tasks.filter((t) => t.group !== "done").map((t) => t.campaignSlug),
      );
      for (const s of stats) if (mine.has(s.name)) refreshStats(s);
    }),
  );

  // mei-friend returns the volunteer to the task's campaign page.
  const editorInput = (campaign: string, task_id: string) => ({
    task_id,
    campaign,
    base: location.origin,
  });
  const openEditor = async (t: MyTask) => {
    const s = stats.find((x) => x.name === t.campaignSlug);
    if (s && pendingVerdicts.isProcessing(`claim:${t.task}`, s.repoId)) return;
    const result = await run(t, (c) =>
      invoke(commands.openEditor, editorInput(t.campaignSlug, t.task), c),
    );
    openMeiFriend(result);
  };
  // A submission on the task still being processed holds its row's actions.
  const processing = (t: MyTask) =>
    pendingVerdicts.taskProcessing(
      t.task,
      stats.find((x) => x.name === t.campaignSlug)?.repoId,
    );
  // Claim a campaign row's suggested next task. Encoding claims open
  // mei-friend (a pre-task claims in its own editor instead); a clean review
  // claim lands on the place the review happens.
  async function claimNext(s: CampaignStats, next: NextTask) {
    if (next.action === "encode" && next.pre) {
      await goto(preTaskHref(s.name, next.locator, next.task));
      return;
    }
    const c = ctxOf(s);
    const refresh = async () => {
      runner.log.step("Refreshing…");
      await refreshStats(s);
    };
    if (
      next.action === "encode" ||
      (next.action === "continue" && next.kind !== "review" && !next.pre)
    ) {
      const result = await runner.run(
        () => invoke(commands.openEditor, editorInput(s.name, next.task), c),
        refresh,
      );
      openMeiFriend(result);
    } else if (next.action === "review") {
      const result = await runner.run(
        () =>
          invoke(
            commands.claimValidation,
            { task_id: next.task, subtask_id: next.subtask },
            c,
          ),
        refresh,
      );
      if (result?.ok && !result.warn) {
        await goto(reviewHref(s.name, next.locator, next.task));
      }
    }
  }

  const taskHref = (slug: string, task: string) =>
    `/${slug}?task=${encodeURIComponent(task)}`;
  const ago = (iso: string) => {
    const e = elapsed(iso);
    return e === "now" ? "just now" : `${e} ago`;
  };
  const claimExpiry = (t: MyTask): string => {
    const e = expiresIn(t.expiresAt);
    return e && `claim ${e}`;
  };
  const claimMeta = (t: MyTask) =>
    `claimed ${ago(t.claimedAt)}${claimExpiry(t) ? ` · ${claimExpiry(t)}` : ""}`;
  const reviewMeta = (t: MyTask) =>
    `${t.submittedAt ? `submitted ${ago(t.submittedAt)} · ` : ""}${t.passes} of ${t.threshold} reviews`;

  // Wide screens show the viewer's work in a side column; narrower ones fold
  // it behind a one-line summary bar.
  const wide = new MediaQuery("min-width: 1280px", false);
  let workOpen = $state(false);
  // Counts only work the viewer can act on; submissions waiting on other
  // reviewers appear in the summary text.
  const openCount = $derived(encoding.length + validating.length);
  const workSummary = $derived(
    [
      // First, so a cut-off summary still shows it.
      listFailed > 0 ? "Incomplete" : "",
      encoding.length ? `${encoding.length} encoding` : "",
      validating.length ? `${validating.length} reviewing` : "",
      awaiting.length ? `${awaiting.length} awaiting review` : "",
      `${done.length} done`,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  // Each side section lists at most SIDE_MAX items until the viewer asks for
  // all of them, so a long list cannot push the campaigns out of reach.
  const SIDE_MAX = 5;
  // Phones list fewer attention items, so the campaigns stay near the top.
  const phone = new MediaQuery("max-width: 560px", false);
  const attentionMax = $derived(phone.current ? 2 : SIDE_MAX);
  let allAttention = $state(false);
  let allWork = $state(false);
  // Newest first within each group, so the order does not follow load timing.
  const newestFirst = (key: (t: MyTask) => string) => (a: MyTask, b: MyTask) =>
    Date.parse(key(b) || "0") - Date.parse(key(a) || "0") ||
    a.campaignSlug.localeCompare(b.campaignSlug) ||
    a.task.localeCompare(b.task);
  const openWork = $derived([
    ...[...encoding].sort(newestFirst((t) => t.claimedAt)),
    ...[...validating].sort(newestFirst((t) => t.claimedAt)),
    ...[...awaiting].sort(newestFirst((t) => t.submittedAt)),
  ]);
  const shownWork = $derived(allWork ? openWork : openWork.slice(0, SIDE_MAX));
  const isOwned = (s: CampaignStats) =>
    Boolean(auth.user) && s.owner === auth.user!.login;
  // Open change requests on the viewer's own campaigns, by campaign title
  // and task so the order does not follow load timing, then unresolved
  // comments on the viewer's work.
  type Attention =
    | {
        kind: "change";
        key: string;
        campaignSlug: string;
        campaign: string;
        task: string;
        title: string;
      }
    | { kind: "comment"; key: string; feed: FeedComment };
  const attention = $derived<Attention[]>([
    ...stats
      .filter(isOwned)
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
    ...openComments.map((f) => ({
      kind: "comment" as const,
      key: `comment:${f.comment.comment_id || f.comment.timestamp + f.task}`,
      feed: f,
    })),
  ]);
  const shownAttention = $derived(
    allAttention ? attention : attention.slice(0, attentionMax),
  );

  // ------------------------------------------------------------- the list
  const FILTERS = ["all", "open", "nearly", "yours"] as const;
  const SORTS = ["active", "newest", "progress"] as const;
  const oneOf = <T extends string>(
    value: string | null,
    allowed: readonly T[],
    fallback: T,
  ): T => (allowed.includes(value as T) ? (value as T) : fallback);
  const initial = page.url.searchParams;
  let search = $state(initial.get("q") ?? "");
  let searchInput = $state<HTMLInputElement>();
  let filter = $state(oneOf(initial.get("filter"), FILTERS, "all"));
  let sort = $state(oneOf(initial.get("sort"), SORTS, "active"));
  // Search, filter and sort live in the URL, so Back and a shared link
  // restore them; the defaults stay out of it.
  $effect(() => {
    const query = new URLSearchParams();
    if (search) query.set("q", search);
    if (filter !== "all") query.set("filter", filter);
    if (sort !== "active") query.set("sort", sort);
    const next = query.toString();
    if (next === page.url.searchParams.toString()) return;
    goto(`/campaigns${next ? `?${next}` : ""}`, {
      replaceState: true,
      noScroll: true,
      keepFocus: true,
    });
  });
  const sortLabels = {
    active: "Recently active",
    newest: "Newest",
    progress: "Most progress",
  };
  let visibleCount = $state(PER_PAGE);
  // A changed search, filter or sort starts the listing over.
  $effect(() => {
    void search;
    void filter;
    void sort;
    visibleCount = PER_PAGE;
  });

  const matchesSearch = (s: CampaignStats) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [s.name, s.title, s.composer, ...Object.values(s.pieceNames)].some(
      (v) => v.toLowerCase().includes(q),
    );
  };
  // A logged-in viewer sees only campaigns whose next task they can claim;
  // logged out, every campaign with an open task.
  const openToClaim = (s: CampaignStats) => {
    if (!viewer) return s.ready > 0 || s.toValidate > 0;
    const next = nextTask(s, viewer);
    return next?.action === "encode" || next?.action === "review";
  };
  const matchesFilter = (s: CampaignStats) =>
    filter === "open"
      ? openToClaim(s)
      : filter === "nearly"
        ? s.nearlyDone
        : filter === "yours"
          ? isOwned(s)
          : true;
  const filtered = $derived.by(() => {
    const list = stats.filter(matchesSearch).filter(matchesFilter);
    const ts = (v: string) => Date.parse(v || "0") || 0;
    if (sort === "newest")
      list.sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
    else if (sort === "progress")
      list.sort(
        (a, b) =>
          (b.total ? b.done / b.total : 0) - (a.total ? a.done / a.total : 0),
      );
    else list.sort((a, b) => ts(b.lastActivity) - ts(a.lastActivity));
    return list;
  });
  const shown = $derived(filtered.slice(0, visibleCount));
  const more = $derived(filtered.length - shown.length);
</script>

<svelte:head>
  <title>Campaigns · Let's Encode!</title>
</svelte:head>

{#if runner.busy && runner.overlay}
  <LoadingOverlay
    log={runner.log}
    finished={runner.held}
    error={runner.result?.error}
    onContinue={() => runner.dismiss()}
  />
{/if}

<div class="screen">
  <h1 class="vh">Campaigns</h1>
  <RunnerBanner {runner} />

  <div class="layout" class:split={auth.user && wide.current}>
    {#if auth.user}
      <aside class="side">
        {#if attention.length > 0}
          <section class="panel">
            <h2 class="stitle danger">
              <img class="hand-attn" src="/attention-hand.svg" alt="" />Needs
              your attention
            </h2>
            <div class="items">
              {#each shownAttention as a (a.key)}
                {#if a.kind === "change"}
                  <a class="item" href={taskHref(a.campaignSlug, a.task)}>
                    <span class="itext">
                      <span class="ititle" title={a.title}>{a.title}</span>
                      <span class="isub">{a.campaign}</span>
                    </span>
                    <span
                      class="chip danger"
                      title="A review asked for changes; the task is back with its encoder."
                      >Change requested</span
                    >
                  </a>
                {:else}
                  <a
                    class="item"
                    href={taskHref(a.feed.campaignSlug, a.feed.task)}
                  >
                    <span class="itext">
                      <span class="ititle" title={a.feed.taskTitle}
                        >{a.feed.taskTitle}</span
                      >
                      <span class="isub" title={a.feed.comment.body}
                        >@{handle(a.feed.logins, a.feed.comment.author_id)}: “{a
                          .feed.comment.body}”</span
                      >
                    </span>
                    <span class="chip grey">Comment</span>
                  </a>
                {/if}
              {/each}
              {#if attention.length > attentionMax}
                <button
                  type="button"
                  class="moretoggle"
                  aria-expanded={allAttention}
                  onclick={() => (allAttention = !allAttention)}
                  >{allAttention
                    ? "Show fewer"
                    : `Show all ${attention.length}`}</button
                >
              {/if}
            </div>
          </section>
        {/if}

        <!-- Narrow screens drop the work bar for a volunteer with no work. -->
        {#if wide.current || tasks.length > 0 || listLoading}
          <section class="panel" class:fold={!wide.current}>
            {#if wide.current}
              <div class="phead">
                <h2 class="stitle">Your open work</h2>
                <span class="countpill">{openCount}</span>
              </div>
            {:else}
              <h2 class="barh">
                <button
                  type="button"
                  class="workbar"
                  aria-label={`Your open work: ${openCount} to act on, ${listLoading && tasks.length === 0 ? "loading" : workSummary}`}
                  aria-expanded={workOpen}
                  aria-controls="worklist"
                  onclick={() => (workOpen = !workOpen)}
                >
                  <span class="phead"
                    ><span class="btitle">Your open work</span><span
                      class="countpill">{openCount}</span
                    ></span
                  >
                  <span class="wsum"
                    >{listLoading && tasks.length === 0
                      ? "Loading…"
                      : workSummary}</span
                  >
                  <Icon name={workOpen ? "chevron-up" : "chevron-down"} />
                </button>
              </h2>
            {/if}
            {#if wide.current || workOpen}
              <div class="items" id="worklist">
                {#if listLoading && tasks.length === 0}
                  <p class="note">Loading your claimed tasks…</p>
                {:else if openWork.length === 0}
                  <p class="note">
                    No open work. Claim a task from a campaign.
                  </p>
                {/if}
                {#each shownWork as t (`${t.group}:${t.campaignSlug}:${t.task}:${t.subtask}`)}
                  {#if t.group === "awaiting"}
                    <a
                      class="item"
                      href={taskHref(t.campaignSlug, t.task)}
                      title={reviewMeta(t)}
                    >
                      <span class="itext">
                        <span class="ititle" title={t.title}>{t.title}</span>
                        <span class="isub">{t.campaign}</span>
                        <span class="imeta">{reviewMeta(t)}</span>
                      </span>
                      <span class="chip grey">Awaiting review</span>
                    </a>
                  {:else}
                    <div class="item">
                      <a
                        class="itext"
                        href={t.group === "validating"
                          ? reviewHref(t.campaignSlug, t.locator, t.task)
                          : taskHref(t.campaignSlug, t.task)}
                        title={claimMeta(t)}
                      >
                        <span class="ititle" title={t.title}>{t.title}</span>
                        <span class="isub">{t.campaign}</span>
                        <span class="imeta">{claimMeta(t)}</span>
                      </a>
                      {#if t.group === "encoding"}
                        <span class="chip blue">Encoding</span>
                      {:else}
                        <span class="chip review">Reviewing</span>
                      {/if}
                      {#if t.group === "encoding"}
                        <div class="iacts">
                          {#if isPreTask(t.locator)}
                            <a
                              class="btn"
                              href={processing(t)
                                ? undefined
                                : preTaskHref(
                                    t.campaignSlug,
                                    t.locator,
                                    t.task,
                                  )}
                              aria-disabled={processing(t)}
                              >Open {workPlace(t.locator)}</a
                            >
                          {:else}
                            <button
                              type="button"
                              class="btn"
                              disabled={runner.busy || processing(t)}
                              onclick={() => openEditor(t)}
                              >Open in mei-friend <Icon
                                name="external"
                              /></button
                            >
                          {/if}
                        </div>
                      {/if}
                    </div>
                  {/if}
                {/each}
                {#if openWork.length > SIDE_MAX}
                  <button
                    type="button"
                    class="moretoggle"
                    aria-expanded={allWork}
                    onclick={() => (allWork = !allWork)}
                    >{allWork
                      ? "Show fewer"
                      : `Show all ${openWork.length}`}</button
                  >
                {/if}
                {#if done.length > 0}
                  <button
                    type="button"
                    class="donetoggle"
                    aria-expanded={showCompleted}
                    title={since ? `Contributing since ${since}` : undefined}
                    onclick={() => (showCompleted = !showCompleted)}
                    >{done.length} done <Icon
                      name={showCompleted ? "chevron-up" : "chevron-down"}
                      size={12}
                    /></button
                  >
                  {#if showCompleted}
                    {#each done.slice(0, 10) as t (`${t.campaignSlug}:${t.task}:${t.subtask}`)}
                      <a
                        class="item donerow"
                        href={taskHref(t.campaignSlug, t.task)}
                        title={reviewMeta(t)}
                      >
                        <span class="itext">
                          <span class="ititle" title={t.title}>{t.title}</span>
                          <span class="isub">{t.campaign}</span>
                        </span>
                        <span class="check"><Icon name="check" /></span>
                      </a>
                    {/each}
                    {#if done.length > 10}
                      <p class="note small">
                        Showing the latest 10 of {done.length}
                      </p>
                    {/if}
                  {/if}
                {/if}
              </div>
            {/if}
          </section>
        {/if}
      </aside>
    {/if}

    <section class="list">
      <div class="tools">
        <label class="search">
          <Icon name="search" />
          <input
            type="search"
            bind:value={search}
            bind:this={searchInput}
            placeholder="Title, composer or piece"
            aria-label="Search campaigns"
          />
        </label>
        <label class="sort" title={`Sort campaigns: ${sortLabels[sort]}`}>
          <Icon name="sort" />
          <span class="sortlabel">{sortLabels[sort]}</span>
          <span class="sortchev"><Icon name="chevron-down" size={12} /></span>
          {#if sort !== "active"}<span class="sortdot"></span>{/if}
          <select bind:value={sort} aria-label="Sort campaigns">
            <option value="active">{sortLabels.active}</option>
            <option value="newest">{sortLabels.newest}</option>
            <option value="progress">{sortLabels.progress}</option>
          </select>
        </label>
      </div>
      <div class="shead">
        <div class="phead">
          <h2 class="stitle">All campaigns</h2>
          <span
            class="countpill"
            title={listFailed > 0
              ? `${listFailed} more could not be loaded`
              : undefined}>{listLoaded ? filtered.length : "…"}</span
          >
        </div>
        <div class="seg" role="group" aria-label="Filter campaigns">
          <button
            type="button"
            class:on={filter === "all"}
            aria-pressed={filter === "all"}
            onclick={() => (filter = "all")}>All</button
          >
          <button
            type="button"
            class:on={filter === "open"}
            aria-pressed={filter === "open"}
            onclick={() => (filter = "open")}>Open to claim</button
          >
          <button
            type="button"
            class:on={filter === "nearly"}
            aria-pressed={filter === "nearly"}
            title="Campaigns with at least 80% of their tasks done"
            onclick={() => (filter = "nearly")}>Nearly done</button
          >
          {#if auth.user}
            <button
              type="button"
              class="yoursopt"
              class:on={filter === "yours"}
              aria-pressed={filter === "yours"}
              onclick={() => (filter = "yours")}>Yours</button
            >
          {/if}
        </div>
      </div>
      {#if !listError && listFailed > 0}
        <p class="msg-error" role="alert">
          {#if partialRateLimit && auth.expired}Your GitHub login has expired.{/if}
          <span title={partialRateLimit ? undefined : listFailure?.message}
            >{listFailed} campaign{listFailed === 1 ? "" : "s"} couldn't be loaded{partialRateLimit
              ? `: ${partialRateLimit.message}`
              : "."}</span
          >
          <button
            type="button"
            class="btn"
            disabled={listLoading}
            onclick={retryList}>Try again</button
          >
        </p>
      {/if}
      {#if listError}
        <p class="msg-error" role="alert">
          {#if listRateLimit && auth.expired}Your GitHub login has expired.{/if}
          <span title={listRateLimit ? undefined : listError.message}
            >Couldn't load the campaigns{listRateLimit
              ? `: ${listRateLimit.message}`
              : "."}</span
          >
          <button
            type="button"
            class="btn"
            disabled={listLoading}
            onclick={retryList}>Try again</button
          >
        </p>
      {:else if listLoaded && stats.length === 0}
        <p class="note">No campaigns yet. Create one with New campaign.</p>
      {:else if (listLoading || auth.status === "loading") && stats.length === 0}
        <p class="note">Loading campaigns…</p>
      {:else if shown.length === 0}
        <p class="note">
          No campaign matches this search or filter.
          <button
            type="button"
            class="linkish"
            onclick={() => {
              search = "";
              filter = "all";
              searchInput?.focus();
            }}>Show all campaigns</button
          >
        </p>
      {:else}
        <div class="shelf">
          {#each shown as s (s.repoId)}
            <CampaignRow
              stats={s}
              owned={isOwned(s)}
              viewer={viewer ?? ""}
              busy={runner.busy}
              onact={claimNext}
            />
          {/each}
        </div>
        {#if more > 0}
          <button
            type="button"
            class="btn showmore"
            onclick={() => (visibleCount += PER_PAGE)}
            >Show {Math.min(PER_PAGE, more)} more campaign{Math.min(
              PER_PAGE,
              more,
            ) === 1
              ? ""
              : "s"}
            <Icon name="chevron-down" size={12} /></button
          >
        {/if}
      {/if}
      {#if !auth.user && auth.status === "anonymous" && !listRateLimit && !partialRateLimit}
        <p class="note login-hint">
          {#if auth.expired}Your GitHub login has expired.{/if}
          Browsing works logged out:
          <button type="button" class="linkish" onclick={() => login()}
            >log in with GitHub</button
          > to claim a task or see your work here.
        </p>
      {/if}
    </section>
  </div>

  {#if auth.user}
    <CampaignDrafts />
  {/if}
</div>

<style>
  .screen {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 24px 32px 16px;
    /* The content stops widening at --page-max and centres past it, while the
       page gradient keeps running to both edges. */
    padding-inline: max(32px, calc((100% - var(--page-max)) / 2 + 32px));
    box-sizing: border-box;
    background:
      radial-gradient(60% 90% at 15% 0%, var(--glow-blue), transparent 60%),
      radial-gradient(60% 90% at 85% 10%, var(--glow-green), transparent 60%),
      var(--bg-alt);
  }
  @media (max-width: 560px) {
    .screen {
      padding: 16px;
    }
  }
  .note {
    margin: 0;
    font-size: 13px;
    color: var(--ink-soft);
  }
  .note.small {
    padding: 4px 0;
    font-size: 12.5px;
    color: var(--ink-faint);
  }
  .msg-error {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
  }
  /* Wide screens: the viewer's work in a side column beside the list. */
  .layout {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .layout.split {
    display: grid;
    grid-template-columns: 320px minmax(0, 1fr);
    gap: 28px;
    align-items: start;
  }
  .side {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .split .side {
    position: sticky;
    top: 0;
  }
  .panel {
    padding: 14px 16px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow-sm);
  }
  .panel.fold {
    padding: 0;
  }
  .fold .items {
    padding: 0 16px 10px;
  }
  .phead {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .panel > .phead,
  .panel > .stitle {
    margin-bottom: 6px;
  }
  .stitle {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--ink);
  }
  .stitle.danger {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  /* The orange finger-up hand leads the attention section. */
  .hand-attn {
    height: 22px;
    flex: none;
  }
  .countpill {
    font-size: 12px;
    font-weight: 600;
    line-height: 1.2;
    padding: 2px 8px;
    border-radius: 999px;
    color: var(--ink-soft);
    background: var(--bg-tint);
    font-variant-numeric: tabular-nums;
  }
  /* The folded work panel's header: one line that opens the list. */
  .barh {
    margin: 0;
  }
  .workbar {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 40px;
    padding: 4px 12px 4px 16px;
    font: inherit;
    color: var(--ink-soft);
    text-align: left;
    background: none;
    border: 0;
    border-radius: 14px;
    cursor: pointer;
  }
  .btitle {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
  }
  .wsum {
    flex: 1;
    min-width: 0;
    text-align: right;
    font-size: 13px;
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .items {
    display: flex;
    flex-direction: column;
  }
  .item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px 10px;
    margin: 0 -10px;
    padding: 8px 10px;
    border-radius: 8px;
    color: inherit;
    text-decoration: none;
  }
  @media (hover: hover) {
    a.item:hover {
      background: var(--bg-tint);
    }
  }
  .itext {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: inherit;
    text-decoration: none;
  }
  /* In the narrow side column titles wrap to at most two lines, so their end
     still tells similar tasks apart; full width, they keep to one line. */
  .ititle {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--ink);
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .layout:not(.split) .ititle {
    display: block;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  @media (hover: hover) {
    a.itext:hover .ititle {
      color: var(--link);
    }
  }
  .isub {
    font-size: 12.5px;
    color: var(--ink-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The claim or review details: a tooltip where a pointer can hover,
     a visible line on phones. */
  .imeta {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @media (max-width: 560px) {
    .imeta {
      position: static;
      width: auto;
      height: auto;
      clip-path: none;
      white-space: normal;
      font-size: 12.5px;
      color: var(--ink-faint);
    }
  }
  .iacts {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .chip {
    font-size: 12px;
    font-weight: 600;
    line-height: 19px;
    padding: 0 9px;
    border: 1px solid;
    border-radius: 999px;
    white-space: nowrap;
  }
  .chip.blue {
    color: var(--info);
    background: var(--info-bg);
    border-color: var(--info-line);
  }
  .chip.review {
    color: var(--warn);
    background: var(--warn-bg);
    border-color: var(--warn-line);
  }
  .chip.danger {
    color: var(--danger);
    background: var(--danger-wash);
    border-color: var(--danger-line);
  }
  .chip.grey {
    color: var(--ink-faint);
    background: var(--bg-tint);
    border-color: var(--line);
  }
  .donetoggle {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    margin-top: 4px;
    padding: 6px 0 0;
    font: 600 12.5px var(--font);
    color: var(--ink-soft);
    background: none;
    border: 0;
    border-top: 1px solid var(--line);
    cursor: pointer;
  }
  @media (hover: hover) {
    .donetoggle:hover {
      color: var(--accent);
    }
  }
  .moretoggle {
    align-self: flex-start;
    min-height: 24px;
    padding: 0;
    font: 600 12.5px var(--font);
    color: var(--link);
    background: none;
    border: 0;
    cursor: pointer;
  }
  @media (hover: hover) {
    .moretoggle:hover {
      text-decoration: underline;
    }
  }
  .donerow .ititle {
    font-weight: 400;
    color: var(--ink-soft);
  }
  .check {
    display: flex;
    color: var(--ok);
  }
  /* The campaign list: search and sort, then the heading with the filter. */
  .list {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .search {
    flex: 1;
    min-width: 0;
    max-width: 520px;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 0 12px;
    box-sizing: border-box;
    color: var(--ink-faint);
    background: var(--card);
    border: 1px solid var(--line-input);
    border-radius: 8px;
  }
  /* The input has no outline of its own; the field shows the focus. */
  .search:focus-within {
    border-color: var(--accent);
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .search input {
    flex: 1;
    min-width: 0;
    min-height: 32px;
    padding: 0;
    font: 400 14px var(--font);
    color: var(--ink);
    background: transparent;
    border: 0;
    outline: none;
  }
  .search input::placeholder {
    color: var(--ink-faint);
  }
  /* The sort control is a native select laid transparently over a button
     face, so the platform's own menu opens. */
  .sort {
    position: relative;
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 6px 14px;
    box-sizing: border-box;
    font: 600 12.5px var(--font);
    color: var(--ink-soft);
    background: var(--card);
    border: 1px solid var(--line-input);
    border-radius: 999px;
    cursor: pointer;
  }
  .sort:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  @media (hover: hover) {
    .sort:hover {
      color: var(--accent);
      border-color: var(--accent);
    }
  }
  .sortchev {
    display: flex;
  }
  /* Phones show the sort as an icon; a dot marks a sort other than the
     default. */
  .sortdot {
    display: none;
  }
  .sort select {
    position: absolute;
    inset: 0;
    width: 100%;
    opacity: 0;
    cursor: pointer;
  }
  @media (max-width: 560px) {
    .sort {
      width: 32px;
      padding: 0;
      justify-content: center;
    }
    .sortlabel,
    .sortchev {
      display: none;
    }
    .sortdot {
      display: block;
      position: absolute;
      top: 3px;
      right: 3px;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--accent);
    }
  }
  .shead {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px 12px;
  }
  .shead .seg {
    max-width: 100%;
    overflow-x: auto;
    scrollbar-width: none;
  }
  /* The owner orange reaches 4.5:1 on the grey track only in its deeper
     tone; the dark theme's light orange already does. */
  .seg > button.yoursopt {
    color: var(--warn-btn-hover);
  }
  :global([data-theme="dark"]) .seg > button.yoursopt {
    color: var(--owner);
  }
  .shelf {
    container: shelf / inline-size;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .showmore {
    align-self: center;
  }
  .login-hint {
    text-align: center;
    font-size: 12.5px;
    color: var(--ink-faint);
  }
  .linkish {
    font: inherit;
    font-weight: 600;
    color: var(--link);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  @media (hover: hover) {
    .linkish:hover {
      text-decoration: underline;
    }
  }
  /* Banner styles are shared app-wide in ui.css. */
</style>
