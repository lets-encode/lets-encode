<!--
  The measure correction's action at the side panel's bottom: why Submit is
  not available yet, the transcription's state in the instruments step, the
  claim or the draft state and give back, then the next step or the
  submission.
-->
<script lang="ts">
  import PreTaskStatus from "$lib/components/PreTaskStatus.svelte";
  import type { PreTaskSession } from "$lib/pre-task-session.svelte.ts";
  import type { LayoutStep } from "$lib/zones/layout-steps.svelte.ts";
  import type { StaffTranscription } from "$lib/zones/staff-transcription.svelte.ts";

  let {
    session,
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
  }: {
    session: PreTaskSession;
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
  } = $props();

  const transcription = $derived(transcriber.transcription);
</script>

<!-- The button to the next step of a layout task, for the editor and the
     reviewer. -->
{#snippet nextStep()}
  {#if layoutStep === 1}
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => onstep(2)}
      title={`Go on to step 2: the grand staves, one box around the staves one performer plays together.${canEdit ? ` Submission is in step ${lastStep}.` : ""}`}
    >
      Next: grand staves
    </button>
  {:else if layoutStep === 2}
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => onstep(3)}
      title={`Go on to step 3: the measures, their numbers and breaks.${canEdit ? ` Submission is in step ${lastStep}.` : ""}`}
    >
      Next: measures
    </button>
  {:else if naming && layoutStep === 3}
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => onstep(4)}
      title={`Go on to step 4: the instrument of every staff.${canEdit ? " Submission is in step 4." : ""}`}
    >
      Next: instruments
    </button>
  {/if}
{/snippet}

<div class="wfoot">
  <!-- Why Submit is not available yet, while it is the step's button. -->
  {#if submitBlock && canEdit && !(omr && layoutStep < (naming ? 4 : 3))}
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
  <PreTaskStatus {session} />
  {#if omr && layoutStep < lastStep}
    {@render nextStep()}
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
</div>

<style>
  /* Give back task and the step's button at the two ends of one row; the draft
     state shows over the pages (DraftBubble). */
  .wfoot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .wfoot > .btn {
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
  .wfoot :global(.btn) {
    white-space: nowrap;
  }
  /* Docked as a sheet the buttons take a 44px press. */
  @media (orientation: portrait) and (max-width: 1100px) {
    .wfoot :global(.btn) {
      position: relative;
    }
    .wfoot :global(.btn)::after {
      content: "";
      position: absolute;
      inset: -6px;
    }
  }
</style>
