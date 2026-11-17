<!--
  The campaign list's "Needs your attention" panel: open change requests on
  the viewer's own campaigns and unresolved comments on their work, at most
  five (two on phones) until all are asked for. Renders nothing when there is
  nothing to show.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import ListPanel from "$lib/components/campaign-list/ListPanel.svelte";
  import { MediaQuery } from "svelte/reactivity";
  import { handle, taskHref } from "$lib/campaign-graph.ts";
  import type { CampaignStats } from "$lib/campaign-stats.ts";
  import {
    SIDE_MAX,
    attentionItems,
    openComments,
  } from "$lib/campaign-list/my-work.ts";

  let {
    stats,
    viewer,
    user,
    showAll = $bindable(),
  }: {
    stats: CampaignStats[];
    /** The viewer's account id; empty when logged out. */
    viewer: string;
    user: { login: string } | null;
    /** Every item is listed, not only the first few. */
    showAll: boolean;
  } = $props();

  // Phones list fewer attention items, so the campaigns stay near the top.
  const phone = new MediaQuery("max-width: 560px", false);
  const attentionMax = $derived(phone.current ? 2 : SIDE_MAX);
  const attention = $derived(
    attentionItems(stats, user, openComments(stats, viewer)),
  );
  const shownAttention = $derived(
    showAll ? attention : attention.slice(0, attentionMax),
  );
</script>

{#if attention.length > 0}
  <ListPanel>
    <h2 class="sectitle danger">
      <img class="hand-attn" src="/attention-hand.svg" alt="" />Needs your
      attention
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
              class="chip chip-fail"
              title="A review asked for changes; the task is back with its encoder."
              >Change request</span
            >
          </a>
        {:else}
          <a class="item" href={taskHref(a.feed.campaignSlug, a.feed.task)}>
            <span class="itext">
              <span class="ititle" title={a.feed.taskTitle}
                >{a.feed.taskTitle}</span
              >
              <span class="isub" title={a.feed.comment.body}
                >@{handle(a.feed.logins, a.feed.comment.author_id)}: “{a.feed
                  .comment.body}”</span
              >
            </span>
            <span class="chip chip-note">Comment</span>
          </a>
        {/if}
      {/each}
      {#if attention.length > attentionMax}
        <button
          type="button"
          class="btn moretoggle"
          aria-expanded={showAll}
          onclick={() => (showAll = !showAll)}
          >{showAll ? "Show fewer" : `Show all ${attention.length}`}<Icon
            name={showAll ? "chevron-up" : "chevron-down"}
          /></button
        >
      {/if}
    </div>
  </ListPanel>
{/if}

<style>
  .sectitle.danger {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  /* The orange finger-up hand leads the attention section. */
  .hand-attn {
    height: 22px;
    flex: none;
  }
  .moretoggle {
    align-self: flex-start;
  }
</style>
