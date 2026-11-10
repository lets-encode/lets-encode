<!--
  A modal card over the whole viewport, shown while an action that runs on
  the forge is in flight: a spinner plus the action's timed step log, so what
  is happening (and how long each stage takes) is visible while it runs. Once
  the action has finished the card stays up, with the step times and their
  total readable, until its Continue button is pressed. An action that ended
  in an error shows that error on the card itself, in place of the finished
  title; one still being processed, or only partly done, shows that as a
  warning with its message. The palette is fixed rather than themed, matching the app
  surfaces it covers.
-->
<script module lang="ts">
  /** Shows `dialog` as a modal: the page behind it is inert and Escape does
      not close it. When the dialog leaves the page, focus returns to the
      element that had it before. */
  export function modal(dialog: HTMLDialogElement) {
    const opener = document.activeElement;
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") e.preventDefault();
    });
    dialog.addEventListener("cancel", (e) => e.preventDefault());
    dialog.showModal();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }
</script>

<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import ProgressSteps from "./ProgressSteps.svelte";
  import type { ProgressLog } from "$lib/progress-log.svelte.ts";

  let {
    log,
    finished = false,
    error,
    outcome,
    message,
    onContinue,
  }: {
    log: ProgressLog;
    finished?: boolean;
    /** The finished action's error, when it ended in one. */
    error?: string;
    /** The finished action's outcome: still being processed, or part of the
        work failed; both are shown as a warning with `message`. */
    outcome?: "pending" | "noop" | "partial";
    message?: string;
    onContinue?: () => void;
  } = $props();

  const titleId = $props.id();
</script>

<dialog class="overlay" aria-labelledby={titleId} {@attach modal}>
  <div
    class="overlay-card"
    role={finished && error ? "alert" : "status"}
    aria-live="polite"
  >
    {#if finished && error}
      <div class="fail-mark" aria-hidden="true">
        <Icon name="warning" size={22} />
      </div>
      <p class="overlay-title failed" id={titleId}>Failed</p>
      <p class="overlay-error">{error}</p>
    {:else if finished && (outcome === "pending" || outcome === "partial")}
      <p class="overlay-title warned" id={titleId}>
        {outcome === "pending" ? "Still being processed" : "Partly done"}
      </p>
      {#if message}<p class="overlay-sub">{message}</p>{/if}
    {:else if finished}
      <p class="overlay-title" id={titleId}>Finished</p>
    {:else}
      <div class="spinner spinner-lg" aria-hidden="true"></div>
      <p class="overlay-title" id={titleId}>Working…</p>
      <p class="overlay-sub">
        The campaign automation runs on GitHub — this can take a few seconds.
      </p>
    {/if}
    <ProgressSteps {log} />
    {#if finished}
      <button
        type="button"
        class="btn btn-primary"
        onclick={onContinue}
        {@attach (el) => el.focus()}
      >
        Continue
      </button>
    {/if}
  </div>
</dialog>

<style>
  /* The step log fills the card's width and keeps its list left-aligned. */
  .overlay-card > :global(.log) {
    align-self: stretch;
    margin-top: 0;
    text-align: left;
  }
  .overlay-sub {
    margin: 0;
    color: var(--ink-faint);
    font-size: 0.85rem;
  }
</style>
