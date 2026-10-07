<!--
  The drag bar on the side panel's edge: on its left edge beside the content,
  dragging left widens the panel; on its top edge when docked below the
  content, dragging up raises it. Focused, the arrow keys move it in 24px
  steps. The size is clamped to the viewport and persisted per browser when
  the drag or key press ends (side-panels.ts).
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
  }: {
    /** The separator's accessible name. */
    label: string;
    panel: SidePanelState;
    /** The panel is docked below the content: the bar drags its height. */
    docked?: boolean;
  } = $props();

  let resizing = $state(false);
  let start = 0;
  let startSize = 0;

  function begin(e: PointerEvent) {
    // Keeps the drag from starting a text selection in the panel.
    e.preventDefault();
    resizing = true;
    start = docked ? e.clientY : e.clientX;
    startSize = docked ? panel.height : panel.width;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (!resizing) return;
    if (docked)
      panel.height = clampPanelHeight(
        startSize + (start - e.clientY),
        window.innerHeight,
      );
    else
      panel.width = clampPanelWidth(
        startSize + (start - e.clientX),
        window.innerWidth,
      );
  }
  function end() {
    if (!resizing) return;
    resizing = false;
    writeSidePanel({ ...panel }, docked ? "height" : "width");
  }
  // The keyboard path: towards the content grows the panel.
  const STEP = 24;
  function key(e: KeyboardEvent) {
    const grow = docked
      ? { ArrowUp: STEP, ArrowDown: -STEP }
      : { ArrowLeft: STEP, ArrowRight: -STEP };
    const delta = grow[e.key as keyof typeof grow];
    if (delta === undefined) return;
    e.preventDefault();
    if (docked)
      panel.height = clampPanelHeight(panel.height + delta, window.innerHeight);
    else panel.width = clampPanelWidth(panel.width + delta, window.innerWidth);
    writeSidePanel({ ...panel }, docked ? "height" : "width");
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
  aria-valuenow={docked ? panel.height : panel.width}
  aria-valuemin={docked ? 120 : PANEL_MIN}
  aria-valuetext={`${docked ? panel.height : panel.width} pixels`}
  onkeydown={key}
  onpointerdown={begin}
  onpointermove={move}
  onpointerup={end}
  onpointercancel={end}
></div>

<style>
  /* The host row's gap spaces the bar from the content; the right margin
     mirrors it towards the panel. */
  .handle {
    flex: none;
    align-self: stretch;
    margin: 12px 14px 12px 0;
    width: 6px;
    border-radius: 3px;
    background: var(--line-input);
    opacity: 0.65;
    cursor: col-resize;
    touch-action: none;
    position: relative;
  }
  /* Docked: a grip centred on the panel's top edge, tall enough to touch. */
  .handle.docked {
    align-self: center;
    margin: 0;
    width: 64px;
    height: 20px;
    background: none;
    opacity: 1;
    cursor: row-resize;
  }
  .handle:hover,
  .handle.active {
    background: var(--accent);
    opacity: 0.8;
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
  .handle.docked::after {
    content: none;
  }
  .handle.docked::before {
    left: 14px;
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--line-input);
  }
  .handle.docked:hover::before,
  .handle.docked.active::before {
    background: var(--accent);
  }
</style>
