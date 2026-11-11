<!--
  The campaign list's "Your open work" panel: the viewer's encoding, review
  and awaiting tasks, then their done tasks behind a toggle. On wide screens
  (`wide`) it is a panel in the side column; narrower it folds behind a
  one-line summary bar, and is left out for a volunteer with no work.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import {
    reviewHref,
    taskAction,
    taskActionHref,
    taskHref,
  } from "$lib/campaign-graph.ts";
  import type { CampaignStats, MyTask } from "$lib/campaign-stats.ts";
  import {
    SIDE_MAX,
    claimMeta,
    contributingSince,
    doneTasks,
    openWorkOrder,
    reviewMeta,
    viewerTasks,
    workSummary as summarise,
  } from "$lib/campaign-list/my-work.ts";

  let {
    stats,
    viewer,
    now,
    wide,
    loading,
    incomplete,
    busy,
    processing,
    onOpenEditor,
    open = $bindable(),
    showAll = $bindable(),
    showCompleted = $bindable(),
  }: {
    stats: CampaignStats[];
    /** The viewer's account id; empty when logged out. */
    viewer: string;
    /** The clock claim expiries and times count against. */
    now: number;
    /** A wide screen: a side-column panel rather than a folding bar. */
    wide: boolean;
    /** The campaign listing is loading. */
    loading: boolean;
    /** Some campaigns could not be loaded or may be missing. */
    incomplete: boolean;
    /** A command is running. */
    busy: boolean;
    /** A submission on the task is still being processed. */
    processing: (t: MyTask) => boolean;
    onOpenEditor: (t: MyTask) => void;
    /** The folded bar is open. */
    open: boolean;
    /** Every open task is listed, not only the first few. */
    showAll: boolean;
    showCompleted: boolean;
  } = $props();

  const tasks = $derived(viewerTasks(stats, viewer, now));
  const encoding = $derived(tasks.filter((t) => t.group === "encoding"));
  const validating = $derived(tasks.filter((t) => t.group === "validating"));
  const awaiting = $derived(tasks.filter((t) => t.group === "awaiting"));
  const done = $derived(doneTasks(tasks));
  // The viewer's first recorded action anywhere, for "contributing since".
  const since = $derived(contributingSince(stats, viewer));
  // Counts only work the viewer can act on; submissions waiting on other
  // reviewers appear in the summary text.
  const openCount = $derived(encoding.length + validating.length);
  const workSummary = $derived(
    summarise({
      incomplete,
      encoding: encoding.length,
      validating: validating.length,
      awaiting: awaiting.length,
      done: done.length,
    }),
  );
  const openWork = $derived(openWorkOrder(encoding, validating, awaiting));
  const shownWork = $derived(showAll ? openWork : openWork.slice(0, SIDE_MAX));
</script>

<!-- Narrow screens drop the work bar for a volunteer with no work. -->
{#if wide || tasks.length > 0 || loading}
  <section class="panel" class:fold={!wide}>
    {#if wide}
      <div class="phead">
        <h2 class="stitle">Your open work</h2>
        <span class="countpill">{openCount} to do</span>
      </div>
    {:else}
      <h2 class="barh">
        <button
          type="button"
          class="workbar"
          aria-label={`Your open work: ${openCount} to do, ${loading && tasks.length === 0 ? "loading" : workSummary}`}
          aria-expanded={open}
          aria-controls="worklist"
          onclick={() => (open = !open)}
        >
          <span class="phead"
            ><span class="btitle">Your open work</span><span class="countpill"
              >{openCount} to do</span
            ></span
          >
          <span class="wsum"
            >{loading && tasks.length === 0 ? "Loading…" : workSummary}</span
          >
          <Icon name={open ? "chevron-up" : "chevron-down"} />
        </button>
      </h2>
    {/if}
    {#if wide || open}
      <div class="items" id="worklist">
        {#if loading && tasks.length === 0}
          <p class="note">Loading your claimed tasks…</p>
        {:else if openWork.length === 0}
          <p class="note">No open work. Claim a task from a campaign.</p>
        {/if}
        {#each shownWork as t (`${t.group}:${t.campaignSlug}:${t.task}:${t.subtask}`)}
          {#if t.group === "awaiting"}
            <a
              class="item"
              href={taskHref(t.campaignSlug, t.task)}
              title={reviewMeta(t, now)}
            >
              <span class="itext">
                <span class="ititle" title={t.title}>{t.title}</span>
                <span class="isub">{t.campaign}</span>
                <span class="imeta">{reviewMeta(t, now)}</span>
              </span>
              <span class="chip">review</span>
            </a>
          {:else}
            <div class="item">
              <a
                class="itext"
                href={t.group === "validating"
                  ? reviewHref(t.campaignSlug, t.locator, t.task)
                  : taskHref(t.campaignSlug, t.task)}
                title={claimMeta(t, now)}
              >
                <span class="ititle" title={t.title}>{t.title}</span>
                <span class="isub">{t.campaign}</span>
                <span class="imeta">{claimMeta(t, now)}</span>
              </a>
              {#if t.group === "encoding"}
                <span class="chip">encoding</span>
              {:else}
                <span class="chip">reviewing</span>
              {/if}
              {#if t.group === "encoding"}
                {@const act = taskAction(t, "continue")}
                <div class="iacts">
                  {#if act.target === "mei-friend"}
                    <button
                      type="button"
                      class="btn"
                      disabled={busy || processing(t)}
                      onclick={() => onOpenEditor(t)}
                      title={act.title}
                      >{act.label} <Icon name="external" /></button
                    >
                  {:else}
                    <a
                      class="btn"
                      href={processing(t)
                        ? undefined
                        : (taskActionHref(t.campaignSlug, t, act) ?? undefined)}
                      aria-disabled={processing(t)}
                      title={act.title}>{act.label}</a
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
            class="btn moretoggle"
            aria-expanded={showAll}
            onclick={() => (showAll = !showAll)}
            >{showAll ? "Show fewer" : `Show all ${openWork.length}`}<Icon
              name={showAll ? "chevron-up" : "chevron-down"}
            /></button
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
                title={reviewMeta(t, now)}
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

<style>
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
  .panel > .phead {
    margin-bottom: 6px;
  }
  .stitle {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--ink);
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
     still tells similar tasks apart; full width (the page's .layout without
     .split), they keep to one line. */
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
  :global(.layout:not(.split)) .ititle {
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
  }
  .donerow .ititle {
    font-weight: 400;
    color: var(--ink-soft);
  }
  .check {
    display: flex;
    color: var(--ok);
  }
</style>
