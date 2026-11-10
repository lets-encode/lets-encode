<!--
  A page viewer's paging: previous, the pages in view ("Pages 1–2 of 4"),
  next. A compact toolbar shows the numbers only, with the full label as the
  tooltip. The label keeps the width of its longest text, so the buttons do
  not move as it changes.
-->
<script lang="ts">
  import Icon from "./Icon.svelte";
  import { pagesLabelCh } from "$lib/page-spreads.ts";

  let {
    label,
    total,
    compact = false,
    atStart,
    atEnd,
    ongo,
  }: {
    /** The pages in view, e.g. "Pages 1–2 of 4". */
    label: string;
    /** The page count, for the label's width. */
    total: number;
    compact?: boolean;
    atStart: boolean;
    atEnd: boolean;
    /** Go one row of pages back (-1) or on (1). */
    ongo: (delta: -1 | 1) => void;
  } = $props();
</script>

<button
  type="button"
  class="tbtn tbtn-icon pgbtn"
  onclick={() => ongo(-1)}
  disabled={atStart}
  aria-label="Previous page"
  title="Previous page"><Icon name="chevron-left" /></button
>
<span
  class="pglabel"
  style={`min-width:${pagesLabelCh(total) - (compact ? "Pages ".length : 0)}ch`}
  title={compact ? label : undefined}
  >{compact ? label.replace(/^Pages? /, "") : label}</span
>
<button
  type="button"
  class="tbtn tbtn-icon pgbtn"
  onclick={() => ongo(1)}
  disabled={atEnd}
  aria-label="Next page"
  title="Next page"><Icon name="chevron-right" /></button
>
