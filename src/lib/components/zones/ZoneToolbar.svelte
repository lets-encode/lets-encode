<!--
  The measure correction's toolbar row above the pages (below them on a
  narrow touch screen), with the editor help and the View options behind
  the ⋯ button opening over the pages. At the top of the phone sheet the
  toolbar itself moves into the side panel and this row keeps only what
  opens from it.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "$lib/components/Icon.svelte";
  import PageSpreadControls from "$lib/components/PageSpreadControls.svelte";
  import { helpLines } from "$lib/zones/editor-help.ts";
  import type { PageView } from "$lib/zones/page-view.svelte.ts";

  let {
    view,
    bar,
    step4,
    canEdit,
    coarse,
    boxName,
    omr,
    helpOpen = $bindable(),
    viewOpen = $bindable(),
  }: {
    view: PageView;
    /** The toolbar, given whether it is one row at touch size. */
    bar: Snippet<[boolean]>;
    /** The instruments step is in view. */
    step4: boolean;
    canEdit: boolean;
    /** A touch screen. */
    coarse: boolean;
    /** What one box of the active layer is called. */
    boxName: string;
    /** The task corrects an OMR layout. */
    omr: boolean;
    helpOpen: boolean;
    viewOpen: boolean;
  } = $props();

  // The editing hints and outline legend, shown by the toolbar's help icon.
  const lines = $derived(
    helpLines({
      get step4() {
        return step4;
      },
      get canEdit() {
        return canEdit;
      },
      get coarse() {
        return coarse;
      },
      get boxName() {
        return boxName;
      },
      get omr() {
        return omr;
      },
    }),
  );
</script>

<div
  class="tbar"
  class:bare={view.inSheet}
  bind:clientWidth={view.toolW}
  style={`--desk-h:${view.deskH}px`}
>
  {#if !view.inSheet}
    {@render bar(view.narrow)}
  {/if}
  {#if helpOpen}
    <div
      id="zone-help"
      class="helppanel"
      role="region"
      aria-label="Editor help"
    >
      <ul>
        {#each lines as line, i (i)}
          <li>
            {#each line as part, j (j)}{#if typeof part === "string"}{part}{:else}<b
                  class="tone-{part.tone}">{part.text}</b
                >{/if}{/each}
          </li>
        {/each}
      </ul>
      <button
        type="button"
        class="btn btn-icon"
        aria-label="Close the editor help"
        onclick={() => (helpOpen = false)}><Icon name="close" /></button
      >
    </div>
  {/if}
  {#if viewOpen && view.viewMenu}
    <div
      id="zone-view"
      class="viewmenu"
      role="group"
      aria-label={view.inSheet ? "View options and help" : "View options"}
    >
      {#if !view.narrow && !step4}<PageSpreadControls
          view={view.view}
          firstOnRight={view.firstOnRight}
          onview={(v) => (view.view = v)}
          onfirstonright={(on) => (view.firstOnRight = on)}
        />{/if}
      {#if view.viewCompact && !step4}
        <button
          type="button"
          class="tbtn"
          class:on={view.showBoxes}
          aria-pressed={view.showBoxes}
          title="Show or hide the boxes on the page"
          onclick={view.toggleBoxes}>Show the boxes</button
        >
        <button
          type="button"
          class="tbtn"
          class:on={view.showOverlaps}
          aria-pressed={view.showOverlaps}
          disabled={!view.showBoxes}
          title="Show or hide the colour on areas where two boxes overlap"
          onclick={() => (view.showOverlaps = !view.showOverlaps)}
          >Show overlaps</button
        >
        {#if view.hasPartPages}
          <button
            type="button"
            class="tbtn"
            class:on={view.wholePage}
            aria-pressed={view.wholePage}
            title="Show the whole page, not only the part this piece covers"
            onclick={() => (view.wholePage = !view.wholePage)}
            >Show the whole page</button
          >
        {/if}
      {/if}
      {#if view.inSheet}
        <button
          type="button"
          class="btn"
          aria-controls="zone-help"
          onclick={() => {
            helpOpen = true;
            viewOpen = false;
          }}><Icon name="help" size={16} /> Help</button
        >
      {/if}
    </div>
  {/if}
</div>

<style>
  /* The toolbar and the editor help below it. */
  .tbar {
    flex: none;
    position: relative;
  }
  /* The editor help, opened from the toolbar, over the top of the pages, so
     the desk keeps its size and its fit. */
  .helppanel {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 5;
    max-height: calc(var(--desk-h) - 16px);
    box-sizing: border-box;
    overflow: auto;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-top: 8px;
    padding: 10px 14px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-soft);
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow-md);
  }
  .helppanel ul {
    flex: 1;
    margin: 0;
    padding-left: 18px;
  }
  /* Colour words in the help, in the colours they name. */
  .helppanel b {
    font-weight: 600;
  }
  .tone-staff {
    color: var(--ink-staff);
  }
  .tone-grand {
    color: var(--ink-grand);
  }
  .tone-measure {
    color: var(--ink-measure);
  }
  .tone-movement {
    color: var(--ink-movement);
  }
  .tone-system {
    color: var(--ink-system);
  }
  /* Each step carries the colour its boxes are drawn in. */
  .swatch {
    display: inline-block;
    width: 10px;
    height: 10px;
    margin-right: 5px;
    border-radius: 2px;
    vertical-align: -1px;
    border: 2px solid;
    box-sizing: border-box;
  }
  .swatch.staff {
    border-color: var(--ink-staff);
    background: rgba(var(--layer-staff), 0.2);
  }
  .swatch.grand {
    border-color: var(--ink-grand);
    background: rgba(var(--layer-grand), 0.2);
  }
  .swatch.measure {
    border-color: var(--ink-measure);
    background: rgba(var(--layer-measure), 0.2);
  }
  /* On a narrow touch screen the toolbar moves below the pages, within
     thumb reach; the help and the ⋯ menu open above it, over the pages, so
     the desk keeps its height. A pinch zooms: no zoom buttons or readout. */
  @media (pointer: coarse) {
    @container (max-width: 559px) {
      .tbar {
        order: 2;
        padding: 6px 0 max(6px, env(safe-area-inset-bottom));
      }
      .tbar .helppanel,
      .tbar .viewmenu {
        top: auto;
        bottom: 100%;
        margin: 0 0 8px;
      }
    }
  }
  /* At the top of the phone sheet (inSheet) the toolbar is a plain row, and
     the page column keeps only the help, which opens over the pages. */
  .tbar.bare {
    padding: 0;
  }
  /* The View options open over the pages, below the ⋯ button, or above it
     where the toolbar sits under the pages (the 559px rule). */
  .viewmenu {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 5;
    margin: 8px 0 0;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow-md);
  }
  /* In draw mode the toolbar takes the stage's wash and line, so the mode
     shows over the pages. */
  .tbar :global(.vtoolbar.drawing) {
    background: var(--st-wash);
    border-color: var(--st);
  }
  /* Docked as a sheet the View options' buttons take a 44px press. */
  @media (orientation: portrait) and (max-width: 1100px) {
    .viewmenu :global(.tbtn),
    .viewmenu .btn {
      position: relative;
      min-height: 32px;
    }
    .viewmenu :global(.tbtn)::after,
    .viewmenu .btn::after {
      content: "";
      position: absolute;
      inset: -6px;
    }
  }
</style>
