<!--
  The main screen — the campaign list. Top to bottom, for a logged-in
  viewer: what needs their attention (unresolved comments on their work),
  their open work, every campaign as a searchable list of
  full-width rows (each carrying its suggested next task, claimable in
  place), and unfinished wizard drafts. Logged out, only the list renders.
  From 1280px the attention and work sections sit in a side column beside
  the list; narrower, the work folds behind a one-line summary bar.
  Campaign creation lives behind the top bar's New campaign button. One stats
  load serves the whole screen.

  The listing's state is in campaign-list/campaign-list.svelte.ts; this page
  decides when it loads and polls, runs the commands, and lays out the
  sections (components/campaign-list/).
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import Notice from "$lib/components/Notice.svelte";
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
  import { commands, invoke } from "$lib/commands.ts";
  import type { CommandContext, Result } from "$lib/commands.ts";
  import {
    reviewHref,
    taskAction,
    taskActionHref,
  } from "$lib/campaign-graph.ts";
  import { nextTaskMode } from "$lib/campaign-stats.ts";
  import type { CampaignStats, MyTask, NextTask } from "$lib/campaign-stats.ts";
  import CampaignRow from "$lib/components/CampaignRow.svelte";
  import CampaignDrafts from "$lib/components/CampaignDrafts.svelte";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import RunnerBanner from "$lib/components/RunnerBanner.svelte";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import { REFRESH_OK, startAutoRefresh } from "$lib/auto-refresh.ts";
  import RefreshNotice from "$lib/components/RefreshNotice.svelte";
  import CampaignAttention from "$lib/components/campaign-list/CampaignAttention.svelte";
  import CampaignOpenWork from "$lib/components/campaign-list/CampaignOpenWork.svelte";
  import CampaignListToolbar from "$lib/components/campaign-list/CampaignListToolbar.svelte";
  import {
    CampaignList,
    ListView,
  } from "$lib/campaign-list/campaign-list.svelte.ts";
  import {
    PER_PAGE,
    isOwned,
    queryString,
  } from "$lib/campaign-list/list-query.ts";

  const viewer = $derived(viewerId());

  const list = new CampaignList();

  $effect(() => {
    if (auth.status === "loading" || list.loaded || list.loading) return;
    list.load();
  });

  // ----------------------------------------------------- the viewer's work
  // The clock claim expiries count against, a minute at a time.
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(timer);
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
    const s = list.stats.find((x) => x.name === t.campaignSlug);
    return s ? ctxOf(s) : null;
  };

  // A campaign whose default branch has moved since its row was read is read
  // again. The topic search, which finds new campaigns, runs again only when
  // the tab becomes visible. Logged out, every request counts against the
  // shared per-address limit, so polling waits for the tab to become visible.
  let refreshStatus = $state(REFRESH_OK);
  $effect(() => {
    refreshStatus = REFRESH_OK;
    if (!list.loaded) return;
    return startAutoRefresh({
      interval: () => (auth.user ? 10_000 : null),
      held: () => list.loading || runner.busy,
      onStatus: (status) => (refreshStatus = status),
      poll: (resumed) => list.poll(resumed),
    });
  });

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
        const s = list.stats.find((x) => x.repoId === c.repoId);
        if (s) await list.refresh(s);
      },
    );
  }

  // A background verdict refreshes its campaign's row, so the settled task
  // moves group.
  $effect(() =>
    pendingVerdicts.onSettled((entry) => {
      if (runner.busy) return;
      const s = list.stats.find((x) => x.repoId === entry.repoId);
      if (s) list.refresh(s);
    }),
  );

  // mei-friend returns the volunteer to the task's campaign page.
  const editorInput = (campaign: string, task_id: string) => ({
    task_id,
    campaign,
    base: location.origin,
  });
  const openEditor = async (t: MyTask) => {
    const s = list.stats.find((x) => x.name === t.campaignSlug);
    if (
      s &&
      pendingVerdicts.isProcessing({ kind: "claim", task: t.task }, s.repoId)
    )
      return;
    const result = await run(t, (c) =>
      invoke(commands.openEditor, editorInput(t.campaignSlug, t.task), c),
    );
    openMeiFriend(result);
  };
  // A submission on the task still being processed holds its row's actions.
  const processing = (t: MyTask) => {
    const s = list.stats.find((x) => x.name === t.campaignSlug);
    return s ? pendingVerdicts.taskProcessing(t.task, s.repoId) : false;
  };
  // Claim a campaign row's suggested next task, or continue the one held:
  // a task worked on in the app opens its page there (taskAction), an
  // encoding opens mei-friend; a clean review claim lands on the place the
  // review happens.
  async function claimNext(s: CampaignStats, next: NextTask) {
    const href =
      next.action === "review"
        ? null
        : taskActionHref(s.name, next, taskAction(next, nextTaskMode(next)));
    if (href) {
      await goto(href);
      return;
    }
    const c = ctxOf(s);
    const refresh = async () => {
      runner.log.step("Refreshing…");
      await list.refresh(s);
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
      if (result?.ok && result.outcome !== "pending") {
        await goto(reviewHref(s.name, next.locator, next.task));
      }
    }
  }

  // Wide screens show the viewer's work in a side column; narrower ones fold
  // it behind a one-line summary bar.
  const wide = new MediaQuery("min-width: 1280px", false);
  let workOpen = $state(false);
  let showCompleted = $state(false);
  let allAttention = $state(false);
  let allWork = $state(false);

  // ------------------------------------------------------------- the list
  const view = new ListView(page.url.searchParams, {
    get stats() {
      return list.stats;
    },
    get viewer() {
      return viewer;
    },
    get user() {
      return auth.user;
    },
  });
  let searchInput = $state<HTMLInputElement>();
  // "Yours" has no button without a login; a link with it shows every
  // campaign.
  $effect(() => {
    if (auth.status === "anonymous" && view.filter === "yours")
      view.filter = "all";
  });
  // Search, filter and sort live in the URL, so Back and a shared link
  // restore them; the defaults stay out of it.
  $effect(() => {
    const next = queryString(view);
    if (next === page.url.searchParams.toString()) return;
    goto(`/campaigns${next ? `?${next}` : ""}`, {
      replaceState: true,
      noScroll: true,
      keepFocus: true,
    });
  });
  // A changed search, filter or sort starts the listing over.
  $effect(() => {
    void view.search;
    void view.filter;
    void view.sort;
    view.visibleCount = PER_PAGE;
  });
</script>

<svelte:head>
  <title>Campaigns · Let's Encode!</title>
</svelte:head>

{#if runner.busy && runner.overlay}
  <LoadingOverlay
    log={runner.log}
    finished={runner.held}
    error={runner.result?.error}
    outcome={runner.result?.outcome}
    message={runner.result?.message}
    onContinue={() => runner.dismiss()}
  />
{/if}

<div class="screen">
  <h1 class="vh">Campaigns</h1>
  <RunnerBanner {runner} />
  <RefreshNotice status={refreshStatus} retrying={!!auth.user} bar={false} />

  <div class="layout" class:split={auth.user && wide.current}>
    {#if auth.user}
      <aside class="side">
        <CampaignAttention
          stats={list.stats}
          {viewer}
          user={auth.user}
          bind:showAll={allAttention}
        />
        <CampaignOpenWork
          stats={list.stats}
          {viewer}
          {now}
          wide={wide.current}
          loading={list.loading}
          incomplete={list.failed > 0 || list.incomplete}
          busy={runner.busy}
          {processing}
          onOpenEditor={openEditor}
          bind:open={workOpen}
          bind:showAll={allWork}
          bind:showCompleted
        />
      </aside>
    {/if}

    <section class="list">
      <CampaignListToolbar
        bind:search={view.search}
        bind:sort={view.sort}
        bind:filter={view.filter}
        bind:searchInput
        count={list.loaded ? view.filtered.length : "…"}
        failed={list.failed}
        showYours={!!auth.user}
      />
      {#if !list.error && list.incomplete}
        <Notice
          tone="warn"
          title="Some campaigns may be missing"
          detail="GitHub's search stopped before it was done."
          action={{
            label: "Try again",
            run: list.retry,
            disabled: list.loading,
          }}
        />
      {/if}
      {#if !list.error && list.failed > 0}
        <Notice
          tone="err"
          title={`${list.failed} campaign${list.failed === 1 ? "" : "s"} couldn't be loaded`}
          detail={`${list.partialRateLimit && auth.expired ? "Your GitHub login has expired. " : ""}${list.failure?.message ?? ""}`}
          action={{
            label: "Try again",
            run: list.retry,
            disabled: list.loading,
          }}
        />
      {/if}
      {#if list.error}
        <Notice
          tone="err"
          title="Couldn't load the campaigns"
          detail={`${list.rateLimit && auth.expired ? "Your GitHub login has expired. " : ""}${list.error.message}`}
          action={{
            label: "Try again",
            run: list.retry,
            disabled: list.loading,
          }}
        />
      {:else if list.loaded && list.stats.length === 0}
        <p class="note">No campaigns yet. Create one with New campaign.</p>
      {:else if (list.loading || auth.status === "loading") && list.stats.length === 0}
        <p class="note">Loading campaigns…</p>
      {:else if view.shown.length === 0}
        <p class="note noteline">
          <span>No campaign matches this search or filter.</span>
          <button
            type="button"
            class="btn"
            onclick={() => {
              view.search = "";
              view.filter = "all";
              searchInput?.focus();
            }}>Show all campaigns</button
          >
        </p>
      {:else}
        <div class="shelf">
          {#each view.shown as s (s.repoId)}
            <CampaignRow
              stats={s}
              owned={isOwned(s, auth.user)}
              viewer={viewer ?? ""}
              busy={runner.busy}
              onact={claimNext}
            />
          {/each}
        </div>
        {#if view.more > 0}
          <button
            type="button"
            class="btn showmore"
            onclick={() => (view.visibleCount += PER_PAGE)}
            >Show {Math.min(PER_PAGE, view.more)} more campaign{Math.min(
              PER_PAGE,
              view.more,
            ) === 1
              ? ""
              : "s"}
            <Icon name="chevron-down" size={12} /></button
          >
        {/if}
      {/if}
      {#if !auth.user && auth.status === "anonymous" && !list.rateLimit && !list.partialRateLimit}
        <p class="note login-hint noteline">
          <span
            >{#if auth.expired}Your GitHub login has expired.{/if}
            Browsing works logged out. Log in to claim a task or see your work here.</span
          >
          <button type="button" class="btn" onclick={() => login()}
            >Log in with GitHub</button
          >
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
  /* The campaign list: the toolbar, then the rows. */
  .list {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
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
    font-size: 12.5px;
    color: var(--ink-faint);
  }
  /* A note whose action follows it at the line's right end. */
  .noteline {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
</style>
