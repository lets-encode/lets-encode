<!--
  A card on the campaign list that holds a heading and linked rows. The
  heading and rows are the caller's markup; this component styles them by
  class: `.stitle` and `.phead` for the heading, `.items` for the row list,
  `.item` for a row, `.itext` for its text column, `.ititle` and `.isub` for
  the title and the faint line below it. The descendant selectors sit in
  `:where()` so each rule has the specificity of a scoped single-class rule
  and a caller's scoped rule on the same element overrides it.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    fold = false,
    children,
  }: {
    /** The card has no padding of its own; the row list keeps the inset. */
    fold?: boolean;
    children: Snippet;
  } = $props();
</script>

<section class="panel face-card" class:fold>
  {@render children()}
</section>

<style>
  .panel {
    padding: 14px 16px;
  }
  .panel.fold {
    padding: 0;
  }
  .panel.fold :global(:where(.items)) {
    padding: 0 16px 10px;
  }
  .panel :global(:where(.phead)) {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .panel > :global(.sectitle),
  .panel > :global(.phead) {
    margin-bottom: 6px;
  }
  .panel :global(:where(.items)) {
    display: flex;
    flex-direction: column;
  }
  .panel :global(:where(.item)) {
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
    .panel :global(a:hover:where(.item)) {
      background: var(--bg-tint);
    }
  }
  .panel :global(:where(.itext)) {
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
  .panel :global(:where(.ititle)) {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--ink);
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  :global(.layout:not(.split)) .panel :global(:where(.ititle)) {
    display: block;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .panel :global(:where(.isub)) {
    font-size: 12.5px;
    color: var(--ink-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
