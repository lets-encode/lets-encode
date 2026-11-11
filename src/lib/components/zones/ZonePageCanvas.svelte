<!--
  One page of the measure correction: the facsimile as an SVG sheet with the
  active layer's boxes over it (staff, grand-staff or measure boxes with
  their marks), the endings' brackets, the overlaps, the first corner of a
  box drawn by two clicks and a Shift+drag's rectangle; over the page the
  selected box's handles. Cropped to the piece's part of the page, the frame
  shows that part of the full-size canvas, shifted by its offset; percentage
  margins are of the frame's width.
-->
<script lang="ts">
  import BoxHandles from "$lib/components/BoxHandles.svelte";
  import { drawnBox } from "$lib/box-geometry.ts";
  import type { MeasureBox } from "$lib/mei-facsimile.ts";
  import {
    itemName,
    overlaps,
    staffRoom,
    type EditPage,
    type EditStaff,
    type EditZone,
    type Layer,
  } from "$lib/zones/edit-pages.ts";
  import {
    endingRuns,
    markNames,
    sbActive,
    startsMovement,
    zoneTitle,
  } from "$lib/zones/measures.ts";
  import type { ZoneEditor, ZonePages } from "$lib/zones/zone-pages.svelte.ts";
  import type { PageView } from "$lib/zones/page-view.svelte.ts";
  import type { BoxSelection } from "$lib/zones/box-selection.svelte.ts";
  import MeasureMarks from "./MeasureMarks.svelte";

  let {
    p,
    pg,
    editor: ed,
    model,
    view,
    sel,
    tool,
    canEdit,
    coarse,
  }: {
    /** The page's index. */
    p: number;
    pg: EditPage;
    editor: ZoneEditor;
    model: ZonePages;
    view: PageView;
    sel: BoxSelection;
    /** The layer the pointer edits. */
    tool: Layer;
    canEdit: boolean;
    /** A touch screen. */
    coarse: boolean;
  } = $props();

  const pages = $derived(model.pages);
  const selected = $derived(sel.selected);
  const v = $derived(view.shownArea(pg));
  const vw = $derived(v.lrx - v.ulx);

  // On-screen height (px) for the number label at 100%.
  const LABEL_PX = 11;
  const labelFont = (p: number, pageW: number) => {
    const target = LABEL_PX * view.damp;
    return view.canvasW[p] ? (target * pageW) / view.canvasW[p] : target;
  };
  // A measure's label is smaller in a narrow or low box: with its inset it
  // takes at most LABEL_FIT_W of the box's width and LABEL_FIT_H of its
  // height, and no less than LABEL_MIN_PX on screen, or the full size where
  // that is smaller. The factors are the label's inset, background and
  // double-bar proportions in the markup.
  const LABEL_FIT_W = 0.75;
  const LABEL_FIT_H = 0.35;
  const LABEL_MIN_PX = 10;
  const zoneLabelFont = (
    p: number,
    pageW: number,
    box: MeasureBox,
    chars: number,
    bar: boolean,
  ) => {
    const full = labelFont(p, pageW);
    const byW =
      ((box.lrx - box.ulx) * LABEL_FIT_W) /
      (0.6 + chars * 0.62 + 0.9 + (bar ? 0.7 : 0));
    const byH = ((box.lry - box.uly) * LABEL_FIT_H) / (0.6 + 1.55);
    const least = full * Math.min(1, LABEL_MIN_PX / (LABEL_PX * view.damp));
    return Math.max(least, Math.min(full, byW, byH));
  };

  // Paint order for a page's zones: the selected zone is moved to the end so it
  // renders on top. SVG has no z-index, so an earlier zone would otherwise sit
  // under a later overlapping one and steal its pointer events.
  function paintOrder(
    pg: EditPage,
    p: number,
  ): { zone: EditZone; z: number }[] {
    const entries = pg.zones.map((zone, z) => ({ zone, z }));
    if (tool === "measures" && selected?.p === p) {
      const i = entries.findIndex((e) => e.z === selected!.z);
      if (i >= 0) entries.push(entries.splice(i, 1)[0]);
    }
    return entries;
  }

  // Same for the staff and grand-staff layers: the selected box paints last.
  function staffPaintOrder(
    pg: EditPage,
    p: number,
  ): { staff: EditStaff; s: number }[] {
    const entries = (tool === "grandstaves" ? pg.grandstaves : pg.staves).map(
      (staff, s) => ({ staff, s }),
    );
    if (tool !== "measures" && selected?.p === p) {
      const i = entries.findIndex((e) => e.s === selected!.z);
      if (i >= 0) entries.push(entries.splice(i, 1)[0]);
    }
    return entries;
  }
</script>

<div
  class="frame"
  class:cropped={!view.isWhole(v, pg)}
  style:aspect-ratio={view.isWhole(v, pg)
    ? undefined
    : `${vw} / ${v.lry - v.uly}`}
>
  <div
    class="canvas"
    bind:clientWidth={view.canvasW[p]}
    onpointerdowncapture={(e) => ed.placeArmed(e, p)}
    style:width={view.isWhole(v, pg) ? undefined : `${(pg.width / vw) * 100}%`}
    style:margin-left={view.isWhole(v, pg)
      ? undefined
      : `${(-v.ulx / vw) * 100}%`}
    style:margin-top={view.isWhole(v, pg)
      ? undefined
      : `${(-v.uly / vw) * 100}%`}
  >
    <svg
      bind:this={view.svgEls[p]}
      viewBox={`0 0 ${pg.width} ${pg.height}`}
      class:staves={tool === "staves"}
      class:grandstaves={tool === "grandstaves"}
      class:pan={coarse && (!ed.drawMode || !view.showBoxes)}
      role="application"
      aria-label={`Page ${p + 1}, ${tool === "staves" ? "staff boxes" : tool === "grandstaves" ? "grand staves" : "measures"}`}
      onpointerdown={(e) => ed.pageDown(e, p)}
    >
      <!-- Pages far from the view keep their size but draw nothing. -->
      {#if view.nearPages.includes(p)}
        {#if pg.url}
          <image
            href={pg.url}
            width={pg.width}
            height={pg.height}
            onerror={() => (model.pages[p].failed = true)}
          />
        {/if}
        {#each view.showBoxes && tool !== "measures" ? staffPaintOrder(pg, p) : [] as { staff, s } (`${tool}-${s}`)}
          <rect
            class="staff"
            class:grand={tool === "grandstaves"}
            class:selected={sel.inSelection(p, s)}
            vector-effect="non-scaling-stroke"
            role="button"
            tabindex={sel.tabStop(p, s)}
            data-box={s}
            aria-current={selected?.p === p && selected?.z === s
              ? "true"
              : undefined}
            aria-label={`${tool === "grandstaves" ? "Grand staff" : "Staff"} ${s + 1}, page ${p + 1}${canEdit ? ": select, drag or resize" : ""}`}
            x={staff.box.ulx}
            y={staff.box.uly}
            width={staff.box.lrx - staff.box.ulx}
            height={staff.box.lry - staff.box.uly}
            onpointerdown={(e) => ed.boxDown(e, p, staff)}
            onkeydown={(e) => sel.zoneKeydown(e, p, s)}
          />
        {/each}
        {#each view.showBoxes && tool === "measures" ? paintOrder(pg, p) : [] as { zone, z } (z)}
          <rect
            class="zone"
            class:selected={sel.inSelection(p, z)}
            class:mdivstart={startsMovement(pages, p, z)}
            vector-effect="non-scaling-stroke"
            role="button"
            tabindex={sel.tabStop(p, z)}
            data-box={z}
            aria-current={selected?.p === p && selected?.z === z
              ? "true"
              : undefined}
            aria-label={`Measure ${zone.override ?? zone.label}, page ${p + 1}${sbActive(pages, p, z) ? ", starts a system" : ""}${startsMovement(pages, p, z) ? ", starts a section" : ""}${zone.pickup ? ", pickup" : ""}${markNames(
              pages[p].zones[z],
            )
              .map((m) => `, ${m.toLowerCase()}`)
              .join(
                "",
              )}${canEdit ? ": select, drag, or edit its number, breaks and repeats" : ""}`}
            x={zone.box.ulx}
            y={zone.box.uly}
            width={zone.box.lrx - zone.box.ulx}
            height={zone.box.lry - zone.box.uly}
            onpointerdown={(e) => ed.boxDown(e, p, zone)}
            onkeydown={(e) => sel.zoneKeydown(e, p, z)}
          >
            {#if zoneTitle(pages, p, z)}
              <title>{zoneTitle(pages, p, z)}</title>
            {/if}
          </rect>
          <MeasureMarks
            {zone}
            fs={zoneLabelFont(
              p,
              pg.width,
              zone.box,
              zone.label.length,
              startsMovement(pages, p, z),
            )}
            system={sbActive(pages, p, z)}
            section={startsMovement(pages, p, z)}
            on={sel.inSelection(p, z)}
          />
        {/each}
        <!-- Endings: a bracket over each run of measures of
             one ending in a system, with its number; closed
             at the end unless it is the run's last ending. -->
        {#if view.showBoxes && tool === "measures"}
          {#each endingRuns(pages, p) as run, i (i)}
            {@const fs = labelFont(p, pg.width)}
            {@const y = run.uly - fs * 0.6}
            <g aria-hidden="true" class="volta">
              <path
                vector-effect="non-scaling-stroke"
                d={`M${run.ulx + fs * 0.2} ${run.uly}V${y}H${run.lrx - fs * 0.2}${run.closed ? `V${run.uly}` : ""}`}
              />
              <rect
                x={run.ulx + fs * 0.45}
                y={y - fs * 0.75}
                width={fs * (run.n.length * 0.62 + 1.3)}
                height={fs * 1.5}
                rx={fs * 0.28}
              />
              <text x={run.ulx + fs * 0.75} y={y + fs * 0.4} font-size={fs}
                >{run.n}.</text
              >
            </g>
          {/each}
        {/if}
        {#each view.showBoxes && view.showOverlaps ? overlaps(pg, tool) : [] as o, i (i)}
          <rect
            class="overlap"
            x={o.ulx}
            y={o.uly}
            width={o.lrx - o.ulx}
            height={o.lry - o.uly}
          />
        {/each}
        {#if ed.corner?.p === p && ed.corner.scope === tool}
          {@const corner = ed.corner}
          {@const r = labelFont(p, pg.width) * 0.9}
          <path
            class="corner"
            vector-effect="non-scaling-stroke"
            d={`M${corner.x - r} ${corner.y}H${corner.x + r}M${corner.x} ${corner.y - r}V${corner.y + r}`}
          />
        {/if}
        {#if ed.marquee?.p === p && ed.marquee.moved}
          {@const marquee = ed.marquee}
          {@const m = drawnBox(marquee.sx, marquee.sy, marquee.x, marquee.y, 0)}
          <rect
            class="marquee"
            vector-effect="non-scaling-stroke"
            x={m.ulx}
            y={m.uly}
            width={m.lrx - m.ulx}
            height={m.lry - m.uly}
          />
        {/if}
      {/if}
    </svg>

    {#if canEdit && view.showBoxes && sel.selectedItem?.p === p && !sel.groupZs.length}
      {@render handles(p, sel.selectedItem.z)}
    {/if}
  </div>
</div>

<!-- The selected box's body and its resize handles, over the page in
     screen pixels: a body that drags the box, round corner dots, and
     edge handles without a mark of their own, at touch size on a touch
     screen. Their percentages place them on the box at any zoom; --w
     and --h, the box's size on screen, keep the handles' reach into the
     box to a quarter of it. -->
{#snippet handles(p: number, z: number)}
  <BoxHandles
    editor={ed}
    {p}
    item={model.items(p, tool)[z]}
    box={model.items(p, tool)[z].box}
    page={pages[p]}
    scale={(view.canvasW[p] || pages[p].width) / pages[p].width}
    name={itemName(pages, tool, p, z)}
    color={tool === "staves"
      ? "rgb(var(--layer-staff))"
      : tool === "grandstaves"
        ? "rgb(var(--layer-grand))"
        : "rgb(var(--layer-measure))"}
    touch={coarse}
    room={tool === "measures" ? undefined : staffRoom(model.items(p, tool), z)}
  />
{/snippet}

<style>
  /* Positioning context for the per-zone controls overlay: its width is the
     svg's, so percentage-placed controls line up with the boxes. */
  .canvas {
    position: relative;
  }
  /* A page cropped to the piece's part: the frame clips the canvas and
     carries the sheet's outline and shadow. */
  .frame.cropped {
    overflow: hidden;
    background: var(--facsimile-paper);
    box-shadow:
      0 0 0 1px var(--line-input),
      var(--shadow-paper);
  }
  .frame.cropped svg {
    border: 0;
    box-shadow: none;
  }
  /* Each page renders as a sheet floating on the desk. */
  svg {
    display: block;
    /* border-box so the 1px border stays within 100% and the page doesn't
       overflow its container by a couple of pixels at 100% zoom. */
    box-sizing: border-box;
    width: 100%;
    max-width: none;
    height: auto;
    background: var(--facsimile-paper);
    border: 1px solid var(--line-input);
    box-shadow: var(--shadow-paper);
    touch-action: none;
    user-select: none;
  }
  /* Teal for measures, purple for movement starts: both hues sit outside the
     piece-region palette (--zone-1…8), so a colour never carries two meanings. */
  /* Strokes are screen pixels — the markup sets
     vector-effect="non-scaling-stroke" — scaled by the damped zoom factor
     --stroke-scale. */
  .zone {
    fill: rgba(var(--layer-measure), 0.2);
    stroke: rgba(var(--layer-measure), 0.85);
    stroke-width: calc(2px * var(--stroke-scale, 1));
    cursor: pointer;
  }
  /* A selected box: a fill twice as dark and a solid outline. */
  .zone.selected {
    fill: rgba(var(--layer-measure), 0.4);
    stroke: rgb(var(--layer-measure));
    stroke-width: calc(3px * var(--stroke-scale, 1));
  }
  .zone.mdivstart {
    stroke: rgba(var(--layer-movement), 0.9);
    fill: rgba(var(--layer-movement), 0.22);
    stroke-width: calc(4px * var(--stroke-scale, 1));
  }
  .zone.mdivstart.selected {
    fill: rgba(var(--layer-movement), 0.42);
    stroke: rgb(var(--layer-movement));
  }
  /* An ending's bracket over its measures, its number on paper. */
  .volta {
    pointer-events: none;
  }
  .volta path {
    fill: none;
    stroke: rgb(var(--layer-measure));
    stroke-width: calc(2.5px * var(--stroke-scale, 1));
  }
  .volta rect {
    fill: rgba(255, 255, 255, 0.92);
  }
  .volta text {
    font-family: var(--font);
    font-weight: 600;
    fill: #1a1a1a;
  }
  /* Wine red for staff boxes, dark green for grand staves, teal for measures:
     hues outside the region palette, darker than the red and green that mean
     fail and done. Only one layer is shown at a time. */
  .staff {
    fill: rgba(var(--layer-staff), 0.16);
    stroke: rgba(var(--layer-staff), 0.9);
    stroke-width: calc(2px * var(--stroke-scale, 1));
    cursor: pointer;
  }
  .staff.selected {
    fill: rgba(var(--layer-staff), 0.4);
    stroke: rgb(var(--layer-staff));
    stroke-width: calc(3px * var(--stroke-scale, 1));
  }
  /* A box focused by a tap or click shows no browser outline; keyboard
     focus keeps it. */
  .zone:focus:not(:focus-visible),
  .staff:focus:not(:focus-visible) {
    outline: none;
  }
  /* Keyboard focus: a dashed accent border, drawn as the box's stroke so it
     shows wherever SVG outlines do not. */
  .zone:focus-visible,
  .staff:focus-visible {
    outline: none;
    stroke: var(--accent);
    stroke-width: calc(3px * var(--stroke-scale, 1));
    stroke-dasharray: 6 3;
  }
  /* The first corner of a box drawn by two clicks, in its layer's colour. */
  .corner {
    stroke: rgba(var(--layer-measure), 0.95);
    stroke-width: calc(2px * var(--stroke-scale, 1));
    pointer-events: none;
  }
  /* A Shift+drag's selection rectangle. */
  .marquee {
    fill: rgba(var(--layer-measure), 0.08);
    stroke: rgba(var(--layer-measure), 0.95);
    stroke-width: 1.5px;
    stroke-dasharray: 5 4;
    pointer-events: none;
  }
  .staves .marquee {
    fill: rgba(var(--layer-staff), 0.08);
    stroke: rgba(var(--layer-staff), 0.95);
  }
  .grandstaves .marquee {
    fill: rgba(var(--layer-grand), 0.08);
    stroke: rgba(var(--layer-grand), 0.95);
  }
  .staves .corner {
    stroke: rgba(var(--layer-staff), 0.95);
  }
  .grandstaves .corner {
    stroke: rgba(var(--layer-grand), 0.95);
  }
  /* The intersection of two boxes takes the inverse of the box colour. */
  .overlap {
    fill: rgba(255, 100, 70, 0.6);
    pointer-events: none;
  }
  .staves .overlap,
  .grandstaves .overlap {
    fill: rgba(240, 180, 40, 0.6);
  }
  .staff.grand {
    fill: rgba(var(--layer-grand), 0.16);
    stroke: rgba(var(--layer-grand), 0.9);
  }
  .staff.grand.selected {
    fill: rgba(var(--layer-grand), 0.4);
    stroke: rgb(var(--layer-grand));
  }
  /* On a touch screen outside draw mode a finger drag scrolls the page. */
  svg.pan {
    touch-action: pan-x pan-y;
  }
</style>
