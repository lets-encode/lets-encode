<!--
  A facsimile page in a scrolling view that opens framed on one region of it
  (`frame`, in the page image's pixels), fitted whole into the view below the
  zoom controls, with a second region (`mark`) outlined. Scrolling or a mouse
  drag pans; the − / + buttons, a pinch or Ctrl/Cmd + scroll zoom
  (zoomGestures); the fit button brings the frame back. While framed, the
  view keeps the frame fitted as it resizes; a new frame is fitted afresh.
  Once moved away, a zoom or a resize keeps the point at the view's centre in
  place. A host showing something other than its usual frame sets `away`:
  the fit button then calls `onfit`.
  Given `align`, the frame is not fitted but lined up: scaled so the image
  heights `uly` and `lry` meet the screen heights `top` and `bottom`, the
  frame's left edge at the view's left.
-->
<script module lang="ts">
  export type Box = { ulx: number; uly: number; lrx: number; lry: number };

  /** Room left around the fitted frame, in CSS pixels. */
  const MARGIN = 6;
  /** The band at the view's top the zoom controls take; the fitted frame
      stays below it. */
  const BAND = 44;

  /** The room a fitted frame takes in a view of the given size, in CSS
      pixels from the view's top left: inside the margin, below the
      controls. */
  export function fitRoom(vw: number, vh: number) {
    return {
      left: MARGIN,
      top: BAND,
      width: Math.max(0, vw - 2 * MARGIN),
      height: Math.max(0, vh - BAND - MARGIN),
    };
  }

  /** CSS pixels per image pixel at which `frame` fits a view of the given
      size. */
  function fitScale(frame: Box, vw: number, vh: number): number {
    const room = fitRoom(vw, vh);
    const fw = Math.max(1, frame.lrx - frame.ulx);
    const fh = Math.max(1, frame.lry - frame.uly);
    return Math.min(room.width / fw, room.height / fh);
  }

  /** The height of the fitted frame's top edge in the view at scale `k`:
      centred in the room. */
  function fitTop(frame: Box, vh: number, k: number): number {
    const room = fitRoom(0, vh);
    const fh = Math.max(1, frame.lry - frame.uly);
    return room.top + Math.max(0, (room.height - fh * k) / 2);
  }
</script>

<script lang="ts">
  import { zoomGestures } from "$lib/zoom-gestures.ts";
  import Icon from "./Icon.svelte";

  let {
    url,
    width,
    height,
    frame,
    mark,
    label,
    fitLabel,
    away = false,
    onfit,
    align = null,
  }: {
    /** The page image. */
    url: string;
    /** The page image's size in pixels, the unit of `frame` and `mark`. */
    width: number;
    height: number;
    frame: Box;
    mark?: Box;
    /** The view's accessible name. */
    label: string;
    /** The fit button's name and tooltip. */
    fitLabel: string;
    /** The host shows something other than its usual frame. */
    away?: boolean;
    /** The fit button was pressed. */
    onfit?: () => void;
    /** Image heights and the viewport y coordinates, in CSS pixels, they
        are lined up with while framed. */
    align?: { uly: number; lry: number; top: number; bottom: number } | null;
  } = $props();

  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 8;
  const ZOOM_STEP = 1.25;

  let view = $state<HTMLDivElement>();
  let vw = $state(0);
  let vh = $state(0);
  // The zoom relative to the fitted frame; 1 is the frame fitted.
  let zoom = $state(1);
  let framed = $state(true);
  const fw = $derived(Math.max(1, frame.lrx - frame.ulx));
  // CSS pixels per image pixel.
  const k = $derived(
    !vw || !vh
      ? 0
      : (align && align.bottom > align.top && align.lry > align.uly
          ? (align.bottom - align.top) / (align.lry - align.uly)
          : fitScale(frame, vw, vh)) * zoom,
  );
  // The drawing holds a page's height of room above and below the page, so
  // any part of it can be scrolled to any height in the view; the room
  // scales with the page, which keeps a pinch on the point under it.
  const top = (y: number) => (y + height) * k;

  // Scrolls the frame into place: lined up with `align`, or centred below
  // the controls, at a page edge as near as the page allows.
  function centre() {
    if (!view || !k) return;
    if (align) {
      view.scrollLeft = frame.ulx * k - MARGIN;
      view.scrollTop =
        top(align.uly) - (align.top - view.getBoundingClientRect().top);
    } else {
      view.scrollLeft = (frame.ulx + fw / 2) * k - vw / 2;
      view.scrollTop = top(frame.uly) - fitTop(frame, vh, k);
    }
    hold();
  }
  // The drawing point at the view's centre, in image pixels at the drawing's
  // scale 1, recorded on every scroll.
  let held: { x: number; y: number } | null = null;
  function hold() {
    if (view && k)
      held = {
        x: (view.scrollLeft + vw / 2) / k,
        y: (view.scrollTop + vh / 2) / k,
      };
  }
  let frameKey = "";
  $effect(() => {
    const key = `${url} ${frame.ulx} ${frame.uly} ${frame.lrx} ${frame.lry}`;
    if (key === frameKey) return;
    frameKey = key;
    zoom = 1;
    framed = true;
  });
  $effect(() => {
    void k;
    void vw;
    void vh;
    void frame;
    void align?.top;
    if (framed) centre();
    else if (held && view && k) {
      view.scrollLeft = held.x * k - vw / 2;
      view.scrollTop = held.y * k - vh / 2;
    }
  });
  // The viewer's own scrolling leaves the frame; the view's resizing and
  // the scroll positions it clamps do not.
  function leave() {
    if (framed) hold();
    framed = false;
  }
  function fit() {
    onfit?.();
    zoom = 1;
    framed = true;
    centre();
  }
  function zoomBy(factor: number) {
    leave();
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor));
  }

  // A mouse drag pans; touch pans by the browser's own scrolling.
  let pan = $state<{ x: number; y: number; left: number; top: number } | null>(
    null,
  );
  function down(e: PointerEvent) {
    if (e.pointerType !== "mouse" || e.button !== 0 || !view) return;
    e.preventDefault();
    view.setPointerCapture(e.pointerId);
    pan = {
      x: e.clientX,
      y: e.clientY,
      left: view.scrollLeft,
      top: view.scrollTop,
    };
  }
  function move(e: PointerEvent) {
    if (!pan || !view || (e.clientX === pan.x && e.clientY === pan.y)) return;
    leave();
    view.scrollLeft = pan.left - (e.clientX - pan.x);
    view.scrollTop = pan.top - (e.clientY - pan.y);
  }
  const up = () => (pan = null);
</script>

<div class="ffwrap">
  <div
    class="ffview"
    class:panning={pan !== null}
    role="img"
    aria-label={label}
    bind:this={view}
    bind:clientWidth={vw}
    bind:clientHeight={vh}
    onscroll={hold}
    onwheel={(e) => {
      if (!e.ctrlKey && !e.metaKey) leave();
    }}
    ontouchmove={leave}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    {@attach zoomGestures({
      get: () => zoom,
      set: (z) => {
        leave();
        zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
      },
      follow: true,
    })}
  >
    {#if k}
      <svg
        width={width * k}
        height={3 * height * k}
        viewBox={`0 ${-height} ${width} ${3 * height}`}
        aria-hidden="true"
      >
        <image href={url} {width} {height} />
        {#if mark}<rect
            class="ffmark"
            x={mark.ulx}
            y={mark.uly}
            width={mark.lrx - mark.ulx}
            height={mark.lry - mark.uly}
            vector-effect="non-scaling-stroke"
          />{/if}
      </svg>
    {/if}
  </div>
  <div class="fftools">
    <span class="tbtn-pair">
      <button
        type="button"
        class="tbtn tbtn-icon"
        aria-label="Zoom out"
        title="Zoom out"
        disabled={zoom <= ZOOM_MIN}
        onclick={() => zoomBy(1 / ZOOM_STEP)}
        ><Icon name="zoom-out" size={16} /></button
      >
      <button
        type="button"
        class="tbtn tbtn-icon"
        aria-label="Zoom in"
        title="Zoom in"
        disabled={zoom >= ZOOM_MAX}
        onclick={() => zoomBy(ZOOM_STEP)}
        ><Icon name="zoom-in" size={16} /></button
      >
    </span>
    <button
      type="button"
      class="tbtn tbtn-icon"
      class:on={framed && !away}
      aria-pressed={framed && !away}
      aria-label={fitLabel}
      title={fitLabel}
      onclick={fit}><Icon name="focus" size={16} /></button
    >
  </div>
</div>

<style>
  .ffwrap {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
  }
  /* A pinch zooms the page (zoomGestures), not the window. */
  .ffview {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    touch-action: pan-x pan-y;
    cursor: grab;
    scrollbar-width: none;
  }
  .ffview::-webkit-scrollbar {
    display: none;
  }
  .ffview.panning {
    cursor: grabbing;
  }
  .ffview > svg {
    display: block;
  }
  .ffmark {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
  }
  /* The zoom controls in the view's top band. 32px buttons with a 44px
     press through an invisible ::after. */
  .fftools {
    position: absolute;
    top: 6px;
    right: 6px;
    display: flex;
    gap: 6px;
  }
  .fftools .tbtn-icon {
    position: relative;
    box-sizing: border-box;
    min-width: 32px;
    min-height: 32px;
    justify-content: center;
    box-shadow: var(--shadow-sm);
  }
  .fftools .tbtn-icon::after {
    content: "";
    position: absolute;
    inset: -6px;
  }
</style>
