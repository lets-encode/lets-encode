<!--
  The score setup's action at the side panel's bottom: the setup's summary
  line, the draft's state, and "Next: groups" in step 1 or "Submit setup" in
  step 2.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { SetupModel } from "$lib/setup/setup-model.svelte.ts";
  import type { SetupRecognition } from "$lib/setup/setup-recognition.svelte.ts";
  import WorkspaceFooter from "$lib/components/WorkspaceFooter.svelte";

  let {
    status,
    model,
    recognition,
    canEdit,
    busy,
    checking,
    step,
    ongo,
    onsubmit,
  }: {
    /** The host's status: the claim or the draft state and give back. */
    status: Snippet;
    model: SetupModel;
    recognition: SetupRecognition;
    canEdit: boolean;
    /** A submission or another command is running. */
    busy: boolean;
    /** The submitted setup is being checked. */
    checking: boolean;
    step: 1 | 2;
    ongo: (step: 1 | 2) => void;
    onsubmit: () => void;
  } = $props();
</script>

<WorkspaceFooter class="presses-docked" {status}>
  {#snippet summary()}
    {model.staves.length} stave{model.staves.length === 1 ? "" : "s"}
    · {model.meterType === "numeric"
      ? `${model.meterCount}/${model.meterUnit}`
      : model.meterType === "common"
        ? "common time"
        : "cut time"}
  {/snippet}
  {#if step === 1}
    <button
      type="button"
      class="btn"
      onclick={() => ongo(2)}
      title="Go on to step 2: the braces and brackets that join staves. Submission is in step 2."
    >
      Next: groups
    </button>
  {:else}
    <button
      type="button"
      class="btn btn-primary btn-pre"
      onclick={onsubmit}
      disabled={busy ||
        !canEdit ||
        !model.meterValid ||
        !model.groupsValid ||
        (recognition.omr && !recognition.result)}
      title={recognition.omr && canEdit && !recognition.result
        ? "The staves have to be transcribed before the setup can be submitted"
        : "Submit the staves, clefs, key signature and time signature for review"}
    >
      {checking ? "Checking the score…" : "Submit setup"}
    </button>
  {/if}
</WorkspaceFooter>
