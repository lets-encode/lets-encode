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
  import Icon from "$lib/components/Icon.svelte";
  import { auth } from "$lib/auth.svelte.ts";
  import {
    goToStep,
    wizard,
    type WIZARD_STEPS,
    type WizardStepId,
  } from "$lib/wizard.svelte.ts";

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
          {@const done = i < current}
          {@const active = i === current}
          {@const value = valueOf(i, s.id)}
          <li>
            <button
              type="button"
              class="tstep"
              class:active
              disabled={!done || backDisabled || navBlocked !== undefined}
              title={(done && navBlocked) || value || undefined}
              aria-label={s.label}
              onclick={() => goToStep(s.id)}
              aria-current={active ? "step" : undefined}
            >
              <span class="hit">
                <span class="bubble" class:done class:active>
                  {#if done}<Icon name="check" size={12} />{:else}{i + 1}{/if}
                </span>
              </span>
              <span
                class="step-label"
                class:active
                class:upcoming={!done && !active}>{s.label}</span
              >
              {#if value}
                <span class={active ? "step-status" : "step-summary"}
                  >{value}</span
                >
              {/if}
            </button>
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
  /* ---- Shared with the step rail: bubbles, labels, saved line ----------- */
  .bubble {
    box-sizing: border-box;
    flex: none;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12.5px;
    background: var(--card);
    border: 1px solid var(--line-strong);
    color: var(--ink-faint);
    position: relative;
    z-index: 1;
  }
  .bubble.done {
    font-size: 13px;
    background: var(--ok-btn);
    border: none;
    color: #fff;
  }
  .bubble.active {
    font-weight: 600;
    background: var(--accent-btn);
    border: none;
    color: #fff;
    box-shadow: 0 0 0 4px rgba(37, 99, 201, 0.15);
  }
  .step-label {
    display: block;
    font-size: 13.5px;
    font-weight: 600;
    line-height: 16px;
    color: var(--ink-soft);
  }
  .step-label.active {
    color: var(--ink);
  }
  .step-label.upcoming {
    color: var(--ink-faint);
  }
  .step-summary,
  .step-status {
    display: block;
    font-size: 11.5px;
    line-height: 15px;
    color: var(--ink-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .step-status {
    color: var(--accent);
    font-weight: 600;
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

  /* A window 500px tall or less (the frame's .short). */
  :global(.short) .bubble {
    width: 24px;
    height: 24px;
    font-size: 11.5px;
  }
  :global(.short) .step-label {
    font-size: 13px;
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
    font:
      12px ui-monospace,
      Menlo,
      monospace;
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
  /* The connecting line runs between the first and the last bubble's
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
  .tstep {
    position: relative;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    min-width: 0;
    padding: 0 2px;
    background: none;
    border: none;
    font: inherit;
    color: inherit;
    text-align: center;
    cursor: pointer;
  }
  .tstep:disabled {
    cursor: default;
  }
  .hit {
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .tstep .bubble {
    width: 24px;
    height: 24px;
    font-size: 11.5px;
  }
  .tstep .bubble.active {
    box-shadow: 0 0 0 3px rgba(37, 99, 201, 0.15);
  }
  .tstep .step-label {
    margin-top: -6px;
    font-size: 12px;
    line-height: 14px;
    white-space: nowrap;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tstep .step-summary,
  .tstep .step-status {
    max-width: 100%;
    font-size: 10.5px;
    line-height: 13px;
  }
  /* 600–799px: labels, and the current step's status; from 800px the
     completed steps' values too. */
  @media (max-width: 799px) {
    .tstep .step-summary {
      display: none;
    }
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
    .tstep .step-label,
    .tstep .step-status {
      display: none;
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
