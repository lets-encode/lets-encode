<!--
  The score setup's source side: the first measure's page, framed on the
  measure and the names in front of its system, the measure outlined, or a
  comment anchor's page whole until the fit button returns; then the divider
  that moves the boundary to the preview, each side keeping at least a fifth
  of the work area's width.
-->
<script lang="ts">
  import FacsimileFrame from "$lib/components/FacsimileFrame.svelte";
  import PaneDivider from "$lib/components/PaneDivider.svelte";
  import type { PageModel } from "$lib/mei-facsimile.ts";
  import type { FirstMeasure } from "$lib/setup/source-frame.ts";

  let {
    url,
    page,
    shownPage,
    firstMeasure,
    anchorPage,
    onfit,
    align,
    desk,
    split = $bindable(),
    facsW = $bindable(),
    facsH = $bindable(),
  }: {
    /** The shown page's image. */
    url: string;
    page: PageModel;
    /** The shown page's index. */
    shownPage: number;
    firstMeasure: FirstMeasure;
    /** The page a comment anchor shows whole; null while the first measure is shown. */
    anchorPage: number | null;
    onfit: () => void;
    align: { uly: number; lry: number; top: number; bottom: number } | null;
    /** The work area the divider divides. */
    desk: HTMLElement | undefined;
    /** The source side's share of the work area's width. */
    split: number;
    /** The facsimile box's size, in CSS pixels. */
    facsW: number;
    facsH: number;
  } = $props();
</script>

<section
  class="facscol"
  style:flex-basis={`${split * 100}%`}
  aria-label="Source"
>
  <span class="page-label"
    >{anchorPage === null
      ? "Facsimile · first measure"
      : `Page ${shownPage + 1} · Facsimile`}</span
  >
  <div class="facsbox" bind:clientWidth={facsW} bind:clientHeight={facsH}>
    <FacsimileFrame
      {url}
      width={page.width}
      height={page.height}
      frame={anchorPage === null
        ? firstMeasure.frame
        : { ulx: 0, uly: 0, lrx: page.width, lry: page.height }}
      mark={shownPage === firstMeasure.page ? firstMeasure.box : undefined}
      label={`Page ${shownPage + 1} of the source`}
      fitLabel="Show the first measure"
      away={anchorPage !== null}
      {onfit}
      {align}
    />
  </div>
</section>
<PaneDivider
  label="Resize the source and the preview"
  bind:value={split}
  min={0.2}
  max={0.8}
  step={0.05}
  fraction
  at={(e) => {
    const box = desk!.getBoundingClientRect();
    return (e.clientX - box.left) / box.width;
  }}
/>

<style>
  .facscol {
    flex-grow: 0;
    flex-shrink: 0;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* The page lies on the inset ground of the score viewer's panes
     (ScorePreview.svelte), which shows where the view reaches past it. */
  .facsbox {
    flex: 1;
    min-height: 0;
    display: flex;
    border-radius: 10px;
    background: var(--bg-inset);
    box-shadow: var(--shadow-inset);
    overflow: hidden;
  }
</style>
