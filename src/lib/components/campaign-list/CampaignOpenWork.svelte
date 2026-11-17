<!--
  The campaign list's "Your work" panel in three sections: the tasks the
  viewer holds (Your open tasks), their submissions that wait for other reviewers
  (Waiting for review), and their done tasks behind a toggle, with the full
  list in a dialog. On wide screens (`wide`) it is a panel in the side
  column; narrower it folds behind a one-line summary bar, and is left out
  for a volunteer with no work.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import DoneTasksDialog from "$lib/components/campaign-list/DoneTasksDialog.svelte";
  import ListPanel from "$lib/components/campaign-list/ListPanel.svelte";
  import { timeAgo } from "$lib/campaign-board.ts";
  import {
    reviewHref,
    taskAction,
    taskActionHref,
    taskHref,
  } from "$lib/campaign-graph.ts";
  import type { CampaignStats, MyTask } from "$lib/campaign-stats.ts";
  import {
    WORK_MAX,
    claimEndsSoon,
    claimMeta,
    contributingSince,
    doneTasks,
    reviewMeta,
    toDoOrder,
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
    /** Every waiting task is listed, not only the first few. */
    showAll: boolean;
    /** The done section is open. */
    showCompleted: boolean;
  } = $props();

  const tasks = $derived(viewerTasks(stats, viewer, now));
  const encoding = $derived(tasks.filter((t) => t.group === "encoding"));
  const validating = $derived(tasks.filter((t) => t.group === "validating"));
  const awaiting = $derived(tasks.filter((t) => t.group === "awaiting"));
  const done = $derived(doneTasks(tasks));
  // The viewer's first recorded action anywhere, for "contributing since".
  const since = $derived(contributingSince(stats, viewer));
  const toDo = $derived(toDoOrder(encoding, validating));
  const waiting = $derived(
    [...awaiting].sort(
      (a, b) =>
        Date.parse(b.submittedAt || "0") - Date.parse(a.submittedAt || "0") ||
        a.campaignSlug.localeCompare(b.campaignSlug) ||
        a.task.localeCompare(b.task),
    ),
  );
  const shownWaiting = $derived(showAll ? waiting : waiting.slice(0, WORK_MAX));
  const workSummary = $derived(
    summarise({
      incomplete,
      awaiting: awaiting.length,
      done: done.length,
    }),
  );
  let doneDialog = $state<DoneTasksDialog>();
</script>

<!-- Narrow screens drop the work bar for a volunteer with no work. -->
{#if wide || tasks.length > 0 || loading}
  <ListPanel fold={!wide}>
    {#if wide}
      <h2 class="sectitle">Your work</h2>
    {:else}
      <h2 class="barh">
        <button
          type="button"
          class="rowbtn workbar"
          aria-label={`Your work: ${toDo.length} open tasks, ${loading && tasks.length === 0 ? "loading" : workSummary}`}
          aria-expanded={open}
          aria-controls="worklist"
          onclick={() => (open = !open)}
        >
          <span class="phead"
            ><span class="btitle">Your work</span><span class="countpill"
              >{toDo.length} open</span
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
        {:else}
          <section class="wsec todo on-tint">
            <h3 class="whead">
              Your open tasks <span class="countpill">{toDo.length}</span>
            </h3>
            {#if toDo.length === 0}
              <p class="note">Nothing to do. Claim a task from a campaign.</p>
            {/if}
            {#each toDo as t (`${t.group}:${t.campaignSlug}:${t.task}:${t.subtask}`)}
              {@const soon = claimEndsSoon(t, now)}
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
                  {#if soon}<span class="isub soon">{soon}</span>{/if}
                  <span class="vh imeta">{claimMeta(t, now)}</span>
                </a>
                {#if t.group === "validating"}
                  <a
                    class="btn"
                    href={reviewHref(t.campaignSlug, t.locator, t.task)}
                    title={taskAction(t, "continue-review").title}>Review</a
                  >
                {:else}
                  {@const act = taskAction(t, "continue")}
                  {#if act.target === "mei-friend"}
                    <button
                      type="button"
                      class="btn"
                      disabled={busy || processing(t)}
                      onclick={() => onOpenEditor(t)}
                      title={act.title}
                      >Continue <Icon name="external" /></button
                    >
                  {:else}
                    <a
                      class="btn"
                      href={processing(t)
                        ? undefined
                        : (taskActionHref(t.campaignSlug, t, act) ?? undefined)}
                      aria-disabled={processing(t)}
                      title={act.title}>Continue</a
                    >
                  {/if}
                {/if}
              </div>
            {/each}
          </section>
          {#if waiting.length > 0}
            <section class="wsec wait on-tint">
              <div class="wrow">
                <h3 class="whead">
                  Waiting for review <span class="countpill"
                    >{waiting.length}</span
                  >
                </h3>
                {#if waiting.length > WORK_MAX}
                  <button
                    type="button"
                    class="btn btn-icon"
                    aria-expanded={showAll}
                    aria-label={showAll ? "Show fewer" : "Show all"}
                    title={showAll ? "Show fewer" : "Show all"}
                    onclick={() => (showAll = !showAll)}
                    ><Icon
                      name={showAll ? "chevron-up" : "chevron-down"}
                    /></button
                  >
                {/if}
              </div>
              {#each shownWaiting as t (`${t.campaignSlug}:${t.task}`)}
                <a
                  class="item plain"
                  href={taskHref(t.campaignSlug, t.task)}
                  title={reviewMeta(t, now)}
                >
                  <span class="itext">
                    <span class="ititle" title={t.title}>{t.title}</span>
                    <span class="isub">{t.campaign}</span>
                    <span class="vh imeta">{reviewMeta(t, now)}</span>
                  </span>
                  {#if t.threshold > 0}
                    <span class="iside"
                      >{t.passes} of {t.threshold}
                      {t.threshold === 1 ? "review" : "reviews"}</span
                    >
                  {/if}
                </a>
              {/each}
            </section>
          {/if}
          {#if done.length > 0}
            <section class="wsec done on-tint">
              <div class="wrow">
                <h3
                  class="whead"
                  title={since ? `Contributing since ${since}` : undefined}
                >
                  Done <span class="countpill">{done.length}</span>
                </h3>
                {#if showCompleted && done.length > WORK_MAX}
                  <button
                    type="button"
                    class="btn"
                    onclick={() => doneDialog?.show()}>View all</button
                  >
                {/if}
                <button
                  type="button"
                  class="btn btn-icon"
                  aria-expanded={showCompleted}
                  aria-label={showCompleted
                    ? "Hide done tasks"
                    : "Show done tasks"}
                  title={showCompleted ? "Hide done tasks" : "Show done tasks"}
                  onclick={() => (showCompleted = !showCompleted)}
                  ><Icon
                    name={showCompleted ? "chevron-up" : "chevron-down"}
                  /></button
                >
              </div>
              {#if showCompleted}
                {#each done.slice(0, WORK_MAX) as t (`${t.campaignSlug}:${t.task}:${t.subtask}`)}
                  <a
                    class="item plain"
                    href={taskHref(t.campaignSlug, t.task)}
                    title={reviewMeta(t, now)}
                  >
                    <span class="itext">
                      <span class="ititle" title={t.title}>{t.title}</span>
                      <span class="isub">{t.campaign}</span>
                    </span>
                    <span class="iside">{timeAgo(t.submittedAt, now)}</span>
                  </a>
                {/each}
              {/if}
            </section>
          {/if}
        {/if}
      </div>
    {/if}
    <DoneTasksDialog bind:this={doneDialog} {done} {now} />
  </ListPanel>
{/if}

<style>
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
    color: var(--ink-soft);
    border-radius: 14px;
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
    gap: 8px;
  }
  /* A section of the panel on its own tint; --wc is its heading colour. */
  .wsec {
    display: flex;
    flex-direction: column;
    padding: 8px 12px;
    border-radius: 10px;
  }
  .wsec.todo {
    --wc: var(--accent);
    background: var(--accent-tint);
  }
  .wsec.wait {
    --wc: var(--ink-soft);
    background: var(--bg-alt);
  }
  .wsec.done {
    --wc: var(--ok);
    background: var(--ok-wash);
  }
  /* A section's heading and, on the right, the button that lists more. */
  .wrow {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .whead {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 26px;
    margin: 0;
    font: 600 12.5px var(--font);
    color: var(--wc);
  }
  /* Buttons in a section are 26px tall, the height of its heading. */
  .wsec .btn {
    min-height: 26px;
    padding: 3px 12px;
  }
  /* An icon button in a section is 26px wide, a circle at that height. */
  .wsec .btn-icon {
    width: 26px;
    padding: 0;
  }
  /* On a coarse pointer a 26px button takes a 44px press through an
     invisible ::after. A row's button reaches 9px past its top and bottom;
     a heading's button reaches 14px up into the section's padding and the
     gap above it, and 4px down to the first row. */
  @media (pointer: coarse) {
    .wsec .btn {
      position: relative;
    }
    .wsec .btn::after {
      content: "";
      position: absolute;
      inset: -9px 0;
    }
    .wrow .btn::after {
      inset: -14px 0 -4px;
    }
  }
  /* The gap between a section's heading and the row that follows it. */
  .wrow:not(:last-child),
  .wsec > .whead:not(:last-child) {
    margin-bottom: 4px;
  }
  .wsec .note {
    padding: 4px 0;
  }
  .wsec .item {
    margin: 0 -8px;
    padding: 6px 8px;
  }
  .wsec .plain .ititle {
    font-weight: 400;
  }
  @media (hover: hover) {
    a.itext:hover .ititle {
      color: var(--link);
    }
    .wsec .item:hover {
      background: color-mix(in srgb, var(--ink) 6%, transparent);
    }
  }
  .isub.soon {
    color: var(--warn);
  }
  /* A row's progress or date, on the right. */
  .iside {
    font-size: 12px;
    color: var(--ink-soft);
    white-space: nowrap;
  }
  /* The claim or review details: a tooltip where a pointer can hover,
     a visible line on phones, where it replaces the expiry line and the
     review count. */
  @media (max-width: 560px) {
    .imeta {
      position: static;
      width: auto;
      height: auto;
      white-space: normal;
      font-size: 12.5px;
      color: var(--ink-faint);
    }
    .isub.soon,
    .wait .iside {
      display: none;
    }
  }
</style>
