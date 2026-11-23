<!-- The score viewer on a fixture score with a blank page image. -->
<script lang="ts">
  import ScorePreview from "$lib/components/ScorePreview.svelte";
  import { blankPage, SKELETON } from "./fixtures.ts";

  let selected = $state<string | null>(null);
</script>

<div class="unit">
  <p class="muted">Selected measure: {selected ?? "none"}</p>
  {#await blankPage() then image}
    <ScorePreview
      score={{ name: "fixture", document: SKELETON, pages: [image] }}
      initialPane="both"
      onmeasureselect={(label) => (selected = label)}
    />
  {/await}
</div>

<style>
  .unit {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 12px 16px 0;
  }
</style>
