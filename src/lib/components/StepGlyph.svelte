<!--
  The glyph of what a task step marks, drawn as notation: a staff, a grand
  staff joined by a brace, a measure between two barlines, a list of staves,
  or staves joined by a bracket. Thin strokes in the colour passed as `tone`
  (currentColor by default); decorative.
-->
<script lang="ts">
  type Kind = "staff" | "grand" | "measure" | "staves" | "groups";
  let {
    kind,
    tone = "currentColor",
    size = 22,
  }: { kind: Kind; tone?: string; size?: number } = $props();
</script>

<svg
  class="stepglyph"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke={tone}
  stroke-width="1.6"
  stroke-linecap="round"
  aria-hidden="true"
  focusable="false"
>
  {#if kind === "staff"}
    <path d="M3 6h18M3 9h18M3 12h18M3 15h18M3 18h18" />
  {:else if kind === "grand"}
    <path d="M9 4h12M9 7h12M9 10h12M9 14h12M9 17h12M9 20h12" />
    <path d="M6 4c-2 0 0 7-2.5 8C6 13 4 20 6 20" stroke-width="1.8" />
  {:else if kind === "measure"}
    <path d="M2 6h20M2 10h20M2 14h20M2 18h20" />
    <path d="M5 6v12M19 6v12" stroke-width="2.4" />
  {:else if kind === "staves"}
    <path d="M3 4h18M3 7h18M3 10h18M3 14h18M3 17h18M3 20h18" />
    <path d="M6 2.5v9M6 12.5v9" stroke-width="2.2" />
  {:else}
    <path d="M9 4h12M9 7h12M9 10h12M9 14h12M9 17h12M9 20h12" />
    <path d="M7 3v18M7 3h2M7 21h2" stroke-width="2.4" />
  {/if}
</svg>

<style>
  .stepglyph {
    display: block;
    flex: none;
  }
</style>
