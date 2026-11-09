<!--
  A page viewer's toolbar (.vtoolbar, ui.css): the viewer's controls in one
  order, then at the right end the paging and what follows it (the help,
  the ⋯ menu). A narrow toolbar (a phone) is one row at touch size: its
  dividers give way, the page label gives up its reserved width, and its
  buttons take a 44px press area, as they do on any touch screen.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    children,
    end,
    narrow = false,
    class: extra = "",
  }: {
    children: Snippet;
    /** The right end: the paging, then the help and the ⋯ menu. */
    end: Snippet;
    narrow?: boolean;
    /** Classes the viewer adds for its own styles. */
    class?: string;
  } = $props();
</script>

<div class="vtoolbar {extra}" class:narrow>
  {@render children()}
  <span class="tspacer"></span>
  <div class="pgnav">{@render end()}</div>
</div>

<style>
  .tspacer {
    flex: 1;
  }
  .vtoolbar.narrow {
    gap: 4px;
    padding: 4px 6px;
    /* The 44px press areas reach past the toolbar's edge. */
    overflow-x: visible;
  }
  .vtoolbar.narrow :global(.vline) {
    display: none;
  }
  .vtoolbar.narrow :global(.pglabel) {
    min-width: 0 !important;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* 32px buttons that take a 44px press through an invisible ::after. */
  .vtoolbar.narrow :global(.tbtn) {
    position: relative;
    min-width: 32px;
    min-height: 32px;
  }
  .vtoolbar.narrow :global(.tbtn)::after {
    content: "";
    position: absolute;
    inset: -6px -3px;
  }
  @media (pointer: coarse) {
    .vtoolbar :global(.tbtn) {
      position: relative;
      min-width: 32px;
      min-height: 32px;
    }
    .vtoolbar :global(.tbtn)::after {
      content: "";
      position: absolute;
      inset: -6px -3px;
    }
  }
</style>
