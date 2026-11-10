<!--
  The selected box's body and resize handles, in screen pixels over its page
  (BoxEditor): the body moves the box, the four edges and four corners resize
  it, and a handle pressed without dragging is picked up for the next press.
  Laid beside the page's SVG, in a container of the page's size. `children`
  adds controls inside the box, under the handles.

  --hit is a corner's target, --dot its visible dot (down to --dot-min on a
  thin box) and --edge an edge handle's thickness; edges show no mark, the
  corners take precedence. A touch screen gets 32px corner and 20px edge
  targets. Handles reach into the box by at most a quarter of its size on
  screen, so its middle stays the move target; the rest of each target lies
  outside the box, above and below up to `room`.
-->
<script module lang="ts">
  /** The handles: the four edges, then the four corners. */
  export const HANDLES = [
    { edges: "n", side: "top edge" },
    { edges: "s", side: "bottom edge" },
    { edges: "w", side: "left edge" },
    { edges: "e", side: "right edge" },
    { edges: "nw", side: "top-left corner" },
    { edges: "ne", side: "top-right corner" },
    { edges: "sw", side: "bottom-left corner" },
    { edges: "se", side: "bottom-right corner" },
  ];
</script>

<script lang="ts" generics="T, S">
  import type { Snippet } from "svelte";
  import type { BoxEditor } from "$lib/box-editor.svelte.ts";
  import type { Box } from "$lib/box-geometry.ts";

  let {
    editor,
    p,
    item,
    box,
    page,
    scale,
    name,
    color,
    touch = false,
    room,
    children,
  }: {
    editor: BoxEditor<T, S>;
    /** The page's index. */
    p: number;
    /** The box's item, as the editor knows it. */
    item: T;
    box: Box;
    /** The page's size in its own pixels. */
    page: { width: number; height: number };
    /** Screen pixels per page pixel. */
    scale: number;
    /** The box's name for the handles' accessible names. */
    name: string;
    /** The handles' line colour. */
    color: string;
    touch?: boolean;
    /** The free space above and below the box, in page pixels. */
    room?: { top: number; bottom: number };
    children?: Snippet;
  } = $props();

  const cursor = (edges: string) =>
    edges === "n" || edges === "s"
      ? "ns-resize"
      : edges === "e" || edges === "w"
        ? "ew-resize"
        : edges === "nw" || edges === "se"
          ? "nwse-resize"
          : "nesw-resize";
  const px = (v: number | undefined) =>
    v !== undefined && Number.isFinite(v) ? `${v * scale}px` : undefined;
</script>

<div
  class="sel"
  class:touch
  style:left={`${(box.ulx / page.width) * 100}%`}
  style:top={`${(box.uly / page.height) * 100}%`}
  style:width={`${((box.lrx - box.ulx) / page.width) * 100}%`}
  style:height={`${((box.lry - box.uly) / page.height) * 100}%`}
  style:--w={`${(box.lrx - box.ulx) * scale}px`}
  style:--h={`${(box.lry - box.uly) * scale}px`}
  style:--room-t={px(room?.top)}
  style:--room-b={px(room?.bottom)}
  style:--c={color}
>
  <div
    class="selbody"
    aria-hidden="true"
    onpointerdown={(e) => editor.boxDown(e, p, item)}
  ></div>
  {@render children?.()}
  {#each HANDLES as h (h.edges)}
    <div
      class="hd hd-{h.edges}"
      class:armed={editor.armed?.item === item &&
        editor.armed.edges === h.edges}
      style:cursor={cursor(h.edges)}
      role="button"
      tabindex={0}
      aria-label={`${name}: resize (${h.side})`}
      onpointerdown={(e) => editor.boxDown(e, p, item, h.edges)}
      onkeydown={(e) => {
        if (editor.edgeKeydown(e, p, item, h.edges)) e.stopPropagation();
      }}
    ></div>
  {/each}
</div>

<style>
  .sel {
    position: absolute;
    --hit: 24px;
    --dot: 10px;
    --dot-min: 6px;
    --edge: 16px;
    /* Corner and edge reach into the box. */
    --cx: min(calc(var(--hit) / 2), calc(var(--w) / 4));
    --cy: min(calc(var(--hit) / 2), calc(var(--h) / 4));
    --ex: min(calc(var(--edge) / 2), calc(var(--w) / 4));
    --ey: min(calc(var(--edge) / 2), calc(var(--h) / 4));
    /* Corner and edge reach above and below the box, up to the free space
       beside it (--room-t, --room-b). */
    --cout-t: min(calc(var(--hit) - var(--cy)), var(--room-t, 999px));
    --cout-b: min(calc(var(--hit) - var(--cy)), var(--room-b, 999px));
    --eout-t: min(calc(var(--edge) - var(--ey)), var(--room-t, 999px));
    --eout-b: min(calc(var(--edge) - var(--ey)), var(--room-b, 999px));
    pointer-events: none;
    z-index: 4;
  }
  .sel.touch {
    --hit: 32px;
    --dot: 12px;
    --dot-min: 8px;
    --edge: 20px;
  }
  .selbody,
  .hd {
    position: absolute;
    pointer-events: auto;
    touch-action: none;
  }
  .selbody {
    inset: 0;
    cursor: move;
  }
  .hd:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  /* The visible dot or bar, drawn by ::before. */
  .hd::before {
    content: "";
    position: absolute;
    box-sizing: border-box;
    background: #fff;
    border: 2px solid var(--c);
    box-shadow: 0 1px 3px rgba(31, 36, 51, 0.35);
  }
  .hd-nw,
  .hd-ne,
  .hd-sw,
  .hd-se {
    width: var(--hit);
    z-index: 1;
    --d: max(var(--dot-min), min(var(--dot), var(--w), var(--h)));
  }
  .hd-nw,
  .hd-sw {
    left: calc(var(--cx) - var(--hit));
  }
  .hd-ne,
  .hd-se {
    right: calc(var(--cx) - var(--hit));
  }
  .hd-nw,
  .hd-ne {
    top: calc(-1 * var(--cout-t));
    height: calc(var(--cout-t) + var(--cy));
  }
  .hd-sw,
  .hd-se {
    bottom: calc(-1 * var(--cout-b));
    height: calc(var(--cout-b) + var(--cy));
  }
  /* A picked-up corner (armed) fills with the line colour. */
  .hd.armed::before {
    background: var(--c);
    box-shadow:
      0 0 0 3px #fff,
      0 1px 4px rgba(31, 36, 51, 0.45);
  }
  /* Each dot sits on its corner of the box. */
  .hd-nw::before,
  .hd-ne::before,
  .hd-sw::before,
  .hd-se::before {
    width: var(--d);
    height: var(--d);
    border-radius: 50%;
  }
  .hd-nw::before,
  .hd-sw::before {
    right: calc(var(--cx) - var(--d) / 2);
  }
  .hd-ne::before,
  .hd-se::before {
    left: calc(var(--cx) - var(--d) / 2);
  }
  .hd-nw::before,
  .hd-ne::before {
    bottom: calc(var(--cy) - var(--d) / 2);
  }
  .hd-sw::before,
  .hd-se::before {
    top: calc(var(--cy) - var(--d) / 2);
  }
  /* The edges run between the corner targets. */
  .hd-n,
  .hd-s {
    left: var(--cx);
    right: var(--cx);
  }
  .hd-n {
    top: calc(-1 * var(--eout-t));
    height: calc(var(--eout-t) + var(--ey));
  }
  .hd-s {
    bottom: calc(-1 * var(--eout-b));
    height: calc(var(--eout-b) + var(--ey));
  }
  .hd-w,
  .hd-e {
    top: var(--cy);
    bottom: var(--cy);
    width: var(--edge);
  }
  .hd-w {
    left: calc(var(--ex) - var(--edge));
  }
  .hd-e {
    right: calc(var(--ex) - var(--edge));
  }
  .hd-n::before,
  .hd-s::before,
  .hd-w::before,
  .hd-e::before {
    display: none;
  }
</style>
