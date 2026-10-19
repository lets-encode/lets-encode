<!--
  A pre-task editor's draft save state as a bubble at the bottom centre of
  its pages: "Saving draft…" while a draft saves, "Draft saved" for SAVED_MS
  after, and a failed save until the next save. Placed right after the pages
  in their column: the anchor takes no height, and the bubble floats above
  the pages' bottom edge without moving anything. Where the side panel docks
  below the pages (DOCKED_QUERY in side-panels.ts) the bubble sits centred
  just above the panel's top edge, clear of its grip.
-->
<script lang="ts">
  import { fade } from "svelte/transition";
  import { MediaQuery } from "svelte/reactivity";
  import type { PreTaskSession } from "$lib/pre-task-session.svelte.ts";

  let { session }: { session: PreTaskSession } = $props();

  const SAVED_MS = 2500;
  let savedShown = $state(false);
  $effect(() => {
    if (session.draftState !== "saved") return;
    savedShown = true;
    const t = setTimeout(() => (savedShown = false), SAVED_MS);
    return () => clearTimeout(t);
  });
  const reduceMotion = new MediaQuery("(prefers-reduced-motion: reduce)");
  const draft = $derived(session.holds ? session.draftState : "");
</script>

<div class="draftanchor">
  <span class="vh" role="status">{draft === "saved" ? "Draft saved" : ""}</span>
  {#if draft === "saving"}
    <span class="chip chip-question bubble">Saving draft…</span>
  {:else if draft === "saved" && savedShown}
    <span
      class="chip bubble"
      out:fade={{ duration: reduceMotion.current ? 0 : 300 }}>Draft saved</span
    >
  {:else if draft && draft !== "saved"}
    <span class="chip chip-err bubble err" role="alert">{draft}</span>
  {/if}
</div>

<style>
  .draftanchor {
    flex: none;
    position: relative;
    height: 0;
    z-index: 6;
  }
  .bubble {
    position: absolute;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    padding: 5px 12px;
    font-size: 12px;
    white-space: nowrap;
    box-shadow: var(--shadow-sm);
    pointer-events: none;
  }
  /* A failed save's message can be long: it wraps within the pages. */
  .bubble.err {
    white-space: normal;
    width: max-content;
    max-width: min(420px, calc(100% - 32px));
    line-height: 1.35;
    text-align: center;
  }
  @media (orientation: portrait) and (max-width: 1100px) {
    .bubble {
      bottom: auto;
      top: 0;
      transform: translate(-50%, calc(-100% - 8px));
    }
  }
</style>
