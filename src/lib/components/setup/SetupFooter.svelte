<!--
  The score setup's action at the side panel's bottom: the setup's summary
  line, the draft's state, and "Next: groups" in step 1 or "Submit setup" in
  step 2.
-->
<script lang="ts">
  import PreTaskStatus from "$lib/components/PreTaskStatus.svelte";
  import type { PreTaskSession } from "$lib/pre-task-session.svelte.ts";
  import type { SetupModel } from "$lib/setup/setup-model.svelte.ts";
  import type { SetupRecognition } from "$lib/setup/setup-recognition.svelte.ts";
  import type { SetupSubmission } from "$lib/setup/setup-submission.svelte.ts";

  let {
    session,
    model,
    recognition,
    submission,
    step,
    ongo,
  }: {
    session: PreTaskSession;
    model: SetupModel;
    recognition: SetupRecognition;
    submission: SetupSubmission;
    step: 1 | 2;
    ongo: (step: 1 | 2) => void;
  } = $props();

  const runner = $derived(session.runner);
</script>

<div class="wfoot">
  <span class="abcount wsum">
    {model.staves.length} stave{model.staves.length === 1 ? "" : "s"}
    · {model.meterType === "numeric"
      ? `${model.meterCount}/${model.meterUnit}`
      : model.meterType === "common"
        ? "common time"
        : "cut time"}
  </span>
  <span class="wstatus">
    <PreTaskStatus {session} />
  </span>
  {#if step === 1}
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => ongo(2)}
      title="Go on to step 2: the braces and brackets that join staves. Submission is in step 2."
    >
      Next: groups
    </button>
  {:else}
    <button
      type="button"
      class="btn btn-primary btn-pre"
      onclick={() => submission.submit()}
      disabled={session.busy ||
        !session.canEdit ||
        !model.meterValid ||
        !model.groupsValid ||
        (recognition.omr && !recognition.result)}
      title={recognition.omr && session.canEdit && !recognition.result
        ? "The staves have to be transcribed before the setup can be submitted"
        : "Submit the staves, clefs, key signature and time signature for review"}
    >
      {submission.submitting && runner.busy && !runner.overlay
        ? "Checking the score…"
        : "Submit setup"}
    </button>
  {/if}
</div>

<style>
  /* ------------------------------------------------------------ side panel
     The footer action (SidePanel.svelte). */
  .wfoot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  /* The setup's summary is a line of its own above the buttons. */
  .wsum {
    flex-basis: 100%;
  }
  .wstatus {
    flex: 1;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    min-width: 0;
  }
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
  .abcount {
    font-size: 12.5px;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
