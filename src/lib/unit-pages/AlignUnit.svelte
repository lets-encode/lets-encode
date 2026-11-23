<!--
  The encoding alignment on a fixture skeleton and a fixture file: the score
  viewer on the merged score beside the alignment's steps, panel and footer.
  Submit shows the choices it would hand over.
-->
<script lang="ts">
  import { AlignEditor } from "$lib/align/align-editor.svelte.ts";
  import AlignFooter from "$lib/components/align/AlignFooter.svelte";
  import AlignSelection from "$lib/components/align/AlignSelection.svelte";
  import AlignSteps from "$lib/components/align/AlignSteps.svelte";
  import ScorePreview from "$lib/components/ScorePreview.svelte";
  import type { MeasureAnchor } from "$lib/editor-units.ts";
  import { blankPage, SKELETON, UPLOAD } from "./fixtures.ts";

  const editor = new AlignEditor({
    source: () => ({
      current: SKELETON,
      corrected: null,
      upload: UPLOAD,
      preparation: "measure-detection",
    }),
    canEdit: () => true,
  });
  const aligned = $derived(editor.aligned);

  let preview = $state<ReturnType<typeof ScorePreview>>();
  let anchor = $state<MeasureAnchor | null>(null);
  let submitted = $state("");

  function showProblem(measures: number[]) {
    if (!aligned || !measures.length) return;
    const label = (i: number) => aligned.layout[i].label;
    const last = measures.findLast((m, i) => m === measures[0] + i)!;
    const page = preview?.pageOfMeasure(label(measures[0]), measures[0]) ?? -1;
    anchor = {
      page: page + 1,
      m1: parseInt(label(measures[0]), 10) || 0,
      m2: parseInt(label(last), 10) || 0,
    };
    if (page >= 0) preview?.showPage(page);
  }
</script>

{#if aligned}
  <div class="unit">
    <div class="score">
      {#await blankPage() then image}
        <ScorePreview
          bind:this={preview}
          score={{
            name: "fixture",
            document: aligned.merged.mei,
            pages: [image],
          }}
          {anchor}
          initialPane="both"
          onmeasureselect={(label, index) => {
            editor.selectedMeasure = label;
            editor.selectedAt = index;
          }}
        />
      {/await}
    </div>
    <aside class="panel">
      <AlignSteps
        step={editor.step}
        {aligned}
        used={editor.usedStaves.length}
        ongo={(step) => (editor.stepChoice = step)}
      />
      <AlignSelection
        {editor}
        canEdit
        fixed={false}
        {preview}
        onshowproblem={showProblem}
      />
      {#snippet status()}{/snippet}
      <AlignFooter
        {aligned}
        canEdit
        busy={false}
        {status}
        onsubmit={() => (submitted = JSON.stringify(editor.edits(), null, 2))}
      />
      {#if submitted}<pre class="submitted">{submitted}</pre>{/if}
    </aside>
  </div>
{/if}

<style>
  .unit {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 16px;
    padding: 12px 16px 0;
  }
  .score {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .panel {
    width: 380px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .submitted {
    font-size: 12px;
  }
</style>
