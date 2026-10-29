<!--
  Zoom for a pane of pages, in percent. The pages' grid is laid out at this
  share of the pane's width, so above 100% it grows past the pane and scrolls.

  A fit keeps the zoom at a computed value until the slider is moved: the width
  fit is 100%; the page fit is the zoom the pane's owner computes with
  `fitPageZoom`, at which a whole page is visible top to bottom.
-->
<script module lang="ts">
  /** The zoom's range, in percent. */
  export const ZOOM_MIN = 20;
  export const ZOOM_MAX = 400;

  /**
   * The fit a zoom is close to — within 8% of the width fit (100%) or of the
   * page fit — or null. Lets a pinch that ends near a fit settle on it.
   */
  export function nearFit(
    zoom: number,
    fitPage?: number,
  ): "width" | "page" | null {
    const near = (target: number) => Math.abs(zoom / target - 1) <= 0.08;
    if (fitPage !== undefined && near(fitPage)) return "page";
    return near(100) ? "width" : null;
  }

  /**
   * The zoom, in percent, at which the tallest page of a material grid fits the
   * body top to bottom. The grid's padding, gap and the height a tile needs
   * beyond its image (caption and border) are the ones ui.css and the page
   * figures give them. Capped at the width fit, so a page never grows past the
   * body's width.
   */
  export function fitPageZoom(
    bodyW: number,
    bodyH: number,
    perRow: number,
    aspects: number[],
  ): number {
    const PAD = 16;
    const GAP = 14;
    const TILE_EXTRA = 20;
    const aspect = Math.max(...aspects.filter((a) => a > 0));
    if (!bodyW || !bodyH || !isFinite(aspect)) return 100;
    const tileW = (bodyH - 2 * PAD - TILE_EXTRA) / aspect;
    const gridW = tileW * perRow + GAP * (perRow - 1) + 2 * PAD;
    return Math.min(100, Math.max(1, Math.floor((gridW / bodyW) * 100)));
  }
</script>

<script lang="ts">
  import FitIcon from "./FitIcon.svelte";
  import Icon from "./Icon.svelte";

  let {
    value = $bindable(),
    fitPage,
    fit = $bindable(null),
  }: {
    /** Percent, between LEAST and MOST. */
    value: number;
    /** The page-fit zoom in percent. Without it there is no page fit. */
    fitPage?: number;
    /** The fit in force, if any. */
    fit?: "width" | "page" | null;
  } = $props();

  $effect(() => {
    if (fit === "width") value = 100;
    else if (fit === "page" && fitPage !== undefined)
      value = Math.max(LEAST, fitPage);
  });

  // The slider runs on a log scale: equal drags multiply the zoom equally,
  // so the low end moves in fine steps and the high end in coarse ones.
  const LEAST = ZOOM_MIN;
  const MOST = ZOOM_MAX;
  const STOPS = 100;
  // One press of zoom out or in: a tenth of the slider, about a third larger
  // or smaller.
  const STEP = 10;
  const pos = $derived(
    Math.round((Math.log(value / LEAST) / Math.log(MOST / LEAST)) * STOPS),
  );
  const setPos = (p: number) =>
    (value = Math.round(LEAST * (MOST / LEAST) ** (p / STOPS)));
  // The buttons that stand in for the slider on touch and in narrow panes.
  function step(dir: 1 | -1) {
    setPos(Math.min(STOPS, Math.max(0, pos + dir * STEP)));
    fit = null;
  }
</script>

<span class="zoomctl">
  <button
    type="button"
    class="tbtn tbtn-icon zstep"
    aria-label="Zoom out"
    title="Zoom out"
    disabled={value <= LEAST}
    onclick={() => step(-1)}><Icon name="zoom-out" /></button
  >
  <input
    class="zoomslider"
    type="range"
    aria-label="Zoom"
    aria-valuetext={`${value}%`}
    min={0}
    max={STOPS}
    step={1}
    value={pos}
    oninput={(e) => {
      setPos(Number((e.target as HTMLInputElement).value));
      fit = null;
    }}
  />
  <span class="zval">{value}%</span>
  <button
    type="button"
    class="tbtn tbtn-icon zstep"
    aria-label="Zoom in"
    title="Zoom in"
    disabled={value >= MOST}
    onclick={() => step(1)}><Icon name="zoom-in" /></button
  >
  <button
    type="button"
    class="tbtn tbtn-icon fit-width"
    class:on={fit === "width"}
    aria-pressed={fit === "width"}
    onclick={() => (fit = "width")}
    aria-label="Fit the page width"
    title="Fit the page width"><FitIcon kind="width" /></button
  >
  {#if fitPage !== undefined}
    <button
      type="button"
      class="tbtn tbtn-icon fit-page"
      class:on={fit === "page"}
      aria-pressed={fit === "page"}
      onclick={() => (fit = "page")}
      aria-label="Fit the whole page"
      title="Fit the whole page, top to bottom"><FitIcon kind="page" /></button
    >
  {/if}
</span>

<style>
  /* A mouse gets the slider, touch zoom out and in either side of the
     readout. Narrower panes drop the readout, and below 440px the slider
     gives way to the buttons. */
  .zoomctl {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .zstep {
    display: none;
  }
  @media (pointer: coarse) {
    .zoomctl .zoomslider {
      display: none;
    }
    .zstep {
      display: inline-flex;
    }
  }
  @container material (max-width: 639px) {
    .zoomctl .zoomslider {
      width: 70px;
    }
    .zval {
      display: none;
    }
  }
  @container material (max-width: 439px) {
    .zoomctl .zoomslider {
      display: none;
    }
    .zstep {
      display: inline-flex;
    }
  }
</style>
