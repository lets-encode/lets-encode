<!--
  The measure selected in a ScorePreview, for the side panel's Selection tab:
  its name and page (SelectionPanel), stepping to the previous and next
  measure (also A and D), commenting on it and clearing the selection. Without a selection it shows `empty`. A view
  adds what it says about the measure below the heading (`children`) and its
  own actions before Comment (`actions`).
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type ScorePreview from "./ScorePreview.svelte";
  import SelectionPanel from "./SelectionPanel.svelte";

  let {
    label,
    page,
    preview,
    oncomment,
    empty,
    children,
    actions,
  }: {
    /** The selected measure's label; null when none is selected. */
    label: string | null;
    /** The 0-based page the measure is on; -1 when unknown. */
    page: number;
    preview: ReturnType<typeof ScorePreview> | undefined;
    /** Opens the comment composer; without it there is no Comment button. */
    oncomment?: () => void;
    /** The text shown without a selection. */
    empty: string;
    /** What the view says about the selected measure, below the heading. */
    children?: Snippet;
    /** The view's own actions on the selected measure. */
    actions?: Snippet;
  } = $props();
</script>

{#if label}
  <SelectionPanel
    glyph="measure"
    tone="var(--ink-measure)"
    {page}
    item="measure"
    onstep={(dir) => preview?.stepMeasure(dir)}
    canStep={(dir) => !!preview?.canStepMeasure(dir)}
    keys={["A", "D"]}
    {actions}
    {oncomment}
    commentTitle={`Comment on measure ${label}`}
    ondeselect={() => preview?.clearSelection()}
    deselectTitle="Clear the measure selection"
    {children}
  >
    {#snippet name()}Measure {label}{/snippet}
  </SelectionPanel>
{:else}
  <p class="selnone">{empty}</p>
{/if}
