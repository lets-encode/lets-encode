<!--
  The measure correction's desk, the only scrolling region: the pages in
  rows of one or two, each with its heading over its sheet, or in the
  instruments step the name fields beside the staves. A pinch or a
  Ctrl/Cmd+scroll zooms the pages.
-->
<script lang="ts">
  import Notice from "$lib/components/Notice.svelte";
  import InstrumentNaming from "$lib/components/InstrumentNaming.svelte";
  import { zoomGestures } from "$lib/zoom-gestures.ts";
  import type { Layer } from "$lib/zones/edit-pages.ts";
  import type { ZoneEditor, ZonePages } from "$lib/zones/zone-pages.svelte.ts";
  import {
    ZOOM_MAX,
    ZOOM_MIN,
    type PageView,
  } from "$lib/zones/page-view.svelte.ts";
  import type { BoxSelection } from "$lib/zones/box-selection.svelte.ts";
  import type { InstrumentStep } from "$lib/zones/instrument-step.svelte.ts";
  import ZonePageCanvas from "./ZonePageCanvas.svelte";

  let {
    editor: ed,
    model,
    view,
    sel,
    instruments,
    tool,
    step4,
    canEdit,
    coarse,
  }: {
    editor: ZoneEditor;
    model: ZonePages;
    view: PageView;
    sel: BoxSelection;
    instruments: InstrumentStep;
    /** The layer the pointer edits. */
    tool: Layer;
    /** The instruments step is in view. */
    step4: boolean;
    canEdit: boolean;
    /** A touch screen. */
    coarse: boolean;
  } = $props();

  const pages = $derived(model.pages);
</script>

<div
  class="desk"
  bind:this={view.desk}
  bind:clientWidth={view.deskW}
  bind:clientHeight={view.deskH}
  onscroll={view.deskScrollEvent}
  {@attach zoomGestures({
    get: () => view.zoom,
    set: (z) => {
      view.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
      view.fit = null;
    },
    onpinchstart: () => ed.hold(),
  })}
>
  {#if step4}
    <InstrumentNaming
      whole={view.step4Pages}
      pages={instruments.namingModels}
      urls={pages.map((pg) => (pg.failed ? "" : pg.url))}
      named={instruments.shownNamed}
      {canEdit}
      ondefine={instruments.naming4.define}
      onassign={instruments.naming4.assign}
      onabbr={instruments.naming4.abbr}
      ongroups={instruments.naming4.groups}
      onfix={instruments.naming4.fix}
      onmerge={instruments.naming4.merge}
      fixBlock={instruments.firstBlock}
    />
  {/if}
  <div
    class="pages"
    style:display={step4 ? "none" : undefined}
    class:double={view.shownView === "double"}
    style={`--zoom:${view.zoom}; --stroke-scale:${view.damp}`}
  >
    {#each view.spreads as sp, r (r)}
      <div class="row" bind:this={view.rowEls[r]}>
        {#if sp.lonelySide === "right"}<div class="page-spacer"></div>{/if}
        {#each sp.pages as p (p)}
          {@const pg = pages[p]}
          <div class="page">
            <p class="page-label pagehead">Page {p + 1} · Facsimile</p>
            {#if pg.failed}
              <Notice
                tone="err"
                title={`The facsimile of page ${p + 1} could not be loaded`}
                detail="The zones are shown without their reference image."
              />
            {/if}
            <ZonePageCanvas
              {p}
              {pg}
              editor={ed}
              {model}
              {view}
              {sel}
              {tool}
              {canEdit}
              {coarse}
            />
          </div>
        {/each}
        {#if sp.lonelySide === "left"}<div class="page-spacer"></div>{/if}
      </div>
    {/each}
  </div>
</div>

<style>
  /* The scroll position is kept by page (see `anchor`), not by the browser. */
  .desk {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overflow-anchor: none;
    /* A pinch zooms the pages (zoomGestures), not the window. */
    touch-action: pan-x pan-y;
    padding: 16px 24px;
    box-sizing: border-box;
  }
  /* A narrow tool column gives the page most of its width. */
  @container (max-width: 559px) {
    .desk {
      padding-inline: 8px;
    }
  }
  .pages {
    min-width: 0;
  }
  /* A row's width is the zoom level: above 100% every row overflows the desk
     by the same amount, so the one desk scrollbar moves all pages together.
     Centred, so zoomed out the pages stay in the middle of the desk. */
  .row {
    width: calc(100% * var(--zoom, 1));
    margin-inline: auto;
  }
  /* Two-up view: the spread's pages (and any empty-half spacer) share the
     row, a few pixels apart at the spine, so they meet in the middle. */
  .pages.double .row {
    display: flex;
    align-items: flex-start;
    gap: 4px;
  }
  .pages.double .page,
  .page-spacer {
    flex: 1 1 0;
    min-width: 0;
  }

  .page {
    margin-bottom: 1.5rem;
  }
  .pagehead {
    margin-bottom: 4px;
  }
</style>
