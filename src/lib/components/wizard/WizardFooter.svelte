<!--
  The work card's footer: Back and Continue built from the step's handlers,
  with the reason Continue waits (or the step's own footnote) on the row
  left of them; or the step's own `footer` in their place. It sits inside the
  card (WizardWorkCard), whose `.solo` and the frame's `.short` adjust its
  spacing.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "$lib/components/Icon.svelte";

  let {
    footer,
    footnote,
    hasMaterial,
    reasonId,
    nextReason,
    nextDisabled,
    onBack,
    onNext,
    nextLabel,
    nextIcon,
    backDisabled,
    navBlocked,
    finish,
    noteH = $bindable(),
  }: {
    footer: Snippet | undefined;
    footnote: Snippet | undefined;
    /** The step has material, so the reason line is kept while empty. */
    hasMaterial: boolean;
    /** The reason line's id, for Continue's description. */
    reasonId: string;
    nextReason: string | undefined;
    nextDisabled: boolean;
    onBack: (() => void) | undefined;
    onNext: (() => void) | undefined;
    nextLabel: string;
    nextIcon: "arrow-right" | "check" | null;
    backDisabled: boolean;
    navBlocked: string | undefined;
    finish: boolean;
    /** The reason line's height. */
    noteH: number;
  } = $props();
  const reasonShown = $derived(nextDisabled && !!nextReason && !footnote);
</script>

<div class="footer">
  {#if footer}
    {@render footer()}
  {:else}
    <!-- Beside pages fitted to the card's height the line is kept while
         empty, so the reason coming and going does not rescale them. -->
    {#if footnote}
      {@render footnote()}
    {:else if reasonShown || hasMaterial}
      <span
        class="footnote"
        id={reasonId}
        role="status"
        title={reasonShown ? nextReason : undefined}
        bind:offsetHeight={noteH}>{reasonShown ? nextReason : ""}</span
      >
    {/if}
    {#if onBack}
      <button
        type="button"
        class="btn btn-secondary"
        onclick={onBack}
        disabled={backDisabled || navBlocked !== undefined}
        title={navBlocked}
      >
        Back
      </button>
    {/if}
    {#if onNext}
      <button
        type="button"
        class="btn btn-primary"
        class:btn-finish={finish}
        onclick={onNext}
        disabled={nextDisabled || navBlocked !== undefined}
        title={navBlocked}
        aria-describedby={reasonShown ? reasonId : undefined}
      >
        {nextLabel}{#if nextIcon}<Icon name={nextIcon} />{/if}
      </button>
    {/if}
  {/if}
</div>

<style>
  .footer {
    flex: none;
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 10px;
    margin-top: 12px;
    padding: 14px var(--pad-x) 18px;
    border-top: 1px solid var(--line);
  }
  :global(.card.solo) .footer {
    margin-top: 18px;
  }
  /* On a touch screen the footer's 32px buttons take a 44px press through
     an invisible ::after. */
  @media (pointer: coarse) {
    .footer > :global(.btn) {
      position: relative;
    }
    .footer > :global(.btn)::after {
      content: "";
      position: absolute;
      inset: -6px;
    }
  }

  /* ---- Smaller windows ---------------------------------------------------- */
  @media (max-width: 999px) {
    .footer,
    :global(.card.solo) .footer {
      margin-top: 0;
      padding-top: 12px;
      padding-bottom: 14px;
    }
  }
  /* Phones: the primary button takes the row's width, and a step's own line
     beside the buttons (an acknowledgement) moves above them. */
  @media (max-width: 599px) {
    .footer,
    :global(.card.solo) .footer {
      padding-top: 10px;
      padding-bottom: 12px;
    }
    .footer {
      position: relative;
      flex-wrap: wrap;
    }
    .footer > :global(*:not(.btn)) {
      flex: 1 1 100%;
    }
    /* Why Continue waits lies over the foot of the body, in full, so it
       takes no height: the body keeps its size whether it shows or not, and
       its content scrolls clear of it (the card pads its body by the
       reason's height, --note-h). */
    .footer > .footnote {
      position: absolute;
      /* Above the body's fade at its foot. */
      z-index: 2;
      left: 0;
      right: 0;
      bottom: 100%;
      padding: 6px var(--pad-x);
      white-space: normal;
      background: var(--card);
      border-top: 1px solid var(--line);
    }
    .footer > .footnote:empty {
      display: none;
    }
    .footer > :global(.btn-primary) {
      flex: 1;
    }
  }
  :global(.short) .footer,
  :global(.short) :global(.card.solo) .footer {
    padding-top: 8px;
    padding-bottom: 10px;
  }

  /* A window too short to hold the heading, a usable body and the footer:
     the page scrolls as one, with the footer held at the bottom edge. */
  @media (max-height: 300px) {
    .footer {
      position: sticky;
      bottom: 0;
      background: var(--card);
      border-radius: 0 0 14px 14px;
    }
  }
</style>
