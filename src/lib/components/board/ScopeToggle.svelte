<!--
  The board filter: every task, or only the claimable ones.
-->
<script lang="ts">
  import type { BoardScope } from "$lib/campaign-page/board-columns.ts";

  let { scope = $bindable() }: { scope: BoardScope } = $props();
</script>

<div class="seg" role="group" aria-label="Board filter">
  <button
    type="button"
    class:on={scope === "all"}
    aria-pressed={scope === "all"}
    onclick={() => (scope = "all")}>All tasks</button
  >
  <button
    type="button"
    class:on={scope === "open"}
    aria-pressed={scope === "open"}
    onclick={() => (scope = "open")}
    title="Only tasks with something to do right now: open encodings and free review slots."
    >Claimable</button
  >
</div>
