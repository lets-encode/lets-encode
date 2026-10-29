<!--
  Mark which regions of the page images belong to which piece. Fills the
  material pane: a toolbar naming the piece being marked, and the pages in a
  grid under it.

  A sibling of the measure zone editor: the same SVG rectangle model (draw on
  the background, drag to move, corner handle to resize, arrow keys to nudge),
  but the rectangles are far coarser — one per stretch of a page a piece
  occupies — and each is coloured and labelled by its piece. Regions drawn while
  a piece is selected belong to that piece, so a piece can span several pages
  and two pieces can share one, as long as their regions do not overlap.

  Coordinates are the page image's own pixels, which is what the detector
  returns boxes in, so no rescaling is needed when the boxes are partitioned.

  On touch the toolbar holds a piece picker, a Draw toggle and Select
  several. In Draw one finger draws, moves and resizes, and two fingers pan
  and zoom; a second finger landing mid-edit undoes the edit it interrupted.
  Out of Draw a finger or a pen scrolls and nothing is edited.

  Several regions of one page can be selected together: Shift+click adds or
  removes one, Shift+drag selects every region its rectangle touches, and
  Select several turns a tap into the same toggle. A selected group moves,
  copies and is deleted as a whole. Undo and redo restore the regions.
-->
<script lang="ts">
  import {
    arrowShift,
    boundingBox,
    boxesTouch,
    copyPlace,
    drawnBox,
    drawStarted,
    movedBox,
    movedBoxes,
    nudgedEdges,
    pagePoint,
    resizedBox,
  } from "$lib/box-geometry.ts";
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

  // The region being drawn, moved or resized, addressed by page, piece and
  // index within that piece so the reference survives a re-render.
  type Corner = "nw" | "ne" | "sw" | "se";
  type Drag = {
    kind: "draw" | "move" | "resize";
    page: number;
    piece: number;
    zone: number;
    sx: number;
    sy: number;
    origin: PieceZone;
    /** Which corner a resize grabbed. */
    corner?: Corner;
    /** A draw creates its zone only once the pointer has moved a few
        millimetres on screen, so a plain click leaves nothing behind. */
    started?: boolean;
    /** A background press that cleared a selection only deselects; it never
        sets a corner. */
    deselected?: boolean;
    /** A Cmd/Ctrl move drags a copy: the index of the region it copies. */
    copyOf?: number;
    /** A move of a group: each region and where it started. */
    members?: { zone: PieceZone; origin: PieceZone }[];
    /** A Cmd/Ctrl move of a group: the regions it copies. */
    copied?: PieceZone[];
    /** A group moves only once the pointer has travelled a few millimetres. */
    moved?: boolean;
  };
  let drag: Drag | null = null;
  // A Shift+drag's rectangle, in page pixels: every region it touches joins
  // the regions selected when it began (base). A Shift+click without a drag
  // adds the region it was on (hit) or takes it out.
  let marquee = $state.raw<{
    surface: number;
    sx: number;
    sy: number;
    x: number;
    y: number;
    moved: boolean;
    base: PieceZone[];
    hit: PieceZone | null;
  } | null>(null);
  // The first corner of a region drawn by two clicks instead of a drag, in
  // page pixels. A second click on the same page for the same piece completes
  // the region; a second click on the same spot clears the corner.
  let firstCorner = $state<{
    surface: number;
    piece: number;
    x: number;
    y: number;
  } | null>(null);

  // What a finger does on the pages; a mouse or pen always edits. A finger
  // starts by scrolling, so reaching the next page draws nothing.
  let touchMode = $state<"draw" | "scroll">("scroll");
  // Fingers down on the pages. A second one turns the touch into a pan and
  // zoom, and no finger edits again until all have lifted.
  const fingers = new Set<number>();
  let gestureHeld = false;

  /** Whether this press may start an edit, keeping count of the fingers. */
  function mayEdit(e: PointerEvent): boolean {
    if (e.pointerType === "mouse") return true;
    if (e.pointerType === "touch") fingers.add(e.pointerId);
    return !gestureHeld && touchMode === "draw";
  }
  function holdGesture() {
    gestureHeld = true;
    cancelDrag();
  }
  function releaseFinger(e: PointerEvent) {
    if (e.pointerType !== "touch") return;
    fingers.delete(e.pointerId);
    if (!fingers.size) gestureHeld = false;
  }

  /** Undo the edit in progress: a drawn region goes, a moved one returns. */
  function cancelDrag() {
    if (marquee) {
      selectRegions(marquee.base);
      marquee = null;
    }
    if (!drag) return;
    const { kind, piece, zone, origin, started, copyOf, members, copied } =
      drag;
    drag = null;
    if (members) {
      if (copied) dropCopies(members, copied);
      else members.forEach((m) => Object.assign(m.zone, m.origin));
    } else if (copyOf !== undefined) {
      pieces[piece].zones.splice(zone, 1);
      selectedZone = { piece, zone: copyOf };
    } else if (kind === "draw") {
      if (started) {
        pieces[piece].zones.splice(zone, 1);
        selectedZone = null;
      }
    } else {
      Object.assign(pieces[piece].zones[zone], origin);
    }
  }
  // Arrow keys move a region NUDGE page pixels, NUDGE_FAR with Shift.
  const NUDGE = 4;
  const NUDGE_FAR = 20;
  let selectedZone = $state<{ piece: number; zone: number } | null>(null);
  // Several regions of one page selected together, `selectedZone` among
  // them. Held as the regions, since removing one changes the indices;
  // empty while one region or none is selected.
  let group = $state.raw<PieceZone[]>([]);
  // Select several: a click or tap on a region adds it to the selection or
  // takes it out.
  let pickMode = $state(false);
  // Selecting a region outside the group ends the group; selecting nothing
  // also ends Select several.
  $effect(() => {
    const s = selectedZone;
    untrack(() => {
      if (!s || !group.includes(pieces[s.piece]?.zones[s.zone])) group = [];
      if (!s) pickMode = false;
    });
  });
  // Undo and redo: a snapshot of every piece's regions, by piece id, taken
  // when a pointer release, key release or click leaves them changed. Adding
  // or removing a piece starts the history again: a new piece can take a
  // removed piece's id.
  const HISTORY_LIMIT = 100;
  type Snapshot = Record<string, PieceZone[]>;
  const snapshot = (): Snapshot =>
    Object.fromEntries(
      pieces.map((piece) => [piece.id, piece.zones.map((z) => ({ ...z }))]),
    );
  let history = $state.raw<Snapshot[]>([]);
  let historyIndex = $state(-1);
  const canUndo = $derived(historyIndex > 0);
  const canRedo = $derived(historyIndex < history.length - 1);
  function commit() {
    if (drag) return;
    const now = snapshot();
    const last = history[historyIndex];
    if (JSON.stringify(now) === JSON.stringify(last)) return;
    const ids = (snap: Snapshot) => Object.keys(snap).join("\n");
    if (!last || ids(now) !== ids(last)) {
      history = [now];
      historyIndex = 0;
      return;
    }
    history = [
      ...history.slice(
        Math.max(0, historyIndex + 2 - HISTORY_LIMIT),
        historyIndex + 1,
      ),
      now,
    ];
    historyIndex = history.length - 1;
  }
  $effect(() => untrack(commit));
  function restore(i: number) {
    historyIndex = i;
    for (const piece of pieces) {
      const zones = history[i][piece.id];
      if (zones) piece.zones = zones.map((z) => ({ ...z }));
    }
    selectedZone = null;
    firstCorner = null;
  }
  function undo() {
    if (canUndo && !drag) restore(historyIndex - 1);
  }
  function redo() {
    if (canRedo && !drag) restore(historyIndex + 1);
  }

  // The group's regions with their piece and index; empty without a group.
  const members = $derived.by(() => {
    if (group.length < 2) return [];
    const found = pieces.flatMap((piece, p) =>
      piece.zones
        .map((zone, z) => ({ zone, p, z }))
        .filter(({ zone }) => group.includes(zone)),
    );
    return found.length > 1 ? found : [];
  });
  const inSelection = (p: number, z: number) =>
    (selectedZone?.piece === p && selectedZone.zone === z) ||
    members.some((m) => m.p === p && m.z === z);
  // The selected regions: the group, or the one region.
  const selectedRegions = (): PieceZone[] =>
    members.length
      ? members.map((m) => m.zone)
      : selectedZone
        ? [pieces[selectedZone.piece]?.zones[selectedZone.zone]].filter(Boolean)
        : [];
  const locate = (zone: PieceZone) => {
    const piece = pieces.findIndex((pc) => pc.zones.includes(zone));
    return piece < 0
      ? null
      : { piece, zone: pieces[piece].zones.indexOf(zone) };
  };
  // Select the regions `list`; the selected region stays selected where it
  // is in the list.
  function selectRegions(list: PieceZone[]) {
    const now = selectedZone
      ? pieces[selectedZone.piece]?.zones[selectedZone.zone]
      : undefined;
    const primary = now && list.includes(now) ? now : list[list.length - 1];
    group = list.length > 1 ? list : [];
    selectedZone = primary ? locate(primary) : null;
  }
  // Add a region to the selection, or take it out. A selection holds the
  // regions of one page.
  function toggleRegion(p: number, z: number) {
    const zone = pieces[p].zones[z];
    const now = selectedRegions().filter((r) => r.surface === zone.surface);
    selectRegions(
      now.includes(zone) ? now.filter((r) => r !== zone) : [...now, zone],
    );
  }
  // The first piece another piece's region of `zones` overlaps; -1 for none.
  const firstClash = (zones: PieceZone[]) => {
    for (const zone of zones) {
      const clash = overlappingPiece(pieces, locate(zone)?.piece ?? -1, zone);
      if (clash !== -1) return clash;
    }
    return -1;
  };
  // Remove regions; nothing stays selected.
  function removeRegions(zones: PieceZone[]) {
    for (const zone of zones) {
      const at = locate(zone);
      if (at) pieces[at.piece].zones.splice(at.zone, 1);
    }
    selectedZone = null;
  }
  // Undo a Cmd/Ctrl move of a group: its copies go, and the regions it
  // copied are selected again.
  function dropCopies(
    moving: NonNullable<Drag["members"]>,
    copied: PieceZone[],
  ) {
    removeRegions(moving.map((m) => m.zone));
    selectRegions(copied);
  }
  // Copies of the selected group beside it (copyPlace), selected in its
  // place, unless they would overlap another piece's region.
  function duplicateGroup() {
    if (!members.length) return;
    const surface = members[0].zone.surface;
    const page = pages[surface];
    if (!page) return;
    const boxes = copyPlace(
      members.map((m) => m.zone),
      page,
    );
    const copies = members.map((m, i) => {
      const zones = pieces[m.p].zones;
      zones.push({ surface, ...boxes[i] });
      return zones[zones.length - 1];
    });
    const clash = firstClash(copies);
    notice = clash === -1 ? null : overlapNotice(clash, surface);
    if (clash === -1) selectRegions(copies);
    else {
      const keep = members.map((m) => m.zone);
      removeRegions(copies);
      selectRegions(keep);
    }
  }
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

  function svgXY(
    e: { clientX: number; clientY: number },
    surface: number,
  ): { x: number; y: number } {
    const svg = svgEls[surface];
    const page = pages[surface];
    if (!svg || !page) return { x: 0, y: 0 };
    return pagePoint(e, svg.getBoundingClientRect(), page);
  }

  function backgroundPointerDown(e: PointerEvent, surface: number) {
    if (!mayEdit(e)) return;
    // A Shift+drag selects the regions it touches, adding them to the
    // selection.
    if (e.shiftKey) {
      startMarquee(e, surface, null);
      return;
    }
    const deselected = selectedZone !== null;
    selectedZone = null;
    const piece = pieces[selectedPiece];
    if (!piece || piece.kind !== "facsimile") return;
    const { x, y } = svgXY(e, surface);
    drag = {
      kind: "draw",
      page: surface,
      piece: selectedPiece,
      zone: -1,
      sx: x,
      sy: y,
      origin: { surface, ulx: x, uly: y, lrx: x, lry: y },
      started: false,
      deselected,
    };
  }

  function cornerClick(surface: number, p: number, x: number, y: number) {
    const first = firstCorner;
    firstCorner = null;
    if (!first || first.surface !== surface || first.piece !== p) {
      firstCorner = { surface, piece: p, x, y };
      return;
    }
    const minSize = minSizeOn(surface);
    const zone: PieceZone = {
      surface,
      ...drawnBox(first.x, first.y, x, y, minSize),
    };
    if (zone.lrx - zone.ulx < minSize || zone.lry - zone.uly < minSize) return;
    snapToNeighbours(zone, surface, () => false);
    const clash = overlappingPiece(pieces, p, zone);
    notice = clash === -1 ? null : overlapNotice(clash, surface);
    if (clash !== -1) return;
    pieces[p].zones.push(zone);
    selectedZone = { piece: p, zone: pieces[p].zones.length - 1 };
  }

  function zonePointerDown(
    e: PointerEvent,
    surface: number,
    p: number,
    z: number,
  ) {
    e.stopPropagation();
    if (!mayEdit(e)) return;
    firstCorner = null;
    // With Shift a click adds the region to the selection or takes it out,
    // and a drag selects with a rectangle; in Select several a click adds a
    // region.
    if (e.shiftKey || (pickMode && !inSelection(p, z))) {
      if (e.shiftKey) startMarquee(e, surface, pieces[p].zones[z]);
      else toggleRegion(p, z);
      return;
    }
    const origin = { ...pieces[p].zones[z] };
    // Cmd (Mac) or Ctrl drags a copy of the region; the original stays.
    const copy = /Mac|iPhone|iPad/.test(navigator.userAgent)
      ? e.metaKey
      : e.ctrlKey;
    const { x, y } = svgXY(e, surface);
    // A region of a group moves the whole group, or with Cmd/Ctrl a copy of
    // it.
    const pressed = pieces[p].zones[z];
    if (members.some((m) => m.zone === pressed)) {
      const together = members.map((m) => m.zone);
      const moving = copy
        ? members.map((m) => {
            const zones = pieces[m.p].zones;
            zones.push({ ...m.zone });
            return zones[zones.length - 1];
          })
        : together;
      group = moving;
      selectedZone = locate(moving[together.indexOf(pressed)]);
      drag = {
        kind: "move",
        page: surface,
        piece: selectedZone!.piece,
        zone: selectedZone!.zone,
        sx: x,
        sy: y,
        origin,
        members: moving.map((zone, i) => ({
          zone,
          origin: { ...together[i] },
        })),
        copied: copy ? together : undefined,
      };
      return;
    }
    const zone = copy ? pieces[p].zones.push({ ...origin }) - 1 : z;
    selectedZone = { piece: p, zone };
    drag = {
      kind: "move",
      page: surface,
      piece: p,
      zone,
      sx: x,
      sy: y,
      origin,
      copyOf: copy ? z : undefined,
    };
  }

  function handlePointerDown(
    e: PointerEvent,
    surface: number,
    p: number,
    z: number,
    corner: Corner,
  ) {
    e.stopPropagation();
    if (!mayEdit(e)) return;
    firstCorner = null;
    selectedZone = { piece: p, zone: z };
    const { x, y } = svgXY(e, surface);
    drag = {
      kind: "resize",
      page: surface,
      piece: p,
      zone: z,
      sx: x,
      sy: y,
      origin: { ...pieces[p].zones[z] },
      corner,
    };
  }

  // A Shift press on a page, on region `hit` or the background (null).
  function startMarquee(
    e: PointerEvent,
    surface: number,
    hit: PieceZone | null,
  ) {
    const { x, y } = svgXY(e, surface);
    marquee = {
      surface,
      sx: x,
      sy: y,
      x,
      y,
      moved: false,
      base: selectedRegions().filter((r) => r.surface === surface),
      hit,
    };
  }
  function marqueeTo(e: { clientX: number; clientY: number }) {
    const m = marquee!;
    const page = pages[m.surface];
    if (!page) return;
    const { x, y } = svgXY(e, m.surface);
    if (
      !m.moved &&
      !drawStarted(x - m.sx, y - m.sy, page, svgWidths[m.surface] || 400)
    )
      return;
    marquee = { ...m, x, y, moved: true };
    const area = drawnBox(m.sx, m.sy, x, y, 0);
    const hits = zonesOn(m.surface)
      .map(({ zone }) => zone)
      .filter((zone) => boxesTouch(area, zone) && !m.base.includes(zone));
    selectRegions([...m.base, ...hits]);
  }

  // An edge within a few screen pixels of another region's edge snaps to it,
  // so regions sit exactly side by side instead of overlapping by a stray
  // pixel, which would reject the region.
  function snapToNeighbours(
    zone: PieceZone,
    surface: number,
    skip: (other: PieceZone) => boolean,
  ) {
    const page = pages[surface];
    if (!page) return;
    const tolerance = 6 * (page.width / (svgWidths[surface] || 400));
    const xs: number[] = [];
    const ys: number[] = [];
    pieces.forEach((pc) =>
      pc.zones.forEach((o) => {
        if (o.surface !== surface || skip(o)) return;
        xs.push(o.ulx, o.lrx);
        ys.push(o.uly, o.lry);
      }),
    );
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
    zone.ulx = snap(zone.ulx, xs);
    zone.lrx = snap(zone.lrx, xs);
    zone.uly = snap(zone.uly, ys);
    zone.lry = snap(zone.lry, ys);
  }

  // Dragging near the pane's edge scrolls it, so a region can be drawn or
  // moved past what is in view; the edit follows the pointer as it scrolls.
  const EDGE = 40;
  let lastPointer: { clientX: number; clientY: number } | null = null;
  let edgeScroll = 0;
  function scrollAtEdge() {
    edgeScroll = 0;
    if (!drag || !lastPointer || !body) return;
    const box = body.getBoundingClientRect();
    const step = (inside: number) => Math.ceil((EDGE - inside) / 4);
    const { clientX: x, clientY: y } = lastPointer;
    const dy =
      y < box.top + EDGE
        ? -step(y - box.top)
        : y > box.bottom - EDGE
          ? step(box.bottom - y)
          : 0;
    const dx =
      x < box.left + EDGE
        ? -step(x - box.left)
        : x > box.right - EDGE
          ? step(box.right - x)
          : 0;
    const top = body.scrollTop;
    const left = body.scrollLeft;
    body.scrollTop += dy;
    body.scrollLeft += dx;
    if (body.scrollTop !== top || body.scrollLeft !== left)
      applyDrag(lastPointer);
    edgeScroll = requestAnimationFrame(scrollAtEdge);
  }

  function pointerMove(e: PointerEvent) {
    if (marquee) marqueeTo(e);
    if (!drag) return;
    lastPointer = { clientX: e.clientX, clientY: e.clientY };
    applyDrag(lastPointer);
    if (!edgeScroll) edgeScroll = requestAnimationFrame(scrollAtEdge);
  }

  function applyDrag(e: { clientX: number; clientY: number }) {
    if (!drag) return;
    const page = pages[drag.page];
    if (!page) return;
    const { x, y } = svgXY(e, drag.page);
    if (drag.kind === "draw" && !drag.started) {
      // No region until the pointer has dragged a few millimetres.
      if (
        !drawStarted(
          x - drag.sx,
          y - drag.sy,
          page,
          svgWidths[drag.page] || 400,
        )
      )
        return;
      firstCorner = null;
      const piece = pieces[drag.piece];
      piece.zones.push({ ...drag.origin });
      drag.zone = piece.zones.length - 1;
      drag.started = true;
      selectedZone = { piece: drag.piece, zone: drag.zone };
    }
    if (drag.members) {
      if (
        !drag.moved &&
        !drawStarted(
          x - drag.sx,
          y - drag.sy,
          page,
          svgWidths[drag.page] || 400,
        )
      )
        return;
      drag.moved = true;
      const moved = movedBoxes(
        drag.members.map((m) => m.origin),
        x - drag.sx,
        y - drag.sy,
        page,
      );
      const own = drag.members.map((m) => m.zone);
      const { dx, dy } = snapShift(
        { surface: drag.page, ...boundingBox(moved) },
        drag.page,
        (o) => own.includes(o),
      );
      drag.members.forEach((m, i) =>
        Object.assign(m.zone, movedBox(moved[i], dx, dy, page)),
      );
      return;
    }
    const zone = pieces[drag.piece].zones[drag.zone];
    const minSize = minSizeOn(drag.page);
    if (drag.kind === "move") {
      Object.assign(
        zone,
        movedBox(drag.origin, x - drag.sx, y - drag.sy, page),
      );
      const { dx, dy } = snapShift(zone, drag.page, (o) => o === zone);
      zone.ulx += dx;
      zone.lrx += dx;
      zone.uly += dy;
      zone.lry += dy;
    } else if (drag.kind === "draw") {
      Object.assign(zone, drawnBox(drag.sx, drag.sy, x, y, minSize));
      snapToNeighbours(zone, drag.page, (o) => o === zone);
    } else {
      // Resizing moves the grabbed corner's two edges.
      Object.assign(
        zone,
        resizedBox(drag.origin, drag.corner ?? "se", x, y, minSize),
      );
      snapToNeighbours(zone, drag.page, (o) => o === zone);
    }
  }

  // Snapping shifts a moved region or group, keeping its size: whichever
  // edge of `box` snaps decides the shift.
  function snapShift(
    box: PieceZone,
    surface: number,
    skip: (other: PieceZone) => boolean,
  ) {
    const snapped = { ...box };
    snapToNeighbours(snapped, surface, skip);
    return {
      dx:
        snapped.ulx !== box.ulx ? snapped.ulx - box.ulx : snapped.lrx - box.lrx,
      dy:
        snapped.uly !== box.uly ? snapped.uly - box.uly : snapped.lry - box.lry,
    };
  }

  function pointerUp(e: PointerEvent) {
    releaseFinger(e);
    if (marquee) {
      const m = marquee;
      marquee = null;
      const at = !m.moved && m.hit ? locate(m.hit) : null;
      if (at) toggleRegion(at.piece, at.zone);
    }
    if (drag?.members) {
      const { members: moving, copied, moved, page, piece, zone } = drag;
      drag = null;
      notice = null;
      // A press that never moved: in Select several it takes the region out
      // of the selection, otherwise it selects that region alone; a Cmd/Ctrl
      // click leaves no copies behind.
      if (!moved) {
        if (copied) dropCopies(moving, copied);
        else if (pickMode) toggleRegion(piece, zone);
        else selectRegions([pieces[piece].zones[zone]]);
        return;
      }
      const clash = firstClash(moving.map((m) => m.zone));
      if (clash === -1) return;
      notice = overlapNotice(clash, page);
      if (copied) dropCopies(moving, copied);
      else moving.forEach((m) => Object.assign(m.zone, m.origin));
      return;
    }
    if (!drag) return;
    const {
      kind,
      page,
      piece,
      zone: z,
      origin,
      started,
      deselected,
      sx,
      sy,
      copyOf,
    } = drag;
    drag = null;
    // A draw that never crossed the drag threshold was a plain click.
    if (kind === "draw" && !started) {
      if (!deselected) cornerClick(page, piece, sx, sy);
      return;
    }
    notice = null;
    const zone = pieces[piece].zones[z];
    // A copy left where the original is was a Cmd/Ctrl click: no copy.
    if (
      copyOf !== undefined &&
      zone.ulx === origin.ulx &&
      zone.uly === origin.uly
    ) {
      pieces[piece].zones.splice(z, 1);
      selectedZone = { piece, zone: copyOf };
      return;
    }
    // A region pressed in Select several without moving it leaves the
    // selection.
    if (
      kind === "move" &&
      pickMode &&
      zone.ulx === origin.ulx &&
      zone.uly === origin.uly
    ) {
      toggleRegion(piece, z);
      return;
    }
    const minSize = minSizeOn(page);
    // A tiny rectangle was a click on the background, not a region.
    if (
      kind === "draw" &&
      (zone.lrx - zone.ulx < minSize || zone.lry - zone.uly < minSize)
    ) {
      pieces[piece].zones.splice(z, 1);
      selectedZone = null;
      return;
    }
    const clash = overlappingPiece(pieces, piece, zone);
    if (clash === -1) return;
    notice = overlapNotice(clash, page);
    if (kind === "draw" || copyOf !== undefined) {
      pieces[piece].zones.splice(z, 1);
      selectedZone = copyOf === undefined ? null : { piece, zone: copyOf };
    } else {
      Object.assign(zone, origin);
    }
  }

  const overlapNotice = (clash: number, surface: number) =>
    `Regions cannot overlap: ${labelFor(clash)} already covers part of that area on page ${surface + 1}.`;

  function zoneKeydown(
    e: KeyboardEvent,
    surface: number,
    p: number,
    z: number,
  ) {
    // A region of a group: the keys act on the whole group.
    const inGroup = members.some((m) => m.p === p && m.z === z);
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      // With Shift the key adds the region to the selection or takes it out.
      if (e.shiftKey) toggleRegion(p, z);
      else {
        group = [];
        selectedZone = { piece: p, zone: z };
      }
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      if (inGroup) {
        removeRegions(members.map((m) => m.zone));
        notice = null;
      } else removeZone(p, z);
      return;
    }
    const page = pages[surface];
    const shift = arrowShift(e.key, e.shiftKey ? NUDGE_FAR : NUDGE);
    if (!shift || !page) return;
    e.preventDefault();
    if (inGroup) {
      const zones = members.map((m) => m.zone);
      const before = zones.map((zone) => ({ ...zone }));
      const moved = movedBoxes(zones, shift.dx, shift.dy, page);
      zones.forEach((zone, i) => Object.assign(zone, moved[i]));
      const clash = firstClash(zones);
      notice = clash === -1 ? null : overlapNotice(clash, surface);
      if (clash !== -1)
        zones.forEach((zone, i) => Object.assign(zone, before[i]));
      return;
    }
    selectedZone = { piece: p, zone: z };
    const zone = pieces[p].zones[z];
    const moved = {
      surface,
      ...movedBox(zone, shift.dx, shift.dy, page),
    };
    const clash = overlappingPiece(pieces, p, moved);
    notice = clash === -1 ? null : overlapNotice(clash, surface);
    if (clash === -1) Object.assign(zone, moved);
  }

  // Arrow keys on a focused corner handle move that corner.
  function handleKeydown(
    e: KeyboardEvent,
    surface: number,
    p: number,
    z: number,
    corner: string,
  ) {
    const page = pages[surface];
    const shift = arrowShift(e.key, e.shiftKey ? NUDGE_FAR : NUDGE);
    if (!shift || !page) return;
    e.preventDefault();
    const zone = pieces[p].zones[z];
    const resized = {
      surface,
      ...nudgedEdges(
        zone,
        corner,
        shift.dx,
        shift.dy,
        minSizeOn(surface),
        page,
      ),
    };
    const clash = overlappingPiece(pieces, p, resized);
    notice = clash === -1 ? null : overlapNotice(clash, surface);
    if (clash === -1) Object.assign(zone, resized);
  }

  function removeZone(p: number, z: number) {
    pieces[p].zones.splice(z, 1);
    selectedZone = null;
    notice = null;
  }

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
    const typing = (e.target as Element).closest(
      "input, textarea, select, [contenteditable]",
    );
    // Cmd/Ctrl+Z undoes; add Shift (or Ctrl+Y) to redo.
    if (!typing && (e.ctrlKey || e.metaKey) && /^[zy]$/i.test(e.key)) {
      e.preventDefault();
      if (e.shiftKey || e.key.toLowerCase() === "y") redo();
      else undo();
      return;
    }
    if (e.key !== "Escape") return;
    if (firstCorner) firstCorner = null;
    else if (members.length) selectedZone = null;
  }}
  onkeyup={commit}
  onclick={commit}
  onpointermove={pointerMove}
  onpointerup={(e) => {
    pointerUp(e);
    commit();
  }}
  onpointercancel={(e) => {
    releaseFinger(e);
    cancelDrag();
  }}
/>

<div class="material-card">
  <div class="material-toolbar">
    <span class="undoredo">
      <button
        type="button"
        class="btn btn-icon"
        onclick={undo}
        disabled={!canUndo}
        aria-label="Undo"
        title="Undo the last change (Ctrl/Cmd+Z)"><Icon name="undo" /></button
      >
      <button
        type="button"
        class="btn btn-icon"
        onclick={redo}
        disabled={!canRedo}
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
        class="tbtn tbtn-icon"
        class:on={touchMode === "draw"}
        aria-pressed={touchMode === "draw"}
        aria-label="Draw"
        title="Draw: a finger drag draws a new region. Off, a drag scrolls the pages."
        onclick={() => {
          if (touchMode === "scroll") touchMode = "draw";
          else {
            // A finger that scrolls edits nothing, so no region stays selected.
            touchMode = "scroll";
            selectedZone = null;
          }
        }}><Icon name="touch-box" size={16} /></button
      >
      <button
        type="button"
        class="tbtn tbtn-icon"
        class:on={pickMode}
        aria-pressed={pickMode}
        aria-label="Select several"
        disabled={touchMode !== "draw"}
        title="A tap on a region adds it to the selection or takes it out"
        onclick={() => (pickMode = !pickMode)}
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
    >{firstCorner
      ? `First corner set on page ${firstCorner.surface + 1}. Click the opposite corner to give the region to ${labelFor(firstCorner.piece)}.`
      : ""}</span
  >

  <div
    class="material-body"
    class:drawing={touchMode === "draw"}
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
      onpinchstart: holdGesture,
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
            onpointerdown={(e) => backgroundPointerDown(e, i)}
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
                onpointerdown={(e) => zonePointerDown(e, i, p, z)}
                onkeydown={(e) => zoneKeydown(e, i, p, z)}
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
                    cx={h.cx}
                    cy={h.cy}
                    r={hitR}
                    onpointerdown={(e) =>
                      handlePointerDown(e, i, p, z, h.corner)}
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
                  role="button"
                  tabindex={0}
                  aria-label={`${label}: remove region`}
                  transform={`translate(${btnX}, ${btnY}) scale(${1 / scale})`}
                  onpointerdown={(e) => e.stopPropagation()}
                  onclick={() => removeZone(p, z)}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      removeZone(p, z);
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
                    style="--piece: {pieceColour(p)}"
                    vector-effect="non-scaling-stroke"
                    role="button"
                    tabindex={0}
                    aria-label={`${label}: resize region (${h.name} corner)`}
                    cx={h.cx}
                    cy={h.cy}
                    r={(wizardLayout.coarse ? 7 : 5) / scale}
                    onpointerdown={(e) =>
                      handlePointerDown(e, i, p, z, h.corner)}
                    onkeydown={(e) => handleKeydown(e, i, p, z, h.corner)}
                  />
                {/each}
              {/if}
            {/each}
            {#if marquee?.surface === i && marquee.moved}
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
            {#if firstCorner?.surface === i}
              {@const r = 9 / scale}
              <path
                class="corner"
                style="--piece: {pieceColour(firstCorner.piece)}"
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
          onclick={duplicateGroup}
          title={`Copy the ${members.length} regions below or beside them`}
          ><Icon name="copy" />Duplicate</button
        >
        <button
          type="button"
          class="btn btn-danger"
          onclick={() => {
            removeRegions(members.map((m) => m.zone));
            notice = null;
          }}
          title={`Delete the ${members.length} regions`}
          ><Icon name="trash" />Delete</button
        >
        <button
          type="button"
          class="btn"
          onclick={() => (selectedZone = null)}
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
  /* Phone width: the picker keeps as much of the piece name as it can. */
  @container material (max-width: 479px) {
    .pchip {
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
