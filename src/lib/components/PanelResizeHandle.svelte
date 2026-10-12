<!--
  The drag bar on the side panel's edge: on its left edge beside the content,
  dragging left widens the panel; on its top edge when docked below the
  content, dragging moves the panel's top with the pointer and the host snaps
  it to the nearest of its heights on release; a tap asks for the next one. Focused, the arrow keys move it
  in 24px steps beside the content and one snap height docked. Size changes
  are applied once per animation frame. The width is clamped to the viewport
  and persisted per browser when the drag or key press ends (side-panels.ts).
-->
<script lang="ts">
  import {
    PANEL_MIN,
    clampPanelHeight,
    clampPanelWidth,
    writeSidePanel,
    type SidePanelState,
  } from "$lib/side-panels.ts";

  let {
    label,
    panel = $bindable(),
    docked = false,
    drag = $bindable(null),
    dockLevel = 0,
    dockMin = 0,
    dockLevels = 0,
    dockText = "",
    ondockend,
    ondockstep,
    ondocktap,
  }: {
    /** The separator's accessible name. */
    label: string;
    panel: SidePanelState;
    /** The panel is docked below the content: the bar drags its height. */
    docked?: boolean;
    /** Docked: the panel's height in pixels while a drag is under way. */
    drag?: number | null;
    /** Docked: the panel's current height step, 0-based, the lowest step it
        can take, and the count of steps. */
    dockLevel?: number;
    dockMin?: number;
    dockLevels?: number;
    /** Docked: the current height step as read out. */
    dockText?: string;
    /** Docked: the drag ended at this height. */
    ondockend?: (height: number) => void;
    /** Docked: a key press asks for the next height up (1) or down (-1). */
    ondockstep?: (dir: 1 | -1) => void;
    /** Docked: the bar was tapped without dragging. */
    ondocktap?: () => void;
  } = $props();

  let resizing = $state(false);
  // The mode the drag started in, held if the window turns mid-drag.
  let dragDocked = false;
  // A press that stays within TAP_SLOP pixels is a tap, not a drag.
  const TAP_SLOP = 6;
  let moved = false;
  let start = 0;
  let startSize = 0;
  let next = 0;
  let frame = 0;

  function apply() {
    frame = 0;
    if (dragDocked) drag = next;
    else panel.width = next;
  }

  function begin(e: PointerEvent) {
    // Keeps the drag from starting a text selection in the panel.
    e.preventDefault();
    resizing = true;
    dragDocked = docked;
    moved = false;
    const target = e.currentTarget as HTMLElement;
    start = dragDocked ? e.clientY : e.clientX;
    // Docked, the drag starts from the rendered height, whatever the panel's
    // current height step.
    startSize = dragDocked
      ? (target.parentElement?.getBoundingClientRect().height ?? 0)
      : panel.width;
    next = startSize;
    target.setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (!resizing) return;
    if (Math.abs((dragDocked ? e.clientY : e.clientX) - start) > TAP_SLOP)
      moved = true;
    if (!moved) return;
    next = dragDocked
      ? clampPanelHeight(startSize + (start - e.clientY), window.innerHeight)
      : clampPanelWidth(startSize + (start - e.clientX), window.innerWidth);
    if (!frame) frame = requestAnimationFrame(apply);
  }
  function end() {
    if (!resizing) return;
    resizing = false;
    cancelAnimationFrame(frame);
    frame = 0;
    if (dragDocked) {
      if (moved) ondockend?.(next);
      else ondocktap?.();
    } else if (moved) {
      panel.width = next;
      writeSidePanel({ ...panel }, "width");
    }
    drag = null;
  }
  // The keyboard path: towards the content grows the panel.
  const STEP = 24;
  function key(e: KeyboardEvent) {
    if (docked) {
      const dir = ({ ArrowUp: 1, ArrowDown: -1 } as const)[
        e.key as "ArrowUp" | "ArrowDown"
      ];
      if (dir === undefined) return;
      e.preventDefault();
      ondockstep?.(dir);
      return;
    }
    const delta = ({ ArrowLeft: STEP, ArrowRight: -STEP } as const)[
      e.key as "ArrowLeft" | "ArrowRight"
    ];
    if (delta === undefined) return;
    e.preventDefault();
    panel.width = clampPanelWidth(panel.width + delta, window.innerWidth);
    writeSidePanel({ ...panel }, "width");
  }
</script>

<!-- A focusable separator is the ARIA window-splitter pattern, an
     interactive widget; the lint counts every separator as static. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="handle"
  class:docked
  class:active={resizing}
  role="separator"
  tabindex="0"
  aria-orientation={docked ? "horizontal" : "vertical"}
  aria-label={label}
  aria-valuenow={docked ? dockLevel : panel.width}
  aria-valuemin={docked ? dockMin : PANEL_MIN}
  aria-valuemax={docked
    ? dockLevels - 1
    : clampPanelWidth(Infinity, window.innerWidth)}
  aria-valuetext={docked ? dockText : `${panel.width} pixels`}
  onkeydown={key}
  onpointerdown={begin}
  onpointermove={move}
  onpointerup={end}
  onpointercancel={end}
></div>

<style>
  /* The host row's gap spaces the bar from the content; the right margin
     mirrors it towards the panel. The transparent border widens the hit
     area to 24px around the 6px bar. */
  .handle {
    flex: none;
    align-self: stretch;
    margin: 12px 5px 12px -9px;
    width: 6px;
    border: 9px solid transparent;
    background-clip: padding-box;
    border-radius: 12px;
    background-color: var(--line-input);
    opacity: 0.65;
    cursor: col-resize;
    touch-action: none;
    position: relative;
  }
  /* Docked: a grip centred on the panel's top edge; its ::after extends the
     hit area to 44px tall. */
  .handle.docked {
    align-self: center;
    margin: 0;
    width: 120px;
    height: 16px;
    border: none;
    background: none;
    opacity: 1;
    cursor: row-resize;
  }
  .handle.active {
    background-color: var(--accent);
    opacity: 0.8;
  }
  @media (hover: hover) {
    .handle:hover {
      background-color: var(--accent);
      opacity: 0.8;
    }
    .handle.docked:hover::before {
      background: var(--accent);
    }
  }
  .handle.docked:hover,
  .handle.docked.active {
    background: none;
  }
  .handle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  /* The embossed double line marking the bar as draggable. */
  .handle::before,
  .handle::after {
    content: "";
    position: absolute;
    top: 50%;
    width: 1px;
    height: 26px;
    transform: translateY(-50%);
    border-radius: 1px;
    background: var(--card);
  }
  .handle::before {
    left: 1.5px;
  }
  .handle::after {
    right: 1.5px;
  }
  .handle.docked::before {
    left: 50%;
    width: 40px;
    height: 5px;
    transform: translate(-50%, -50%);
    border-radius: 3px;
    background: var(--line-strong);
  }
  .handle.docked::after {
    inset: -24px -40px -4px;
    width: auto;
    height: auto;
    transform: none;
    background: none;
  }
  .handle.docked.active::before {
    background: var(--accent);
  }
</style>
