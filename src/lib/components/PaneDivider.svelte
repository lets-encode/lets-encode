<!--
  The divider between two panes (.pane-grip, ui.css), as the ARIA window
  splitter: a drag moves it, once per animation frame, and focused, the arrow
  keys move it by `step`. `vertical` divides side by side, so it moves with
  the left and right keys; across, with up and down. `value` is the host's
  measure of the split, a fraction (`fraction`) or pixels, clamped to `min`
  and `max`; `at` turns a pointer position into it. `reverse` is for a
  value that grows as the divider moves left or up, such as the width of a
  pane on the right.
-->
<script lang="ts">
  let {
    label,
    vertical = true,
    value = $bindable(),
    min,
    max,
    step,
    fraction = false,
    reverse = false,
    at,
    class: extra = "",
  }: {
    /** The divider's accessible name. */
    label: string;
    vertical?: boolean;
    value: number;
    min: number;
    max: number;
    /** One arrow key's move. */
    step: number;
    /** The value is a fraction, read out as a percentage. */
    fraction?: boolean;
    reverse?: boolean;
    /** The value for a pointer position. */
    at: (e: PointerEvent) => number;
    class?: string;
  } = $props();

  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const shown = (v: number) => Math.round(fraction ? v * 100 : v);

  let dragging = false;
  let frame = 0;
  function down(e: PointerEvent) {
    // Keeps the drag from starting a text selection.
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging = true;
  }
  function move(e: PointerEvent) {
    if (!dragging) return;
    const to = clamp(at(e));
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => (value = to));
  }
  function up() {
    dragging = false;
  }
  function key(e: KeyboardEvent) {
    const back = vertical ? "ArrowLeft" : "ArrowUp";
    const on = vertical ? "ArrowRight" : "ArrowDown";
    if (e.key !== back && e.key !== on) return;
    e.preventDefault();
    const dir = (e.key === on ? 1 : -1) * (reverse ? -1 : 1);
    value = clamp(value + dir * step);
  }
</script>

<!-- A focusable separator is the ARIA window-splitter pattern, an
     interactive widget; the lint counts every separator as static. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="pane-grip {extra}"
  role="separator"
  tabindex="0"
  aria-label={label}
  aria-orientation={vertical ? "vertical" : "horizontal"}
  aria-valuenow={shown(value)}
  aria-valuemin={shown(min)}
  aria-valuemax={shown(max)}
  aria-valuetext={fraction ? `${shown(value)}%` : `${shown(value)} pixels`}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  onkeydown={key}
></div>
