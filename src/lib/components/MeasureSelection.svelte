<!--
  The measure selected in a ScorePreview, for the side panel's Selection tab:
  its name and page, stepping to the previous and next measure, commenting on
  it and clearing the selection. Without a selection it shows `empty`. A view
  adds what it says about the measure below the heading (`children`) and its
  own actions before Comment (`actions`).
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type ScorePreview from "./ScorePreview.svelte";
  import Icon from "./Icon.svelte";
  import StepGlyph from "./StepGlyph.svelte";

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
  <div class="selpanel">
    <div class="selhead">
      <span class="selname"
        ><StepGlyph kind="measure" tone="var(--ink-measure)" size={20} />Measure
        {label}</span
      >
      {#if page >= 0}<span class="selwhere">page {page + 1}</span>{/if}
      <span class="selnav">
        <button
          type="button"
          class="btn btn-icon"
          onclick={() => preview?.stepMeasure(-1)}
          disabled={!preview?.canStepMeasure(-1)}
          aria-label="Previous measure"
          title="Previous measure"><Icon name="chevron-left" /></button
        >
        <button
          type="button"
          class="btn btn-icon"
          onclick={() => preview?.stepMeasure(1)}
          disabled={!preview?.canStepMeasure(1)}
          aria-label="Next measure"
          title="Next measure"><Icon name="chevron-right" /></button
        >
      </span>
    </div>
    {@render children?.()}
    <div class="selactions">
      {@render actions?.()}
      {#if oncomment}
        <button
          type="button"
          class="btn"
          onclick={oncomment}
          title={`Comment on measure ${label}`}
          ><Icon name="comment" />Comment</button
        >
      {/if}
      <button
        type="button"
        class="btn"
        onclick={() => preview?.clearSelection()}
        title="Clear the measure selection"
        ><Icon name="close" />Deselect</button
      >
    </div>
  </div>
{:else}
  <p class="selnone">{empty}</p>
{/if}
