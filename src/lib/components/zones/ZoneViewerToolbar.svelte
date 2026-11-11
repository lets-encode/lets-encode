<!--
  The measure correction's page toolbar: above or below the pages, or at
  the top of the side panel docked as a sheet on a phone. One order at
  every width: undo and redo, the view options, the zoom; at the right end
  the paging, the help and the ⋯ menu. Where the toolbar narrows, groups
  move into the ⋯ menu; none changes place. How many pages a row shows is
  in the toolbar, or in the ⋯ menu below MEDIUM_TOOL. In draw mode the
  toolbar takes the class "drawing".
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import { HANDLES } from "$lib/components/BoxHandles.svelte";
  import BoxModeToggles from "$lib/components/BoxModeToggles.svelte";
  import PageNav from "$lib/components/PageNav.svelte";
  import PageSpreadControls from "$lib/components/PageSpreadControls.svelte";
  import ViewerToolbar from "$lib/components/ViewerToolbar.svelte";
  import ZoomLevel from "$lib/components/ZoomLevel.svelte";
  import type { ZoneEditor } from "$lib/zones/zone-pages.svelte.ts";
  import type { PageView } from "$lib/zones/page-view.svelte.ts";

  let {
    narrow,
    editor: ed,
    view,
    total,
    canEdit,
    coarse,
    boxName,
    step4,
    helpOpen = $bindable(),
    viewOpen = $bindable(),
  }: {
    /** The toolbar is one row at touch size (ViewerToolbar). */
    narrow: boolean;
    editor: ZoneEditor;
    view: PageView;
    /** How many pages the task has. */
    total: number;
    canEdit: boolean;
    /** A touch screen. */
    coarse: boolean;
    /** What one box of the active layer is called. */
    boxName: string;
    /** The instruments step is in view. */
    step4: boolean;
    helpOpen: boolean;
    viewOpen: boolean;
  } = $props();

  // Draw mode on a touch screen, which the toolbar shows.
  const drawing = $derived(canEdit && coarse && ed.drawMode);
</script>

<ViewerToolbar
  class={drawing ? "drawing" : ""}
  {narrow}
  children={toolbarItems}
  end={toolbarEnd}
/>

{#snippet toolbarItems()}
  {#if canEdit}
    <button
      type="button"
      class="tbtn tbtn-icon"
      onclick={() => ed.undo()}
      disabled={!ed.canUndo}
      aria-label="Undo"
      title="Undo the last change (Ctrl/Cmd+Z)"><Icon name="undo" /></button
    >
    <button
      type="button"
      class="tbtn tbtn-icon"
      onclick={() => ed.redo()}
      disabled={!ed.canRedo}
      aria-label="Redo"
      title="Redo (Ctrl/Cmd+Shift+Z)"><Icon name="redo" /></button
    >
  {/if}
  {#if canEdit && coarse}<BoxModeToggles editor={ed} noun={boxName} />{/if}
  {#if canEdit}<span class="vline"></span>{/if}
  {#if step4}
    <button
      type="button"
      class="tbtn tbtn-icon"
      class:on={view.step4Pages}
      aria-pressed={view.step4Pages}
      aria-label="Show the whole pages"
      title={view.step4Pages
        ? "Show only the beginning of each system"
        : "Show the whole pages beside the names"}
      onclick={() => view.showStep4Pages(!view.step4Pages)}
      ><Icon name="page-whole" size={16} /></button
    >
    <span class="vline"></span>
  {/if}
  {#if !view.medium && !step4}<PageSpreadControls
      view={view.view}
      firstOnRight={view.firstOnRight}
      onview={(v) => (view.view = v)}
      onfirstonright={(on) => (view.firstOnRight = on)}
    />{/if}
  {#if !view.viewCompact && !step4}{@render boxesButton()}{@render overlapButton()}{@render wholePageButton()}<span
      class="vline viewline"
    ></span>{/if}
  {#if !step4}<ZoomLevel
      bind:value={
        () => Math.round(view.zoom * 100), (v) => (view.zoom = v / 100)
      }
      bind:fit={view.fit}
      fitPage={view.narrow ? undefined : view.fitZoom() * 100}
      layout={view.narrow && coarse
        ? "pinch"
        : view.medium
          ? "steps"
          : "slider"}
      onfitpage={view.fitWholePage}
    />{/if}
  <span class="vh" role="status"
    >{ed.armed
      ? `The ${HANDLES.find((h) => h.edges === ed.armed?.edges)?.side} is picked up. ${coarse ? "Tap" : "Click"} where it should go.`
      : ed.corner
        ? `First corner set on page ${ed.corner.p + 1}. Click the opposite corner to draw the ${boxName}.`
        : ed.drawHint
          ? `Turn on Draw, or tap the ${boxName} twice, to select it.`
          : ""}</span
  >
{/snippet}

<!-- Last in the toolbar, next to the side panel on the right. -->
{#snippet toolbarEnd()}
  {#if !step4}<!-- A phone or tablet row has room for the numbers only ("1–2 of 4"). --><PageNav
      label={view.spreadLabel}
      {total}
      compact={view.medium}
      atStart={view.atTop}
      atEnd={view.atEnd}
      ongo={view.go}
    />
    <span class="vline helpline" class:hidden={view.inSheet && !view.viewMenu}
    ></span>{/if}
  <button
    type="button"
    class="tbtn tbtn-icon helpbtn"
    class:hidden={view.inSheet}
    class:on={helpOpen}
    aria-label="Editor help"
    aria-expanded={helpOpen}
    aria-controls="zone-help"
    onclick={() => {
      helpOpen = !helpOpen;
      viewOpen = false;
    }}><Icon name="help" size={18} /></button
  >
  {#if view.viewMenu && (view.inSheet || !step4)}
    <button
      type="button"
      class="tbtn tbtn-icon viewbtn"
      class:on={viewOpen}
      aria-label={view.inSheet ? "View options and help" : "View options"}
      aria-expanded={viewOpen}
      aria-controls="zone-view"
      onclick={() => {
        viewOpen = !viewOpen;
        helpOpen = false;
      }}><Icon name="more" size={18} /></button
    >
  {/if}
{/snippet}

<!-- Draw mode, on a touch screen: on, a finger drag draws and a tap
     selects; off, a drag scrolls the pages and a tap deselects. -->
{#snippet boxesButton()}
  <button
    type="button"
    class="tbtn tbtn-icon"
    class:on={view.showBoxes}
    aria-pressed={view.showBoxes}
    aria-label="Show the boxes"
    title="Show or hide the boxes on the page"
    onclick={view.toggleBoxes}><Icon name="eye" size={16} /></button
  >
{/snippet}

<!-- Shown where the piece covers only part of a page. -->
{#snippet wholePageButton()}
  {#if view.hasPartPages}
    <button
      type="button"
      class="tbtn tbtn-icon"
      class:on={view.wholePage}
      aria-pressed={view.wholePage}
      aria-label="Show the whole page"
      title="Show the whole page, not only the part this piece covers"
      onclick={() => (view.wholePage = !view.wholePage)}
      ><Icon name="page-whole" size={16} /></button
    >
  {/if}
{/snippet}

{#snippet overlapButton()}
  <button
    type="button"
    class="tbtn tbtn-icon"
    class:on={view.showOverlaps}
    aria-pressed={view.showOverlaps}
    disabled={!view.showBoxes}
    aria-label="Show overlaps"
    title="Show or hide the colour on areas where two boxes overlap"
    onclick={() => (view.showOverlaps = !view.showOverlaps)}
    ><Icon name="overlap" size={16} /></button
  >
{/snippet}

<style>
  .helpbtn.hidden,
  .helpline.hidden {
    display: none;
  }
</style>
