<!--
  Mark which regions of the page images belong to which piece. Fills the
  material pane: a toolbar naming the piece being marked, and the pages in a
  grid under it.

  Edited with the box editor the measure zone editor uses
  (box-editor.svelte.ts: draw on the background or click two corners, drag
  to move, corner handle to resize, arrow keys to nudge), but the rectangles
  are far coarser — one per stretch of a page a piece occupies — and each is
  coloured and labelled by its piece. Regions drawn while a piece is selected
  belong to that piece, so a piece can span several pages and two pieces can
  share one, as long as their regions do not overlap.

  Coordinates are the page image's own pixels, which is what the detector
  returns boxes in, so no rescaling is needed when the boxes are partitioned.

  On touch the toolbar holds a piece picker, a Draw toggle and Select
  several. In Draw a tap selects a region, the selected region drags and
  resizes, a drag on the page draws, and two fingers pan and zoom; a second
  finger landing mid-edit undoes the edit it interrupted. Out of Draw a
  finger or a pen scrolls, and a double tap on a region turns Draw on.

  Several regions of one page can be selected together: Shift+click adds or
  removes one, Shift+drag selects every region its rectangle touches, and
  Select several turns a tap into the same toggle. A selected group moves,
  copies and is deleted as a whole. Undo and redo restore the regions.
-->
<script lang="ts">
  import { drawnBox, type Box } from "$lib/box-geometry.ts";
  import { BoxEditor } from "$lib/box-editor.svelte.ts";
  import {
    overlappingPiece,
    pieceColour,
    type Piece,
    type PieceZone,
  } from "$lib/pieces.ts";
  import PagesPerRow from "./PagesPerRow.svelte";
  import ZoomLevel, {
    fitPageZoom,
    nearFit,
    ZOOM_MAX,
    ZOOM_MIN,
  } from "./ZoomLevel.svelte";
  import Icon from "./Icon.svelte";
  import { untrack } from "svelte";
  import { zoomGestures } from "$lib/zoom-gestures.ts";
  import { wizardLayout } from "$lib/wizard-layout.svelte.ts";
  import { pieceIdLabel } from "$lib/campaign-tables.ts";

  let {
    pieces = $bindable(),
    pages,
    selectedPiece,
    onselect,
    selectBlocked,
  }: {
    pieces: Piece[];
    /** One entry per page image, with its natural pixel size. */
    pages: { url: string; width: number; height: number }[];
    /** Index into `pieces`; regions are drawn for this piece. */
    selectedPiece: number;
    /** Picks the piece to draw for, from the touch toolbar's picker. */
    onselect?: (index: number) => void;
    /** Why another piece cannot be picked right now; disables the picker. */
    selectBlocked?: string;
  } = $props();

  // Two pages per row, each shown whole, to begin with; one on a phone.
  let perRow = $state(window.innerWidth < 600 ? 1 : 2);
  let zoom = $state(100);
  let fit = $state<"width" | "page" | null>("page");
  // The body's inner size, for the page fit.
  let bodyW = $state(0);
  let bodyH = $state(0);
  const fitPage = $derived(
    fitPageZoom(
      bodyW,
      bodyH,
      perRow,
      pages.map((p) => p.height / p.width),
    ),
  );
  // One entry per page, filled by bind:this. Reactive because binding writes
  // into it after the element is created.
  let svgEls = $state<SVGSVGElement[]>([]);
  // Rendered width per page, for converting screen pixels to page units so
  // labels and corner radii keep the same on-screen size at every zoom.
  let svgWidths = $state<number[]>([]);
  let failed = $state<Record<number, boolean>>({});

  // Arrow keys move a region NUDGE page pixels, NUDGE_FAR with Shift.
  const NUDGE = 4;
  const NUDGE_FAR = 20;

  // The selection, the gestures and the undo history of the regions
  // (box-editor.svelte.ts). A page's items are its regions of every piece;
  // a snapshot holds every piece's regions by piece id.
  type Snapshot = Record<string, PieceZone[]>;
  const ed = new BoxEditor<PieceZone, Snapshot>({
    items: (surface) => zonesOn(surface).map(({ zone }) => zone),
    box: (zone) => zone,
    page: (surface) => pages[surface],
    surface: (surface) => svgEls[surface],
    screenWidth: (surface) => svgWidths[surface] || 400,
    canEdit: () => true,
    canDraw: () => pieces[selectedPiece]?.kind === "facsimile",
    shown: () => true,
    touch: () => wizardLayout.coarse,
    scope: () => selectedPiece,
    // A region is drawn for the selected piece; a copy belongs to the piece
    // of the region it copies.
    add: (surface, box, like) => {
      const zones = pieces[like ? locate(like)!.piece : selectedPiece].zones;
      zones.push({
        surface,
        ulx: box.ulx,
        uly: box.uly,
        lrx: box.lrx,
        lry: box.lry,
      });
      return zones[zones.length - 1];
    },
    remove: (_, zone) => {
      const at = locate(zone);
      if (at) pieces[at.piece].zones.splice(at.zone, 1);
    },
    minSize: (surface) => minSizeOn(surface),
    dropBelow: (surface) => minSizeOn(surface),
    nudge: { near: NUDGE, far: NUDGE_FAR },
    snap: (surface, box, own, keepSize) =>
      keepSize ? snapWhole(box, surface, own) : snapEdges(box, surface, own),
    // Regions of two pieces cannot overlap.
    accept: (surface, edited) => {
      const clash = firstClash(edited);
      notice = clash === -1 ? null : overlapNotice(clash, surface);
      return clash === -1;
    },
    changed: () => {
      notice = null;
      ed.commit();
    },
    scroller: () => body,
    snapshot: () =>
      Object.fromEntries(
        pieces.map((piece) => [piece.id, piece.zones.map((z) => ({ ...z }))]),
      ),
    restore: (snap) => {
      for (const piece of pieces) {
        const zones = snap[piece.id];
        if (zones) piece.zones = zones.map((z) => ({ ...z }));
      }
    },
  });
  $effect(() => ed.listen());
  // Adding or removing a piece starts the history again: a new piece can
  // take a removed piece's id.
  const pieceIds = $derived(pieces.map((piece) => piece.id).join("\n"));
  $effect(() => {
    void pieceIds;
    untrack(() => ed.resetHistory());
  });
  // A change of the regions made outside the editor (the pieces form) is an
  // undo step too.
  $effect(() => {
    if (ed.dragging) return;
    JSON.stringify(pieces.map((piece) => piece.zones));
    untrack(() => ed.commit());
  });

  // A region's piece and index.
  const locate = (zone: PieceZone) => {
    const piece = pieces.findIndex((pc) => pc.zones.includes(zone));
    return piece < 0
      ? null
      : { piece, zone: pieces[piece].zones.indexOf(zone) };
  };
  // The selected region by piece and index, and the group's regions with
  // theirs; empty without a group.
  const selectedZone = $derived(ed.selected ? locate(ed.selected.item) : null);
  const members = $derived(
    ed.group.flatMap((zone) => {
      const at = locate(zone);
      return at ? [{ zone, p: at.piece, z: at.zone }] : [];
    }),
  );
  const inSelection = (p: number, z: number) =>
    ed.inSelection(pieces[p].zones[z]);
  // The first piece another piece's region of `zones` overlaps; -1 for none.
  const firstClash = (zones: PieceZone[]) => {
    for (const zone of zones) {
      const clash = overlappingPiece(pieces, locate(zone)?.piece ?? -1, zone);
      if (clash !== -1) return clash;
    }
    return -1;
  };
  // What the last edit did or refused to do, shown until the next one.
  let notice = $state<string | null>(null);

  /** Regions on one page, with the piece each belongs to. */
  const zonesOn = (surface: number) =>
    pieces.flatMap((piece, p) =>
      piece.zones
        .map((zone, z) => ({ zone, p, z }))
        .filter(({ zone }) => zone.surface === surface),
    );

  // The smallest region worth keeping, and the minimum a resize may shrink to,
  // as a fraction of the page so it holds at any image size.
  const minSizeOn = (surface: number) =>
    Math.max(pages[surface]?.width ?? 0, 1) * 0.02;

  // An edge within a few screen pixels of another region's edge snaps to it,
  // so regions sit exactly side by side instead of overlapping by a stray
  // pixel, which would reject the region. `own` are the regions being edited.
  function snapEdges(box: Box, surface: number, own: PieceZone[]): Box {
    const page = pages[surface];
    if (!page) return box;
    const tolerance = 6 * (page.width / (svgWidths[surface] || 400));
    const xs: number[] = [];
    const ys: number[] = [];
    for (const { zone: o } of zonesOn(surface)) {
      if (own.includes(o)) continue;
      xs.push(o.ulx, o.lrx);
      ys.push(o.uly, o.lry);
    }
    const snap = (v: number, edges: number[]) => {
      let best = v;
      let dist = tolerance;
      for (const edge of edges) {
        const d = Math.abs(edge - v);
        if (d < dist) {
          dist = d;
          best = edge;
        }
      }
      return best;
    };
    return {
      ulx: snap(box.ulx, xs),
      uly: snap(box.uly, ys),
      lrx: snap(box.lrx, xs),
      lry: snap(box.lry, ys),
    };
  }

  // Snapping shifts a moved region or group, keeping its size: whichever
  // edge of `box` snaps decides the shift.
  function snapWhole(box: Box, surface: number, own: PieceZone[]): Box {
    const to = snapEdges(box, surface, own);
    const dx = to.ulx !== box.ulx ? to.ulx - box.ulx : to.lrx - box.lrx;
    const dy = to.uly !== box.uly ? to.uly - box.uly : to.lry - box.lry;
    return {
      ulx: box.ulx + dx,
      uly: box.uly + dy,
      lrx: box.lrx + dx,
      lry: box.lry + dy,
    };
  }

  const overlapNotice = (clash: number, surface: number) =>
    `Regions cannot overlap: ${labelFor(clash)} already covers part of that area on page ${surface + 1}.`;

  const labelFor = (p: number) =>
    pieces[p].meta.title.trim() || pieceIdLabel(pieces[p].id);

  // Where the pages share the card behind a tab, picking a piece brings its
  // first page into view, so the Pages tab opens where that piece is.
  let body = $state<HTMLDivElement>();
  $effect(() => {
    const piece = selectedPiece;
    untrack(() => {
      const zones = pieces[piece]?.zones ?? [];
      if (wizardLayout.materialMode !== "switch" || !zones.length) return;
      const svg = svgEls[Math.min(...zones.map((z) => z.surface))];
      if (!body || !svg) return;
      body.scrollTop +=
        svg.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
    });
  });
</script>

<svelte:window
  onkeydown={(e) => {
    if (ed.keydown(e) || e.key !== "Escape") return;
    if (
      !(e.target as Element).closest(
        "input, textarea, select, [contenteditable]",
      )
    )
      ed.select(0, null);
  }}
/>

<div class="material-card">
  <div class="material-toolbar" class:touch={wizardLayout.coarse}>
    <span class="undoredo">
      <button
        type="button"
        class="btn btn-icon"
        onclick={() => ed.undo()}
        disabled={!ed.canUndo}
        aria-label="Undo"
        title="Undo the last change (Ctrl/Cmd+Z)"><Icon name="undo" /></button
      >
      <button
        type="button"
        class="btn btn-icon"
        onclick={() => ed.redo()}
        disabled={!ed.canRedo}
        aria-label="Redo"
        title="Redo (Ctrl/Cmd+Shift+Z)"><Icon name="redo" /></button
      >
    </span>
    {#if wizardLayout.coarse}
      <label
        class="pchip"
        style="--piece: {pieceColour(selectedPiece)}"
        title={selectBlocked}
      >
        <span class="swatch"></span>
        <span class="pchip-name">{labelFor(selectedPiece)}</span>
        <Icon name="chevron-down" size={12} />
        <select
          aria-label="Piece to draw for"
          value={selectedPiece}
          disabled={selectBlocked !== undefined}
          onchange={(e) =>
            onselect?.(Number((e.currentTarget as HTMLSelectElement).value))}
        >
          {#each pieces as _, p (pieces[p].id)}
            <option value={p}>{labelFor(p)}</option>
          {/each}
        </select>
      </label>
      {#if pieces[selectedPiece]?.kind !== "facsimile"}
        <span class="drag-hint">An uploaded encoding needs no regions</span>
      {/if}
      <button
        type="button"
        class="tbtn tbtn-icon mode"
        class:on={ed.drawMode}
        class:drawhint={ed.drawHint && !ed.drawMode}
        aria-pressed={ed.drawMode}
        aria-label="Draw"
        title="Draw: a finger drag draws a new region. Off, a drag scrolls the pages."
        onclick={() => ed.setDrawMode(!ed.drawMode)}
        ><Icon name="touch-box" size={16} /></button
      >
      <button
        type="button"
        class="tbtn tbtn-icon mode"
        class:on={ed.pickMode}
        aria-pressed={ed.pickMode}
        aria-label="Select several"
        disabled={!ed.drawMode}
        title="A tap on a region adds it to the selection or takes it out"
        onclick={() => (ed.pickMode = !ed.pickMode)}
        ><Icon name="select-several" size={16} /></button
      >
    {:else}
      <span
        class="drag-hint"
        title={pieces[selectedPiece]?.kind === "facsimile"
          ? `Drag on a page, or click two corners, to give a region to ${labelFor(selectedPiece)}. ${/Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl+"}drag a region to copy it. Shift+click a region to add it to the selection, or Shift+drag to select every region the rectangle touches; the selected regions move and copy together.`
          : `${labelFor(selectedPiece)} is an uploaded encoding — it needs no regions`}
      >
        {#if pieces[selectedPiece]?.kind === "facsimile"}
          Drag on a page, or click two corners, to give a region to
          <strong style="color: {pieceColour(selectedPiece)}"
            >{labelFor(selectedPiece)}</strong
          >
        {:else}
          <strong style="color: {pieceColour(selectedPiece)}"
            >{labelFor(selectedPiece)}</strong
          >
          is an uploaded encoding — it needs no regions
        {/if}
      </span>
    {/if}
    <div class="toolbar-gap"></div>
    <span class="per-row-ctl"><PagesPerRow bind:value={perRow} /></span>
    <ZoomLevel bind:value={zoom} bind:fit {fitPage} />
  </div>

  {#if notice}
    <p class="msg-warn notice" role="status">{notice}</p>
  {/if}
  <span class="vh" role="status"
    >{ed.armed
      ? `The corner is picked up. ${wizardLayout.coarse ? "Tap" : "Click"} where it should go.`
      : ed.corner
        ? `First corner set on page ${ed.corner.p + 1}. Click the opposite corner to give the region to ${labelFor(ed.corner.scope as number)}.`
        : ed.drawHint
          ? "Turn on Draw, or tap the region twice, to select it."
          : ""}</span
  >

  <div
    class="material-body"
    class:drawing={ed.drawMode}
    bind:this={body}
    bind:clientWidth={bodyW}
    bind:clientHeight={bodyH}
    {@attach zoomGestures({
      get: () => zoom,
      set: (z) => {
        zoom = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)));
        fit = null;
      },
      follow: true,
      onpinchend: () => (fit = nearFit(zoom, fitPage)),
      onpinchstart: () => ed.hold(),
    })}
  >
    <div class="material-grid" style="--per-row: {perRow}; width: {zoom}%">
      {#each pages as page, i (page.url)}
        {@const scale = (svgWidths[i] || 400) / page.width}
        {@const rx = 6 / scale}
        <figure>
          <figcaption class="page-label">Page {i + 1} · Facsimile</figcaption>
          {#if failed[i]}
            <p class="msg-error-inline">Page {i + 1} could not be displayed.</p>
          {/if}
          <svg
            bind:this={svgEls[i]}
            bind:clientWidth={svgWidths[i]}
            viewBox={`0 0 ${page.width} ${page.height}`}
            style="aspect-ratio: {page.width} / {page.height}"
            role="application"
            aria-label={`Page ${i + 1}: piece regions`}
            onpointerdowncapture={(e) => ed.placeArmed(e, i)}
            onpointerdown={(e) => ed.pageDown(e, i)}
          >
            <image
              href={page.url}
              width={page.width}
              height={page.height}
              style="clip-path: inset(0 round {rx}px)"
              onerror={() => (failed[i] = true)}
            />
            {#each zonesOn(i) as { zone, p, z } (`${p}:${z}`)}
              {@const fs =
                Math.min(13, Math.max(9, (svgWidths[i] || 400) / 30)) / scale}
              {@const label = labelFor(p)}
              {@const zw = Math.max(0, zone.lrx - zone.ulx)}
              {@const pillW = Math.min(
                label.length * fs * 0.6 + fs,
                Math.max(0, zw - 2 * rx),
              )}
              {@const btnX = Math.max(
                zone.ulx + 4 / scale,
                zone.lrx - 31 / scale,
              )}
              {@const btnBelowLabel = btnX < zone.ulx + rx + pillW + 6 / scale}
              {@const btnY = btnBelowLabel
                ? zone.uly + rx + fs * 1.5 + 6 / scale
                : zone.uly + 7 / scale}
              <rect
                class="zone"
                class:selected={inSelection(p, z)}
                style="--piece: {pieceColour(p)}"
                vector-effect="non-scaling-stroke"
                role="button"
                tabindex={0}
                aria-label={`${label}: region on page ${i + 1}`}
                x={zone.ulx}
                y={zone.uly}
                width={Math.max(0, zone.lrx - zone.ulx)}
                height={Math.max(0, zone.lry - zone.uly)}
                {rx}
                onpointerdown={(e) => ed.boxDown(e, i, zone)}
                onkeydown={(e) => ed.boxKeydown(e, i, zone)}
              />
              {#if wizardLayout.coarse && !members.length && selectedZone?.piece === p && selectedZone?.zone === z}
                <!-- Press areas around the corner handles, up to 44px but no
                     more than a quarter of the region, so a small region can
                     still be moved; drawn under the label and the delete
                     button. -->
                {@const hitR =
                  Math.min(
                    22,
                    (Math.min(zw, zone.lry - zone.uly) * scale) / 4,
                  ) / scale}
                {#each [{ corner: "nw", cx: zone.ulx, cy: zone.uly }, { corner: "ne", cx: zone.lrx, cy: zone.uly }, { corner: "sw", cx: zone.ulx, cy: zone.lry }, { corner: "se", cx: zone.lrx, cy: zone.lry }] as const as h (h.corner)}
                  <circle
                    class="handle-hit"
                    aria-hidden="true"
                    data-control
                    cx={h.cx}
                    cy={h.cy}
                    r={hitR}
                    onpointerdown={(e) => ed.boxDown(e, i, zone, h.corner)}
                  />
                {/each}
              {/if}
              <clipPath id={`pillclip-${i}-${p}-${z}`}>
                <rect
                  x={zone.ulx + rx}
                  y={zone.uly + rx}
                  width={pillW}
                  height={fs * 1.5}
                  rx={fs * 0.75}
                />
              </clipPath>
              <rect
                class="labelbg"
                style="--piece: {pieceColour(p)}"
                x={zone.ulx + rx}
                y={zone.uly + rx}
                width={pillW}
                height={fs * 1.5}
                rx={fs * 0.75}
              />
              <text
                class="label"
                clip-path={`url(#pillclip-${i}-${p}-${z})`}
                x={zone.ulx + rx + fs * 0.5}
                y={zone.uly + rx + fs * 1.1}
                font-size={fs}
              >
                {label}
              </text>
              {#if !members.length && selectedZone?.piece === p && selectedZone?.zone === z}
                <!-- A delete button pinned inside the region's top-right corner,
                   drawn in screen pixels via the inverse-scale transform. -->
                <g
                  class="delbtn"
                  data-control
                  role="button"
                  tabindex={0}
                  aria-label={`${label}: remove region`}
                  transform={`translate(${btnX}, ${btnY}) scale(${1 / scale})`}
                  onpointerdown={(e) => e.stopPropagation()}
                  onclick={() => ed.deleteSelection()}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      ed.deleteSelection();
                    }
                  }}
                >
                  <rect width="24" height="24" rx="7" />
                  <path
                    transform="translate(2 2)"
                    d="M5.2 6.4h9.6 M8.3 6.2V4.8h3.4v1.4 M6.4 6.6l.5 8.8h6.2l.5-8.8 M8.7 8.8v4.4 M11.3 8.8v4.4"
                  />
                </g>
                {#each [{ corner: "nw", name: "top-left", cx: zone.ulx, cy: zone.uly }, { corner: "ne", name: "top-right", cx: zone.lrx, cy: zone.uly }, { corner: "sw", name: "bottom-left", cx: zone.ulx, cy: zone.lry }, { corner: "se", name: "bottom-right", cx: zone.lrx, cy: zone.lry }] as const as h (h.corner)}
                  <circle
                    class="handle"
                    class:nesw={h.corner === "ne" || h.corner === "sw"}
                    class:armed={ed.armed?.item === zone &&
                      ed.armed.edges === h.corner}
                    data-control
                    style="--piece: {pieceColour(p)}"
                    vector-effect="non-scaling-stroke"
                    role="button"
                    tabindex={0}
                    aria-label={`${label}: resize region (${h.name} corner)`}
                    cx={h.cx}
                    cy={h.cy}
                    r={(wizardLayout.coarse ? 7 : 5) / scale}
                    onpointerdown={(e) => ed.boxDown(e, i, zone, h.corner)}
                    onkeydown={(e) => ed.edgeKeydown(e, i, zone, h.corner)}
                  />
                {/each}
              {/if}
            {/each}
            {#if ed.marquee?.p === i && ed.marquee.moved}
              {@const marquee = ed.marquee}
              {@const m = drawnBox(
                marquee.sx,
                marquee.sy,
                marquee.x,
                marquee.y,
                0,
              )}
              <rect
                class="marquee"
                vector-effect="non-scaling-stroke"
                x={m.ulx}
                y={m.uly}
                width={m.lrx - m.ulx}
                height={m.lry - m.uly}
              />
            {/if}
            {#if ed.corner?.p === i}
              {@const firstCorner = ed.corner}
              {@const r = 9 / scale}
              <path
                class="corner"
                style="--piece: {pieceColour(firstCorner.scope as number)}"
                vector-effect="non-scaling-stroke"
                d={`M${firstCorner.x - r} ${firstCorner.y}H${firstCorner.x + r}M${firstCorner.x} ${firstCorner.y - r}V${firstCorner.y + r}`}
              />
            {/if}
          </svg>
        </figure>
      {/each}
    </div>
  </div>
  <!-- A group's count and actions float over the pages' bottom edge, on an
       anchor that takes no height, so the pages do not shift when a group
       forms. -->
  {#if members.length}
    <div class="groupctl">
      <div class="groupbar">
        <span class="groupcount">{members.length} regions</span>
        <button
          type="button"
          class="btn"
          onclick={() => ed.duplicate()}
          title={`Copy the ${members.length} regions below or beside them`}
          ><Icon name="copy" />Duplicate</button
        >
        <button
          type="button"
          class="btn btn-danger"
          onclick={() => ed.deleteSelection()}
          title={`Delete the ${members.length} regions`}
          ><Icon name="trash" />Delete</button
        >
        <button
          type="button"
          class="btn"
          onclick={() => ed.select(0, null)}
          title="Deselect the regions"><Icon name="close" />Deselect</button
        >
      </div>
    </div>
  {/if}
</div>

<style>
  .undoredo {
    flex: none;
    display: flex;
    gap: 2px;
  }
  /* A Shift+drag's selection rectangle. */
  .marquee {
    fill: color-mix(in srgb, var(--ink) 6%, transparent);
    stroke: var(--ink-soft);
    stroke-width: 1.5px;
    stroke-dasharray: 5 4;
    pointer-events: none;
  }
  .groupctl {
    flex: none;
    position: relative;
    height: 0;
    z-index: 2;
  }
  .groupbar {
    position: absolute;
    left: 50%;
    bottom: 12px;
    transform: translateX(-50%);
    box-sizing: border-box;
    max-width: calc(100% - 24px);
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    background: var(--card);
    border-radius: 18px;
    box-shadow: var(--shadow-sm);
  }
  .groupcount {
    padding: 0 6px;
    font: 600 12.5px var(--font);
    white-space: nowrap;
  }
  /* The first corner of a region drawn by two clicks. */
  .corner {
    stroke: var(--piece);
    stroke-width: 2px;
    pointer-events: none;
  }
  /* Up to two lines in the toolbar; the title carries the whole text. */
  .drag-hint {
    min-width: 0;
    font-size: 12px;
    line-height: 1.35;
    color: var(--ink-soft);
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  /* The piece picker: a chip over a transparent native select. */
  .pchip {
    position: relative;
    flex: 0 1 auto;
    min-width: 0;
    max-width: 170px;
    height: 32px;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 12px;
    font: 600 12.5px var(--font);
    color: var(--ink);
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  .pchip .swatch {
    flex: none;
    width: 12px;
    height: 12px;
    border-radius: 3px;
    background: var(--piece);
  }
  .pchip-name {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pchip select {
    position: absolute;
    inset: -6px;
    width: calc(100% + 12px);
    opacity: 0;
    font-size: 16px;
  }
  @container material (max-width: 439px) {
    .per-row-ctl {
      display: none;
    }
  }
  /* Phone width: the picker, Draw and Select several fill the first row,
     so the picker shows the piece name; undo, redo and the zoom take the
     second. */
  @container material (max-width: 479px) {
    .material-toolbar.touch {
      flex-wrap: wrap;
      row-gap: 6px;
      padding-block: 8px;
    }
    .touch .pchip,
    .touch .mode {
      order: -1;
    }
    .pchip {
      flex: 1 1 calc(100% - 2 * 32px - 2 * 10px);
      max-width: none;
      gap: 5px;
      padding: 0 8px;
    }
  }
  /* Draw: fingers belong to the editor, two of them panning and zooming. */
  .material-body.drawing {
    touch-action: none;
  }
  .notice {
    margin: 0;
    padding: 6px 16px;
    border-bottom: 1px solid var(--line);
  }
  figure {
    min-width: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  svg {
    display: block;
    /* The page takes its column's width; the inline aspect-ratio, which is the
       page image's own, then decides its height. */
    width: 100%;
    height: auto;
    box-sizing: border-box;
    /* Scanned pages keep their own light ground in either theme. */
    background: var(--facsimile-paper);
    border: 1px solid var(--line-input);
    box-shadow: var(--shadow-paper);
    /* Strokes are centred on their edge, so a region flush with the page
       boundary paints half its outline outside the viewBox; without this it
       is clipped and corners go missing. */
    overflow: visible;
  }
  .zone {
    fill: var(--piece);
    fill-opacity: var(--zone-fill-alpha);
    stroke: var(--piece);
    /* The markup sets vector-effect="non-scaling-stroke" (as an attribute —
       CSS support for it is inconsistent), so this width is screen pixels:
       the outline stays crisp at every zoom level. */
    stroke-width: 2;
    cursor: move;
  }
  .zone.selected {
    fill-opacity: calc(var(--zone-fill-alpha) * 1.6);
    stroke-width: 3.5;
  }
  @media (hover: hover) {
    .zone:hover {
      fill-opacity: calc(var(--zone-fill-alpha) * 1.6);
      stroke-width: 3.5;
    }
  }
  .zone:focus-visible {
    outline: none;
    stroke-dasharray: 8 4;
  }
  .labelbg {
    fill: var(--piece);
    pointer-events: none;
  }
  .label {
    fill: #fff;
    font-weight: 600;
    pointer-events: none;
  }
  .handle {
    fill: var(--card);
    stroke: var(--piece);
    stroke-width: 2;
    cursor: nwse-resize;
  }
  .handle.nesw {
    cursor: nesw-resize;
  }
  /* A picked-up corner (armed) fills with its piece's colour. */
  .handle.armed {
    fill: var(--piece);
  }
  .handle-hit {
    fill: transparent;
  }
  .delbtn {
    cursor: pointer;
  }
  .delbtn rect {
    fill: var(--card);
    stroke: var(--line-input);
  }
  .delbtn:focus-visible rect {
    stroke: var(--danger);
  }
  @media (hover: hover) {
    .delbtn:hover rect {
      stroke: var(--danger);
    }
  }
  .delbtn path {
    fill: none;
    stroke: var(--danger);
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    pointer-events: none;
  }
</style>
