<!--
  The measure correction's action at the side panel's bottom: why Submit is
  not available yet, the transcription's state in the instruments step, the
  claim or the draft state and give back, then the next step, the other
  systems after the first system's instruments, or the submission.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { LayoutStep } from "$lib/zones/layout-steps.svelte.ts";
  import type { StaffTranscription } from "$lib/zones/staff-transcription.svelte.ts";
  import WorkspaceFooter from "$lib/components/WorkspaceFooter.svelte";

  let {
    status,
    transcriber,
    omr,
    naming,
    layoutStep,
    lastStep,
    step4,
    canEdit,
    busy,
    submitBlock,
    onstep,
    onsubmit,
    systems = null,
  }: {
    /** The host's status: the claim or the draft state and give back. */
    status: Snippet;
    transcriber: StaffTranscription;
    /** The task corrects an OMR layout, in steps. */
    omr: boolean;
    /** The layout task also names the instruments, in a fourth step. */
    naming: boolean;
    layoutStep: LayoutStep;
    lastStep: LayoutStep;
    /** The instruments step is in view. */
    step4: boolean;
    canEdit: boolean;
    busy: boolean;
    /** Why the task cannot be submitted yet; null when it can. */
    submitBlock: string | null;
    onstep: (step: LayoutStep) => void;
    onsubmit: () => void;
    /** The instruments step's parts, for an editor: whether the other systems are open, why they cannot be opened yet (null when they can), and the switch between them. */
    systems?: {
      fixed: boolean;
      block: string | null;
      onfix: (fixed: boolean) => void;
    } | null;
  } = $props();

  const transcription = $derived(transcriber.transcription);
  // The first system's instruments are open: the step's button opens the
  // other systems.
  const toOthers = $derived(
    naming && layoutStep === 4 && systems && !systems.fixed ? systems : null,
  );
</script>

<!-- The button to the next step of a layout task, for the editor and the
     reviewer. -->
{#snippet nextStep()}
  {#if layoutStep === 1}
    <button
      type="button"
      class="btn"
      onclick={() => onstep(2)}
      title={`Go on to step 2: the grand staves, one box around the staves one performer plays together.${canEdit ? ` Submission is in step ${lastStep}.` : ""}`}
    >
      Next: grand staves
    </button>
  {:else if layoutStep === 2}
    <button
      type="button"
      class="btn"
      onclick={() => onstep(3)}
      title={`Go on to step 3: the measures, their numbers and breaks.${canEdit ? ` Submission is in step ${lastStep}.` : ""}`}
    >
      Next: measures
    </button>
  {:else if naming && layoutStep === 3}
    <button
      type="button"
      class="btn"
      onclick={() => onstep(4)}
      title={`Go on to step 4: the instrument of every staff.${canEdit ? " Submission is in step 4." : ""}`}
    >
      Next: instruments
    </button>
  {/if}
{/snippet}

<WorkspaceFooter class="presses-docked">
  <!-- Why Submit is not available yet, while it is the step's button. -->
  {#if toOthers}
    {#if toOthers.block}
      <p class="blockline">{toOthers.block}</p>
    {/if}
  {:else if submitBlock && canEdit && !(omr && layoutStep < (naming ? 4 : 3))}
    <p class="blockline">{submitBlock}</p>
  {/if}
  {#if step4 && canEdit && transcription}
    <p
      class="blockline retryline"
      class:err={transcription.error}
      role="status"
      title="The staves are transcribed while the instruments are named. The transcription is submitted with the corrections."
    >
      <span>{transcription.text}</span>
      {#if transcription.error && transcriber.runningKey === null}
        <button
          type="button"
          class="btn"
          onclick={() => transcriber.transcribe()}
          >{transcriber.recognisedKey === transcriber.staffKey
            ? "Transcribe the failed staves again"
            : "Try again"}</button
        >
      {/if}
    </p>
  {/if}
  {@render status()}
  {#if omr && layoutStep < lastStep}
    {@render nextStep()}
  {:else if toOthers}
    <button
      type="button"
      class="btn"
      onclick={() => toOthers.onfix(true)}
      disabled={toOthers.block !== null}
      title={toOthers.block ??
        "Go on to the other systems: choose for every staff an instrument of the first system and its parts. Submission is there."}
    >
      Next: other systems
    </button>
  {:else}
    <button
      type="button"
      class="btn btn-primary btn-pre"
      onclick={() => onsubmit()}
      disabled={busy || !canEdit || submitBlock !== null}
      title={submitBlock ??
        (naming
          ? "Submit the corrected staves, grand staves, measures, breaks, sections and instruments for review"
          : omr
            ? "Submit the corrected staves, grand staves, measures, breaks and sections for review"
            : "Submit the corrected measures, breaks and sections for review")}
    >
      Submit corrections
    </button>
  {/if}
</WorkspaceFooter>

<style>
  /* Give back task and the step's button at the two ends of the footer's row
     (WorkspaceFooter); the draft state shows over the pages (DraftBubble). */
  :global(.wfoot) > .btn {
    margin-left: auto;
  }
  .blockline {
    flex-basis: 100%;
    margin: 0;
    font-size: 12px;
    line-height: 1.4;
    color: var(--ink-soft);
  }
  .blockline.err {
    color: var(--danger);
  }
  /* A failed transcription's line, with its retry at the right end. */
  .retryline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
</style>
