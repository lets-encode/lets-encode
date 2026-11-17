<!--
  The wizard's horizontal step track above the card, on narrow or portrait
  windows: a line with the campaign name, the saved line and `links` (the
  other setups and Discard), the discard question under it when open, and the
  steps as circles on a line. From 800px every step shows its label and
  value, from 600px the labels and the current step's status; below 600px
  only the circles, with a line under them naming the current step.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { auth } from "$lib/auth.svelte.ts";
  import {
    wizard,
    type WIZARD_STEPS,
    type WizardStepId,
  } from "$lib/wizard.svelte.ts";
  import WizardStep from "./WizardStep.svelte";

  let {
    steps,
    current,
    valueOf,
    status,
    savedAgo,
    backDisabled,
    navBlocked,
    confirmingDiscard,
    links,
    discardQuestion,
  }: {
    steps: (typeof WIZARD_STEPS)[number][];
    /** The current step's index in `steps`. */
    current: number;
    /** What a step shows under its label. */
    valueOf: (i: number, id: WizardStepId) => string;
    /** What the current step is doing right now. */
    status: string | undefined;
    savedAgo: string | null;
    backDisabled: boolean;
    navBlocked: string | undefined;
    /** The discard question is open under the top line. */
    confirmingDiscard: boolean;
    /** The other setups and Discard behind popups, given Discard's label. */
    links: Snippet<[string]>;
    discardQuestion: Snippet;
  } = $props();
</script>

<div class="trackbar">
  <div class="thead">
    {#if wizard.handle.trim()}
      <span class="tname">{wizard.handle}</span>
      {#if auth.user}
        <span class="tslug">{auth.user.login}/{wizard.handle}</span>
      {/if}
    {:else}
      <span class="tname rail-unnamed">Unnamed campaign</span>
    {/if}
    <span class="push"></span>
    {#if savedAgo}
      <span class="saved thead-saved">
        <span class="saved-dot"></span>Saved · {savedAgo}
      </span>
    {/if}
    {@render links("Discard setup")}
  </div>
  {#if confirmingDiscard}
    <div class="discard-strip" data-popup>
      {@render discardQuestion()}
    </div>
  {/if}

  <nav class="track" aria-label="Campaign setup steps">
    <div class="track-steps" style="--n: {steps.length}">
      <span class="line" aria-hidden="true"></span>
      {#if current > 0}
        <span
          class="line done"
          aria-hidden="true"
          style="width: calc((100% - 100% / var(--n)) * {current} / {steps.length -
            1})"
        ></span>
      {/if}
      <ol>
        {#each steps as s, i (s.id)}
          <li>
            <WizardStep
              step={s}
              index={i}
              {current}
              value={valueOf(i, s.id)}
              {backDisabled}
              {navBlocked}
            />
          </li>
        {/each}
      </ol>
    </div>
  </nav>

  <!-- Below 600px the track shows circles only; this line names the
       current step instead. -->
  <div class="tcur">
    <b>{steps[current]?.label}</b>
    {#if status}<span class="step-status">{status}</span>{/if}
    {#if savedAgo}
      <span class="push saved">
        <span class="saved-dot"></span>Saved · {savedAgo}
      </span>
    {/if}
  </div>
</div>

<style>
  /* ---- Shared with the step rail: saved line -------------------------- */
  .step-status {
    display: block;
    font-size: 11.5px;
    line-height: 15px;
    color: var(--accent);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .saved {
    font-size: 11.5px;
    color: var(--ink-faint);
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .saved-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--green);
  }
  .rail-unnamed {
    color: var(--ink-faint);
  }
  /* In the line above the track a button overlaps the line's padding
     rather than making the line taller. The buttons are the ones `links`
     renders. */
  .thead :global(.btn) {
    margin-block: -4px;
  }

  /* ---- Step track -------------------------------------------------------- */
  .trackbar {
    flex: none;
  }
  .thead {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 16px 0;
    min-height: 30px;
    font-size: 13px;
    color: var(--ink-faint);
  }
  .tname {
    font-weight: 600;
    color: var(--ink);
    font-size: 14.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .tslug {
    font: 12px var(--mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .push {
    margin-left: auto;
  }
  .discard-strip {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 6px 12px 2px;
    padding: 10px 12px;
    font-size: 13px;
    color: var(--ink);
    background: var(--danger-wash);
    border: 1px solid var(--danger-line);
    border-radius: 10px;
  }
  .track {
    margin: 6px 16px 0;
  }
  .track-steps {
    position: relative;
  }
  .track ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(var(--n), minmax(0, 1fr));
  }
  /* The connecting line runs between the first and the last disc's
     centres; its completed part ends at the current step. */
  .line {
    position: absolute;
    top: 21px;
    height: 2px;
    left: calc(100% / (var(--n) * 2));
    right: calc(100% / (var(--n) * 2));
    background: var(--line-strong);
  }
  .line.done {
    right: auto;
    background: linear-gradient(
      90deg,
      var(--ok-btn) calc(100% - 30px),
      var(--accent-btn)
    );
  }
  .track li {
    min-width: 0;
  }
  .tcur {
    display: none;
  }
  /* Below 600px: circles only, with the current step's name, status and
     saved line on one line under the track. */
  @media (max-width: 599px) {
    .thead {
      min-height: 34px;
      padding-top: 4px;
    }
    .tslug,
    .thead-saved {
      display: none;
    }
    /* The circles sit as far below the name as the name sits below the top
       bar; their 44px press areas overlap the line above. */
    .track {
      margin-top: -6px;
    }
    .tcur {
      display: flex;
      align-items: baseline;
      gap: 8px;
      min-height: 22px;
      padding: 0 20px;
      font-size: 13px;
    }
    .tcur b {
      font-size: 14px;
      font-weight: 600;
      white-space: nowrap;
    }
    .tcur .step-status {
      font-size: 13px;
      min-width: 0;
    }
    .tcur .saved {
      font-size: 12px;
    }
  }
</style>
