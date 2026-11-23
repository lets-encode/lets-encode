<!--
  A task workspace's footer at the side panel's bottom (.wfoot): one wrapping
  row with the task's summary on a line of its own, the host's status, and
  the task's buttons at the right end.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    summary,
    status,
    children,
    class: extra = "",
  }: {
    /** The task's counts, on a line of their own above the row. */
    summary?: Snippet;
    /** The host's status; it takes the room left of the buttons. */
    status?: Snippet;
    /** The task's buttons, and whatever else it puts in the row. */
    children: Snippet;
    /** Classes the task adds to the row. */
    class?: string;
  } = $props();
</script>

<div class="wfoot {extra}">
  {#if summary}<span class="abcount wsum">{@render summary()}</span>{/if}
  {#if status}<span class="wstatus">{@render status()}</span>{/if}
  {@render children()}
</div>

<style>
  .wfoot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .wsum {
    flex-basis: 100%;
  }
  .wstatus {
    flex: 1;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    min-width: 0;
  }
  .abcount {
    font-size: 12.5px;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
