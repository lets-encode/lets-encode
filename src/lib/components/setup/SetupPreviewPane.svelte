<!--
  The score setup's preview column, beside the source: the rendered setup on
  its sheet with the staff numbers in the sheet's left gutter.
-->
<script lang="ts">
  import type { SetupPreview } from "$lib/setup/setup-preview.svelte.ts";

  let {
    preview,
    meterValid,
    groupsValid,
    markable,
    picking,
    lit,
    onpointerdown,
    onpointermove,
    onclick,
  }: {
    preview: SetupPreview;
    meterValid: boolean;
    groupsValid: boolean;
    /** Whether groups are being marked in the preview. */
    markable: boolean;
    /** Whether a click on a staff names it in a reviewer's change request. */
    picking: boolean;
    /** The coloured staves (1-based), whose numbers are coloured too. */
    lit: { start: number; end: number } | null;
    onpointerdown: (e: PointerEvent) => void;
    onpointermove: (e: PointerEvent) => void;
    onclick: (e: MouseEvent) => void;
  } = $props();
</script>

<section class="previewbox" aria-label="Preview of the setup">
  <span class="page-label">Preview of the setup</span>
  {#if !meterValid}
    <p class="muted">Enter a whole number of beats to see the preview.</p>
  {:else if !groupsValid}
    <p class="muted">Fix the staff groups to see the preview.</p>
  {:else if preview.previewError}
    <p class="msg-error">{preview.previewError}</p>
  {:else if preview.previewSvg}
    <!-- In step 2 the staves take clicks and taps; the Groups section
         of the panel is the path without a pointer. -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      class="sheet"
      class:marking={markable}
      class:picking
      class:sized={!!preview.previewSize}
      style:--w={preview.previewSize ? `${preview.previewSize.width}px` : null}
      style:--offset={preview.previewSize
        ? `${preview.previewSize.offset}px`
        : null}
      bind:this={preview.sheetEl}
      bind:clientWidth={preview.sheetW}
      bind:clientHeight={preview.sheetH}
      {onpointerdown}
      {onpointermove}
      {onclick}
    >
      <!-- Rendered by Verovio and sanitised in verovio-render.ts. -->
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      {@html preview.previewSvg}
      <!-- The staff numbers, drawn over the rendering's left margin;
           they take no clicks. -->
      {#each preview.staffMarks as y, i (i)}
        <span
          class="staffmark"
          class:lit={!!lit && i + 1 >= lit.start && i + 1 <= lit.end}
          style:top="{y}px"
          aria-hidden="true">{i + 1}</span
        >
      {/each}
    </div>
  {:else}
    <p class="muted">Rendering…</p>
  {/if}
</section>

<style>
  .muted {
    color: var(--ink-faint);
    font-size: 0.9rem;
  }
  /* The preview column: a sheet at the column's full size with the
     rendered setup at the width the script computes (--w), its first staff
     level with the source's (--offset). Until measured, the rendering takes
     the column's width, scaled down to its height. */
  .previewbox {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 0;
  }
  .sheet {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    background: var(--facsimile-paper);
    border: 1px solid var(--line-input);
    box-shadow: var(--shadow-paper);
    padding: 8px 8px 8px 28px;
    overflow: hidden;
  }
  /* A staff's number in the sheet's left gutter, on the paper's white in
     both themes. */
  .staffmark {
    position: absolute;
    left: 0;
    width: 24px;
    transform: translateY(-50%);
    font: 600 11px var(--font);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    text-align: right;
    color: #666d83;
    pointer-events: none;
  }
  .staffmark.lit {
    color: #1b66c7;
  }
  .sheet > :global(svg) {
    display: block;
    flex: none;
    align-self: flex-start;
    width: var(--w, 100%);
    height: auto;
    max-height: 100%;
    margin-top: var(--offset, 0);
  }
  .sheet.sized > :global(svg) {
    max-height: none;
  }
  /* Step 2: the staves take clicks and taps, the preview scrolling when
     they need more than its height. */
  .sheet.picking {
    cursor: pointer;
  }
  .sheet.marking {
    overflow-y: auto;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
  }
  /* The staves a row of the form points at, and the marked ones. */
  .sheet :global(g.staff.pointed),
  .sheet :global(g.staff.pointed *) {
    fill: #1b66c7;
    stroke: #1b66c7;
  }
</style>
