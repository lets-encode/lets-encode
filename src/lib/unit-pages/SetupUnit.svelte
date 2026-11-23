<!--
  The score setup on a fixture skeleton with a blank page image: the source's
  first measure and the preview beside the steps, the form and the footer.
  Submit shows the score definition it would hand over.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import SetupFooter from "$lib/components/setup/SetupFooter.svelte";
  import SetupForm from "$lib/components/setup/SetupForm.svelte";
  import SetupPreviewPane from "$lib/components/setup/SetupPreviewPane.svelte";
  import SetupSourcePane from "$lib/components/setup/SetupSourcePane.svelte";
  import SetupSteps from "$lib/components/setup/SetupSteps.svelte";
  import { parseFacsimileMei } from "$lib/mei-facsimile.ts";
  import type { SetupInput } from "$lib/setup/host.ts";
  import { SetupEditor } from "$lib/setup/setup-editor.svelte.ts";
  import { blankPage, SKELETON } from "./fixtures.ts";

  let data = $state<SetupInput | null>(null);
  let desk = $state<HTMLDivElement>();
  let split = $state(0.5);
  let submitted = $state("");

  const editor = new SetupEditor({
    data: () => data,
    canEdit: () => true,
    runner: {
      busy: false,
      log: { step() {}, detail() {} },
      run: (work) => work(),
    },
    taskId: () => "fixture",
    services: () => null,
    picking: () => false,
    pickStaff: () => {},
  });
  const { model, preview, marking, staffList, recognition } = editor;

  onMount(async () => {
    const input = {
      model: parseFacsimileMei(SKELETON),
      imageUrls: [await blankPage()],
      preparation: "measure-detection",
    };
    model.load(input);
    data = input;
  });
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape" && marking.markFrom !== null) marking.clearMark();
  }}
/>

{#if data}
  <div class="unit">
    <div class="desk" bind:this={desk}>
      {#if editor.firstMeasure && data.imageUrls[editor.shownPage]}
        <SetupSourcePane
          url={data.imageUrls[editor.shownPage]}
          page={data.model.pages[editor.shownPage]}
          shownPage={editor.shownPage}
          firstMeasure={editor.firstMeasure}
          anchorPage={editor.anchorPage}
          onfit={() => (editor.anchorPage = null)}
          align={preview.align}
          {desk}
          bind:split
          bind:facsW={preview.facsW}
          bind:facsH={preview.facsH}
        />
      {/if}
      <SetupPreviewPane
        {preview}
        meterValid={model.meterValid}
        groupsValid={model.groupsValid}
        markable={editor.markable}
        picking={false}
        lit={marking.lit}
        onpointerdown={(e) => marking.sheetDown(e)}
        onpointermove={(e) => marking.sheetMove(e)}
        onclick={(e) => marking.sheetClick(e)}
      />
    </div>
    <aside class="panel">
      <SetupSteps
        step={editor.step}
        staves={model.staves.length}
        groups={model.groups.length}
        ongo={editor.goStep}
      />
      <SetupForm
        {model}
        {staffList}
        {marking}
        {preview}
        canEdit
        hasNotation={false}
        docked={false}
        step={editor.step}
        ongo={editor.goStep}
        markable={editor.markable}
        compact={false}
        tapWord="Click"
      />
      {#snippet status()}{/snippet}
      <SetupFooter
        {status}
        {model}
        {recognition}
        canEdit
        busy={false}
        checking={false}
        step={editor.step}
        ongo={editor.goStep}
        onsubmit={() => (submitted = JSON.stringify(model.scoreDef, null, 2))}
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
    background: var(--desk);
  }
  .desk {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    padding: 12px 16px;
    box-sizing: border-box;
    overflow: hidden;
  }
  .panel {
    width: 380px;
    padding: 12px 16px 12px 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .submitted {
    font-size: 12px;
  }
</style>
