<!--
  While a finger (or any pointer on a touch screen) holds a resize handle or
  draws a box, a magnifier above it (BoxEditor's loupe) shows the edge or
  corner under the finger, with the active layer's boxes inside the
  magnified square.
-->
<script lang="ts">
  import type { Layer } from "$lib/zones/edit-pages.ts";
  import type { ZoneEditor, ZonePages } from "$lib/zones/zone-pages.svelte.ts";

  let {
    editor: ed,
    model,
    canvasW,
    tool,
  }: {
    editor: ZoneEditor;
    model: ZonePages;
    /** Each page's rendered canvas width in screen pixels. */
    canvasW: number[];
    /** The layer the pointer edits. */
    tool: Layer;
  } = $props();

  const LOUPE_PX = 120;
  const LOUPE_ZOOM = 2;
</script>

{#if ed.loupe && model.pages[ed.loupe.p]}
  {@const loupe = ed.loupe}
  {@const pg = model.pages[loupe.p]}
  {@const scale = canvasW[loupe.p] ? canvasW[loupe.p] / pg.width : 1}
  {@const span = LOUPE_PX / (LOUPE_ZOOM * scale)}
  {@const lx =
    loupe.cx - LOUPE_PX - 24 < 8 ? loupe.cx + 24 : loupe.cx - LOUPE_PX - 24}
  {@const ly = Math.max(8, loupe.cy - LOUPE_PX - 48)}
  <div
    class="loupe"
    aria-hidden="true"
    style:left={`${lx}px`}
    style:top={`${ly}px`}
    style:width={`${LOUPE_PX}px`}
    style:height={`${LOUPE_PX}px`}
  >
    <svg
      viewBox={`${loupe.x - span / 2} ${loupe.y - span / 2} ${span} ${span}`}
      class:staves={tool === "staves"}
      class:grandstaves={tool === "grandstaves"}
    >
      {#if pg.url}
        <image href={pg.url} width={pg.width} height={pg.height} />
      {/if}
      <!-- Only the boxes inside the magnified square. -->
      {#each model
        .items(loupe.p, tool)
        .filter((it) => it.box.lrx > loupe!.x - span / 2 && it.box.ulx < loupe!.x + span / 2 && it.box.lry > loupe!.y - span / 2 && it.box.uly < loupe!.y + span / 2) as it, i (i)}
        <rect
          class={tool === "measures" ? "zone" : "staff"}
          class:grand={tool === "grandstaves"}
          vector-effect="non-scaling-stroke"
          x={it.box.ulx}
          y={it.box.uly}
          width={it.box.lrx - it.box.ulx}
          height={it.box.lry - it.box.uly}
        />
      {/each}
      <path
        class="cross"
        vector-effect="non-scaling-stroke"
        d={`M${loupe.x - span / 6} ${loupe.y}H${loupe.x + span / 6}M${loupe.x} ${loupe.y - span / 6}V${loupe.y + span / 6}`}
      />
    </svg>
  </div>
{/if}

<style>
  /* The magnifier's sheet: the page's paper without the page sheet's
     border and shadow. */
  svg {
    display: block;
    box-sizing: border-box;
    max-width: none;
    background: var(--facsimile-paper);
    touch-action: none;
    user-select: none;
  }
  /* The boxes in the colours of the page's boxes (ZonePageCanvas). */
  .zone {
    fill: rgba(var(--layer-measure), 0.2);
    stroke: rgba(var(--layer-measure), 0.85);
    stroke-width: calc(2px * var(--stroke-scale, 1));
    cursor: pointer;
  }
  .staff {
    fill: rgba(var(--layer-staff), 0.16);
    stroke: rgba(var(--layer-staff), 0.9);
    stroke-width: calc(2px * var(--stroke-scale, 1));
    cursor: pointer;
  }
  .staff.grand {
    fill: rgba(var(--layer-grand), 0.16);
    stroke: rgba(var(--layer-grand), 0.9);
  }
  /* The magnifier above a finger resizing or drawing a box. */
  .loupe {
    position: fixed;
    z-index: 60;
    border-radius: 50%;
    overflow: hidden;
    pointer-events: none;
    background: var(--facsimile-paper);
    border: 3px solid var(--card);
    box-shadow:
      0 0 0 1px var(--line-strong),
      0 6px 18px rgba(31, 36, 51, 0.3);
  }
  .loupe svg {
    width: 100%;
    height: 100%;
    border: 0;
    box-shadow: none;
  }
  .loupe .cross {
    stroke: var(--accent);
    stroke-width: 2px;
    fill: none;
  }
</style>
