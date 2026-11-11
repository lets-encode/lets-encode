<!--
  The measure correction's task tools in the side panel: the layout steps
  of an OMR-prepared piece with their counts, or the measure and section
  counts.
-->
<script lang="ts">
  import StepGlyph from "$lib/components/StepGlyph.svelte";
  import type { ZonePages } from "$lib/zones/zone-pages.svelte.ts";
  import type { LayoutStep } from "$lib/zones/layout-steps.svelte.ts";

  let {
    model,
    omr,
    naming,
    layoutStep,
    instrumentCount,
    onstep,
  }: {
    model: ZonePages;
    /** The task corrects an OMR layout, in steps. */
    omr: boolean;
    /** The layout task also names the instruments, in a fourth step. */
    naming: boolean;
    layoutStep: LayoutStep;
    /** How many instruments some staff box shows. */
    instrumentCount: number;
    onstep: (step: LayoutStep) => void;
  } = $props();

  const staffCount = $derived(model.staffCount);
  const grandstaffCount = $derived(model.grandstaffCount);
  const measureCount = $derived(model.measureCount);
  const movementCount = $derived(model.movementCount);
</script>

<div class="wtools">
  {#if omr}
    <div
      class="steps"
      role="group"
      aria-label="Steps"
      title={`The ${naming ? "four" : "three"} steps of the measure correction. Each step shows only its own boxes.`}
    >
      {#each [{ step: 1, glyph: "staff", tone: "var(--ink-staff)", long: "Staff boxes", short: "Staves", count: `${staffCount}`, n: staffCount }, { step: 2, glyph: "grand", tone: "var(--ink-grand)", long: "Grand staves", short: "Grand", count: `${grandstaffCount}`, n: grandstaffCount }, { step: 3, glyph: "measure", tone: "var(--ink-measure)", long: "Measures", short: "Measures", count: `${measureCount} · ${movementCount} section${movementCount === 1 ? "" : "s"}`, n: measureCount }, ...(naming ? [{ step: 4, glyph: "names", tone: "var(--ink)", long: "Instruments", short: "Instr.", count: `${instrumentCount}`, n: instrumentCount }] : [])] as s (s.step)}
        <button
          type="button"
          class="step"
          class:on={layoutStep === s.step}
          aria-pressed={layoutStep === s.step}
          onclick={() => onstep(s.step as LayoutStep)}
          aria-label={`${s.step} · ${s.long}, ${s.count}`}
          ><span class="stepno">{s.step}</span><StepGlyph
            kind={s.glyph as "staff" | "grand" | "measure" | "names"}
            tone={s.tone}
          /><span class="steplong">{s.long}</span><span class="stepshort"
            >{s.short}</span
          ><span class="stepn">{s.n}</span><span class="stepcount"
            >{s.count}</span
          ></button
        >
      {/each}
    </div>
  {:else}
    <span class="abcount"
      >{measureCount} measure{measureCount === 1 ? "" : "s"} · {movementCount}
      section{movementCount === 1 ? "" : "s"}</span
    >
  {/if}
</div>

<style>
  /* The task tools, in the side panel's tools section (SidePanel.svelte). */
  .wtools {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .abcount {
    font-size: 12.5px;
    color: var(--ink-soft);
    font-variant-numeric: tabular-nums;
  }
  @media (orientation: portrait) and (max-width: 1100px) {
    /* The steps fill one row. */
    .wtools {
      flex-direction: row;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .steps {
      flex: 1 1 200px;
    }
  }
</style>
