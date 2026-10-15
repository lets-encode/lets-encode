<!--
  A facsimile page in a scrolling view that opens framed on one region of it
  (`frame`, in the page image's pixels), fitted whole into the view, with a
  second region (`mark`) outlined. Scrolling or a mouse drag pans, a pinch or
  Ctrl/Cmd + scroll zooms (zoomGestures); once moved away, a fit button
  brings the frame back. While framed, the view keeps the frame fitted as it
  resizes; a new frame is fitted afresh. A host showing something other than
  its usual frame sets `away`: the fit button then shows and calls `onfit`.
  Given `align`, the frame is not fitted but lined up: scaled so its top and
  bottom edges meet the two given heights on the screen, its left edge at the
  view's left.
-->
<script lang="ts">
  import { zoomGestures } from "$lib/zoom-gestures.ts";
  import FitIcon from "./FitIcon.svelte";

  type Box = { ulx: number; uly: number; lrx: number; lry: number };

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
    /** Viewport y coordinates, in CSS pixels, the frame's top and bottom
        edges are lined up with while framed. */
    align?: { top: number; bottom: number } | null;
  } = $props();

  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 8;
  /** Room left around the fitted frame, in CSS pixels. */
  const MARGIN = 6;

  let view = $state<HTMLDivElement>();
  let vw = $state(0);
  let vh = $state(0);
  // The zoom relative to the fitted frame; 1 is the frame fitted.
  let zoom = $state(1);
  let framed = $state(true);
  const fw = $derived(Math.max(1, frame.lrx - frame.ulx));
  const fh = $derived(Math.max(1, frame.lry - frame.uly));
  // CSS pixels per image pixel.
  const k = $derived(
    !vw || !vh
      ? 0
      : (align && align.bottom > align.top
          ? (align.bottom - align.top) / fh
          : Math.min((vw - 2 * MARGIN) / fw, (vh - 2 * MARGIN) / fh)) * zoom,
  );
  // The drawing holds a page's height of room above and below the page, so
  // any part of it can be scrolled to any height in the view; the room
  // scales with the page, which keeps a pinch on the point under it.
  const top = (y: number) => (y + height) * k;

  // Scrolls the frame into place: lined up with `align`, or centred, at a
  // page edge as near as the page allows.
  function centre() {
    if (!view || !k) return;
    if (align) {
      view.scrollLeft = frame.ulx * k;
      view.scrollTop =
        top(frame.uly) - (align.top - view.getBoundingClientRect().top);
      return;
    }
    view.scrollLeft = (frame.ulx + fw / 2) * k - vw / 2;
    view.scrollTop = top(frame.uly + fh / 2) - vh / 2;
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
    void frame;
    void align?.top;
    if (framed) centre();
  });
  // The viewer's own scrolling leaves the frame; the view's resizing and
  // the scroll positions it clamps do not.
  const leave = () => (framed = false);
  function fit() {
    onfit?.();
    zoom = 1;
    framed = true;
    centre();
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
    onwheel={leave}
    ontouchmove={leave}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    {@attach zoomGestures({
      get: () => zoom,
      set: (z) => {
        zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
        framed = false;
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
  {#if !framed || away}
    <button
      type="button"
      class="tbtn tbtn-icon fffit"
      aria-label={fitLabel}
      title={fitLabel}
      onclick={fit}><FitIcon kind="page" /></button
    >
  {/if}
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
  /* 32px with a 44px press through an invisible ::after. */
  .fffit {
    position: absolute;
    top: 8px;
    right: 8px;
    box-sizing: border-box;
    min-width: 32px;
    min-height: 32px;
    justify-content: center;
    box-shadow: var(--shadow-sm);
  }
  .fffit::after {
    content: "";
    position: absolute;
    inset: -6px;
  }
</style>
