<!--
  The measure correction on a fixture skeleton with a blank page image: the
  toolbar and the pages beside the steps, the selection and the footer.
  Submit shows the pages it would hand over.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import ZoneDesk from "$lib/components/zones/ZoneDesk.svelte";
  import ZoneFooter from "$lib/components/zones/ZoneFooter.svelte";
  import ZoneLoupe from "$lib/components/zones/ZoneLoupe.svelte";
  import ZoneSelection from "$lib/components/zones/ZoneSelection.svelte";
  import ZoneSteps from "$lib/components/zones/ZoneSteps.svelte";
  import ZoneToolbar from "$lib/components/zones/ZoneToolbar.svelte";
  import ZoneViewerToolbar from "$lib/components/zones/ZoneViewerToolbar.svelte";
  import { parseFacsimileMei } from "$lib/mei-facsimile.ts";
  import type { OmrPipeline } from "$lib/omr-client.ts";
  import { Corrector } from "$lib/zones/corrector.svelte.ts";
  import type { CorrectorInput } from "$lib/zones/host.ts";
  import { blankPage, SKELETON } from "./fixtures.ts";

  let data = $state<CorrectorInput | null>(null);
  let submitted = $state("");

  const c = new Corrector({
    data: () => data,
    omr: () => false,
    naming: () => false,
    canEdit: () => true,
    runner: {
      busy: false,
      log: { step() {}, detail() {} },
      run: (work) => work(),
    },
    taskId: () => "fixture",
    services: () => null,
    layoutModel: { name: "fixture", version: "0" } as unknown as OmrPipeline,
  });
  const { steps, model, ed, view, sel, instruments, transcriber } = c;

  onMount(async () => {
    const input = {
      model: parseFacsimileMei(SKELETON),
      imageUrls: [await blankPage()],
      regions: [[]],
      instruments: null,
    };
    c.load(input, false);
    data = input;
  });
</script>

<svelte:window onpointerdown={c.closeViewOutside} onkeydown={c.keydown} />

{#if data}
  <div class="unit">
    <div class="main">
      <ZoneToolbar
        {view}
        bar={toolbar}
        step4={steps.step4}
        canEdit
        coarse={c.coarse}
        boxName={c.boxName}
        omr={false}
        bind:helpOpen={c.helpOpen}
        bind:viewOpen={c.viewOpen}
      />
      <ZoneDesk
        editor={ed}
        {model}
        {view}
        {sel}
        {instruments}
        tool={steps.tool}
        step4={steps.step4}
        canEdit
        coarse={c.coarse}
      />
    </div>

    {#snippet toolbar(narrow: boolean)}
      <ZoneViewerToolbar
        {narrow}
        editor={ed}
        {view}
        total={model.pages.length}
        canEdit
        coarse={c.coarse}
        boxName={c.boxName}
        step4={steps.step4}
        bind:helpOpen={c.helpOpen}
        bind:viewOpen={c.viewOpen}
      />
    {/snippet}

    <aside class="panel">
      <ZoneSteps
        {model}
        omr={false}
        naming={false}
        layoutStep={steps.layoutStep}
        instrumentCount={0}
        onstep={c.setLayoutStep}
      />
      <ZoneSelection
        editor={ed}
        {model}
        {sel}
        tool={steps.tool}
        step4={steps.step4}
        canEdit
        coarse={c.coarse}
        docked={view.docked}
        labelMax={20}
      />
      {#snippet status()}{/snippet}
      <ZoneFooter
        {status}
        {transcriber}
        omr={false}
        naming={false}
        layoutStep={steps.layoutStep}
        lastStep={steps.lastStep}
        step4={steps.step4}
        canEdit
        busy={false}
        submitBlock={c.submitBlock}
        onstep={c.setLayoutStep}
        onsubmit={() => (submitted = JSON.stringify(c.pageModels(), null, 2))}
      />
      {#if submitted}<pre class="submitted">{submitted}</pre>{/if}
    </aside>

    <ZoneLoupe editor={ed} {model} canvasW={view.canvasW} tool={steps.tool} />
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
  .main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 12px 16px 0;
    box-sizing: border-box;
    container-type: inline-size;
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
