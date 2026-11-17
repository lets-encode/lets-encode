<!--
  A progress bar filled by the share done, with a label beside it: "X of Y
  tasks done" (a campaign's progress), the host's own (`label`), or none
  (`label={null}`). With `review` the bar is three segments in the stage
  colours: done, in review and the rest. `title` names the bar where no
  label says what it shows. The bar's width is the host's: --track-w sets
  its largest width (the whole row by default); it shrinks to 48px.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    done,
    total,
    review,
    label,
    title,
  }: {
    done: number;
    total: number;
    review?: number;
    label?: Snippet | null;
    title?: string;
  } = $props();
  const pct = $derived(total ? Math.round((done / total) * 100) : 0);
</script>

<span class="progressbar">
  <span
    class="track"
    class:segments={review !== undefined}
    role={title ? "img" : undefined}
    aria-label={title}
    {title}
  >
    {#if review === undefined}
      <span class="fill" style:width="{pct}%"></span>
    {:else}
      {#if done}<span class="part done" style:flex={done}></span>{/if}
      {#if review}<span class="part review" style:flex={review}></span>{/if}
      {#if total - done - review > 0}
        <span class="part" style:flex={total - done - review}></span>
      {/if}
    {/if}
  </span>
  {#if label}<span class="plabel">{@render label()}</span
    >{:else if label === undefined}<span class="plabel"
      >{done} of {total} tasks done</span
    >{/if}
</span>

<style>
  .progressbar {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .track {
    flex: 0 1 var(--track-w, 100%);
    min-width: 48px;
    height: 6px;
    border-radius: 3px;
    background: var(--bg-tint);
    overflow: hidden;
  }
  /* The dark theme's tint sits too close to the card for an empty track. */
  :global([data-theme="dark"]) .track {
    background: var(--line-strong);
  }
  .fill {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, var(--blue), var(--green));
  }
  .track.segments {
    display: flex;
    gap: 2px;
  }
  .part.done {
    background: var(--green);
  }
  .part.review {
    background: var(--warn-line);
  }
  .plabel {
    flex: none;
    font-size: 12px;
    color: var(--ink-soft);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
</style>
