<!--
  How a score viewer groups its pages: one page or two side by side, and for
  two whether page 1 is a right-hand page, so a spread pairs 2–3, 4–5, … the
  way the score opens.
-->
<script lang="ts">
  import Icon from "./Icon.svelte";

  let {
    view,
    firstOnRight,
    onview,
    onfirstonright,
    class: extra = "",
  }: {
    view: "single" | "double";
    firstOnRight: boolean;
    onview: (view: "single" | "double") => void;
    onfirstonright: (on: boolean) => void;
    /** Classes the viewer adds for its own styles. */
    class?: string;
  } = $props();
</script>

<div class="seg {extra}" title="How many pages are shown side by side">
  <button
    type="button"
    class:on={view === "single"}
    aria-pressed={view === "single"}
    onclick={() => onview("single")}
    ><Icon name="page-one" /><span class="lbl">1 page</span></button
  >
  <button
    type="button"
    class:on={view === "double"}
    aria-pressed={view === "double"}
    onclick={() => onview("double")}
    ><Icon name="page-two" /><span class="lbl">2 pages</span></button
  >
</div>
{#if view === "double"}
  <button
    type="button"
    class="tbtn"
    class:on={firstOnRight}
    aria-pressed={firstOnRight}
    onclick={() => onfirstonright(!firstOnRight)}
    title="Whether page 1 is a right-hand page, so a spread pairs 2–3, 4–5, … the way the score opens"
    >Page 1 right</button
  >
{/if}
