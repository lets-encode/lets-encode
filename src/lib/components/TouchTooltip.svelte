<!--
  The touch equivalent of a hover tooltip: holding a finger on an element
  with a `title` for half a second shows that title in a bubble above it
  (below it near the window's top). The press that showed the bubble does not
  also click the element. The bubble closes on the next touch, on scroll and
  after six seconds. Mouse and pen input keep the browser's own tooltips.
  Assistive technology reads the `title` itself, so the bubble is hidden from
  it. Mounted once in the root layout.
-->
<script lang="ts">
  import { onMount } from "svelte";

  const HOLD_MS = 500;
  const SLOP = 10;
  const SHOW_MS = 6000;
  const MARGIN = 8;

  let tip = $state<{ text: string; x: number; y: number; below: boolean }>();
  let bubble = $state<HTMLDivElement>();
  let left = $state(0);

  onMount(() => {
    let hold = 0;
    let hide = 0;
    let startX = 0;
    let startY = 0;
    // The press showed a bubble: its click and context menu are swallowed.
    let swallow = false;

    const close = () => {
      clearTimeout(hide);
      tip = undefined;
    };
    const cancel = () => clearTimeout(hold);

    function down(e: PointerEvent) {
      cancel();
      close();
      swallow = false;
      // A second finger (a pinch) and presses in text fields, where a long
      // press places the caret, show nothing.
      if (e.pointerType !== "touch" || !e.isPrimary) return;
      const target = e.target as Element | null;
      if (target?.closest?.("input, textarea, select, [contenteditable]"))
        return;
      const el = target?.closest?.("[title]");
      const text = el?.getAttribute("title")?.trim();
      if (!el || !text) return;
      startX = e.clientX;
      startY = e.clientY;
      hold = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        const below = r.top < 64;
        tip = {
          text,
          x: r.left + r.width / 2,
          y: below ? r.bottom : r.top,
          below,
        };
        swallow = true;
        hide = window.setTimeout(close, SHOW_MS);
      }, HOLD_MS);
    }
    function move(e: PointerEvent) {
      if (!e.isPrimary) return;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > SLOP) cancel();
    }
    function swallowEvent(e: Event) {
      if (!swallow) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "click") swallow = false;
    }

    const opts = { capture: true, passive: true } as const;
    window.addEventListener("pointerdown", down, opts);
    window.addEventListener("pointermove", move, opts);
    window.addEventListener("pointerup", cancel, opts);
    window.addEventListener("pointercancel", cancel, opts);
    window.addEventListener("scroll", close, opts);
    window.addEventListener("click", swallowEvent, true);
    window.addEventListener("contextmenu", swallowEvent, true);
    return () => {
      cancel();
      close();
      window.removeEventListener("pointerdown", down, opts);
      window.removeEventListener("pointermove", move, opts);
      window.removeEventListener("pointerup", cancel, opts);
      window.removeEventListener("pointercancel", cancel, opts);
      window.removeEventListener("scroll", close, opts);
      window.removeEventListener("click", swallowEvent, true);
      window.removeEventListener("contextmenu", swallowEvent, true);
    };
  });

  // Centred on the element, held inside the window.
  $effect(() => {
    if (!tip || !bubble) return;
    const w = bubble.offsetWidth;
    left = Math.min(
      Math.max(tip.x - w / 2, MARGIN),
      window.innerWidth - w - MARGIN,
    );
  });
</script>

{#if tip}
  <div
    class="touchtip"
    class:below={tip.below}
    aria-hidden="true"
    bind:this={bubble}
    style:left="{left}px"
    style:top="{tip.y}px"
  >
    {tip.text}
  </div>
{/if}

<style>
  .touchtip {
    position: fixed;
    z-index: 1000;
    max-width: min(320px, calc(100vw - 16px));
    transform: translateY(calc(-100% - 8px));
    padding: 8px 11px;
    border-radius: 8px;
    background: var(--ink);
    color: var(--card);
    font-size: 13px;
    line-height: 1.4;
    box-shadow: var(--shadow-md);
    pointer-events: none;
  }
  .touchtip.below {
    transform: translateY(8px);
  }
</style>
