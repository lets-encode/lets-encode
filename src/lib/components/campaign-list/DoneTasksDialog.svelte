<!--
  The viewer's done tasks in a dialog: a search field and a campaign select
  above the tasks, which are grouped by campaign. A group folds and lists
  PAGE tasks at a time. `show()` opens it.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import { timeAgo } from "$lib/campaign-board.ts";
  import { taskHref } from "$lib/campaign-graph.ts";
  import type { MyTask } from "$lib/campaign-stats.ts";
  import { doneGroups } from "$lib/campaign-list/my-work.ts";

  let {
    done,
    now,
  }: {
    /** The done tasks, latest first. */
    done: MyTask[];
    /** The clock the tasks' times count against. */
    now: number;
  } = $props();

  /** A group lists this many tasks, and as many more on request. */
  const PAGE = 50;

  let dialog = $state<HTMLDialogElement>();
  // The list is rendered only while the dialog is open.
  let shown = $state(false);
  let query = $state("");
  let campaign = $state("");
  // Groups the viewer folded or unfolded, and how many tasks each lists.
  let folded = $state<Record<string, boolean>>({});
  let limits = $state<Record<string, number>>({});

  const campaigns = $derived(doneGroups(done));
  const groups = $derived(doneGroups(done, query, campaign));
  const matches = $derived(groups.reduce((n, g) => n + g.tasks.length, 0));

  // Without a choice by the viewer the first group is open, and every group
  // while a search narrows the list.
  const isOpen = (slug: string, index: number) =>
    folded[slug] === undefined
      ? index === 0 || query.trim() !== ""
      : !folded[slug];

  export function show() {
    shown = true;
    dialog?.showModal();
  }
</script>

<dialog
  bind:this={dialog}
  class="dialog donedialog"
  aria-labelledby="done-dialog-title"
  onclick={(e) => {
    if (e.target === dialog) dialog?.close();
  }}
  onclose={() => {
    shown = false;
    query = "";
    campaign = "";
  }}
>
  {#if shown}
    <div class="dbody">
      <div class="dhead">
        <h2 class="sectitle" id="done-dialog-title">Your done tasks</h2>
        <span class="countpill"
          >{matches === done.length
            ? done.length
            : `${matches} of ${done.length}`}</span
        >
        <button
          type="button"
          class="btn btn-icon dclose"
          aria-label="Close"
          title="Close"
          onclick={() => dialog?.close()}><Icon name="close" /></button
        >
      </div>
      <div class="dtools">
        <label class="search">
          <Icon name="search" />
          <input
            type="search"
            bind:value={query}
            placeholder="Task or campaign"
            aria-label="Search done tasks"
          />
        </label>
        <select class="ctl" bind:value={campaign} aria-label="Campaign">
          <option value="">All campaigns</option>
          {#each campaigns as c (c.campaignSlug)}
            <option value={c.campaignSlug}>{c.campaign}</option>
          {/each}
        </select>
      </div>
      <div class="dlist">
        {#each groups as g, i (g.campaignSlug)}
          {@const open = isOpen(g.campaignSlug, i)}
          {@const limit = limits[g.campaignSlug] ?? PAGE}
          <section>
            <h3 class="ghead">
              <button
                type="button"
                class="rowbtn gbtn"
                aria-expanded={open}
                onclick={() => (folded[g.campaignSlug] = open)}
              >
                <Icon
                  name={open ? "chevron-down" : "chevron-right"}
                  size={12}
                />
                <span class="gname">{g.campaign}</span>
                <span class="countpill">{g.tasks.length}</span>
              </button>
            </h3>
            {#if open}
              {#each g.tasks.slice(0, limit) as t (`${t.task}:${t.subtask}`)}
                <a class="drow" href={taskHref(t.campaignSlug, t.task)}>
                  <span class="dtitle">{t.title}</span>
                  <span class="ddate">{timeAgo(t.submittedAt, now)}</span>
                </a>
              {/each}
              {#if g.tasks.length > limit}
                <button
                  type="button"
                  class="btn dmore"
                  onclick={() => (limits[g.campaignSlug] = limit + PAGE)}
                  >Show {Math.min(PAGE, g.tasks.length - limit)} more</button
                >
              {/if}
            {/if}
          </section>
        {:else}
          <p class="note">No done task matches.</p>
        {/each}
      </div>
    </div>
  {/if}
</dialog>

<style>
  .donedialog {
    width: 720px;
    max-width: calc(100vw - 32px);
    padding: 0;
  }
  .dbody {
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 640px;
    max-height: calc(100dvh - 64px);
    padding: 16px 20px 20px;
    box-sizing: border-box;
  }
  .dhead {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dclose {
    margin-left: auto;
  }
  .dtools {
    display: flex;
    gap: 8px;
  }
  .dtools .search {
    flex: 1;
  }
  /* The select is as high as the search field. */
  .dtools .ctl {
    height: 36px;
    min-width: 0;
    max-width: 45%;
  }
  .dlist {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .dlist section {
    display: flex;
    flex-direction: column;
  }
  .ghead {
    margin: 0;
    font: inherit;
  }
  .gbtn {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 32px;
    padding: 4px 10px;
    box-sizing: border-box;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-soft);
    background: var(--bg-alt);
    border-radius: 8px;
  }
  .gname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .drow {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 7px 10px;
    color: inherit;
    text-decoration: none;
    border-bottom: 1px solid var(--bg-tint);
  }
  .dtitle {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    color: var(--ink);
  }
  .ddate {
    font-size: 12px;
    color: var(--ink-soft);
    white-space: nowrap;
  }
  @media (hover: hover) {
    .drow:hover {
      background: var(--bg-tint);
    }
    .gbtn:hover {
      color: var(--ink);
    }
  }
  .dmore {
    align-self: flex-start;
    margin: 8px 0 4px 10px;
  }
  /* On a phone the dialog fills the screen. */
  @media (max-width: 560px) {
    .donedialog {
      width: 100vw;
      max-width: none;
      height: 100dvh;
      max-height: none;
      margin: 0;
      border-radius: 0;
    }
    .dbody {
      height: 100%;
      max-height: none;
      padding: 12px 16px 16px;
    }
  }
</style>
