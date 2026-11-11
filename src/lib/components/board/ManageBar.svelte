<!--
  The owner's manage takeover header: back to the board, the campaign's
  name, when expired claims were last released, and the button that
  releases them now.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import { timeAgo } from "$lib/campaign-board.ts";
  import type { HistoryRow } from "$lib/campaign-tables.ts";

  let {
    name,
    history,
    busy,
    onback,
    onreap,
  }: {
    /** The campaign's title, else its repository name. */
    name: string;
    history: HistoryRow[];
    busy: boolean;
    onback: () => void;
    onreap: () => void;
  } = $props();

  // The reaper's last trace in the history, for the manage header.
  const lastReap = $derived(
    history.findLast((h) => h.action === "reap") ?? null,
  );
</script>

<h1 class="vh">{name} · Manage</h1>
<div class="crumbrow">
  <button
    type="button"
    class="btn backlink"
    title="Back to the board"
    onclick={onback}><Icon name="arrow-left" /> Board</button
  >
  <span class="bcsep">/</span>
  <span class="crumbtitle">{name}</span>
  <span class="crumbsub">· Manage</span>
  <span class="ownerpill">owner</span>
  <span class="cspacer"></span>
  <span class="reapline">
    {#if lastReap}
      Expired claims were last released {timeAgo(lastReap.timestamp)}
    {:else}
      No expired claims have been released yet
    {/if}
  </span>
  <button
    type="button"
    class="btn"
    onclick={() => onreap()}
    disabled={busy}
    title="Releases the claims whose lock has expired"
    >Release expired claims now</button
  >
</div>

<style>
  .crumbrow {
    flex: none;
    padding: 14px 32px 0;
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }
  .backlink {
    flex: none;
  }
  .bcsep {
    color: var(--line-input);
  }
  .crumbtitle {
    font-size: 15px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .crumbsub {
    font-size: 15px;
    color: var(--ink-faint);
    flex: none;
  }
  .ownerpill {
    flex: none;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--owner);
    background: var(--owner-bg);
    border: 1px solid var(--owner-line);
    border-radius: 999px;
    line-height: 1;
    padding: 3px 10px;
  }
  .cspacer {
    flex: 1;
  }
  .reapline {
    font-size: 12.5px;
    color: var(--ink-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
