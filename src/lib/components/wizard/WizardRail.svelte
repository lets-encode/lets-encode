<!--
  The wizard's vertical step rail, on wide or landscape windows: the campaign
  name, the steps with their summaries, and at the foot the saved line,
  Discard and the account's other setups. In a window 500px tall or less (the
  frame's `.short`) it is the compact rail, with the saved line on top and
  the other setups and Discard behind `links`.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "$lib/components/Icon.svelte";
  import { auth } from "$lib/auth.svelte.ts";
  import type { WizardDraft } from "$lib/wizard-draft.ts";
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
    short,
    savedAgo,
    backDisabled,
    navBlocked,
    confirmingDiscard,
    registered,
    registeredTitle,
    otherDrafts,
    resuming,
    resumeError,
    onResume,
    onDiscard,
    links,
    discardQuestion,
  }: {
    steps: (typeof WIZARD_STEPS)[number][];
    /** The current step's index in `steps`. */
    current: number;
    /** What a step shows under its label. */
    valueOf: (i: number, id: WizardStepId) => string;
    short: boolean;
    savedAgo: string | null;
    backDisabled: boolean;
    navBlocked: string | undefined;
    /** The discard question is open in place of the Discard button. */
    confirmingDiscard: boolean;
    registered: boolean;
    registeredTitle: string | undefined;
    otherDrafts: WizardDraft[];
    resuming: string | null;
    resumeError: string | null;
    onResume: (handle: string) => void;
    /** Opens the discard question. */
    onDiscard: () => void;
    /** The other setups and Discard behind popups, given Discard's label. */
    links: Snippet<[string]>;
    discardQuestion: Snippet;
  } = $props();
</script>

<nav class="rail" aria-label="Campaign setup steps">
  <div class="rail-name">
    {#if wizard.handle.trim()}
      {wizard.handle}
      {#if auth.user}
        <span class="rail-slug">{auth.user.login}/{wizard.handle}</span>
      {/if}
    {:else}
      <span class="rail-unnamed">Unnamed campaign</span>
    {/if}
  </div>
  {#if savedAgo}
    <div class="saved rail-saved-top">
      <span class="saved-dot"></span>Saved · {savedAgo}
    </div>
  {/if}

  <ol class="rail-steps">
    {#each steps as s, i (s.id)}
      {@const done = i < current}
      {@const active = i === current}
      {@const value = valueOf(i, s.id)}
      <li>
        <button
          type="button"
          class="rail-step"
          disabled={!done || backDisabled || navBlocked !== undefined}
          title={done ? navBlocked : undefined}
          onclick={() => goToStep(s.id)}
          aria-current={active ? "step" : undefined}
        >
          <span class="rail-chain">
            <span class="bubble" class:done class:active>
              {#if done}<Icon name="check" size={12} />{:else}{i + 1}{/if}
            </span>
            {#if i < steps.length - 1}
              <span
                class="connector"
                class:done
                class:tolive={i === current - 1}
              ></span>
            {/if}
          </span>
          <span class="step-text">
            <span
              class="step-label"
              class:active
              class:upcoming={!done && !active}
            >
              {s.label}
            </span>
            <!-- The compact rail has the campaign name on top already. -->
            {#if value && !(short && s.id === "name")}
              <span class={active ? "step-status" : "step-summary"}
                >{value}</span
              >
            {/if}
          </span>
        </button>
      </li>
    {/each}
  </ol>

  <div class="rail-foot">
    {#if savedAgo && !short}
      <div class="saved">
        <span class="saved-dot"></span>Draft saved · {savedAgo}
      </div>
    {/if}
    {#if short}
      {@render links("Discard this setup")}
    {:else}
      {#if auth.user}
        {#if confirmingDiscard}
          <div class="discard-inline" data-popup>
            {@render discardQuestion()}
          </div>
        {:else}
          <button
            type="button"
            class="btn btn-danger"
            onclick={onDiscard}
            disabled={backDisabled || registered}
            title={registeredTitle}
          >
            <Icon name="trash" />Discard this setup
          </button>
        {/if}
      {/if}
      {#each otherDrafts as draft (draft.handle)}
        {@const name = draft.entries?.title?.trim() || draft.handle}
        <button
          type="button"
          class="btn other-draft"
          title={`Resume setup of “${name}”`}
          onclick={() => onResume(draft.handle)}
          disabled={resuming !== null || backDisabled}
        >
          <span class="resume-text">
            {resuming === draft.handle
              ? "Working…"
              : `Resume setup of “${name}”`}
          </span>
        </button>
      {/each}
      {#if resumeError}
        <p class="msg-error" role="alert">{resumeError}</p>
      {/if}
    {/if}
  </div>
</nav>

<style>
  /* ---- Shared with the step track: bubbles, labels, saved line ---------- */
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
  .resume-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ---- Step rail --------------------------------------------------------- */
  .rail {
    flex: none;
    width: 248px;
    box-sizing: border-box;
    padding: 24px 20px 18px;
    display: flex;
    flex-direction: column;
    overflow: auto;
  }
  /* Below 1300px the rail gives the page images part of its width. */
  @media (max-width: 1299px) {
    .rail {
      width: 208px;
      padding-inline: 16px;
    }
  }
  .rail-name {
    font-size: 15px;
    font-weight: 600;
    line-height: 1.3;
    margin: 2px 0 16px;
    overflow-wrap: anywhere;
  }
  .rail-slug {
    display: block;
    margin-top: 2px;
    font:
      400 12px ui-monospace,
      Menlo,
      monospace;
    color: var(--ink-faint);
  }
  .rail-saved-top {
    display: none;
  }
  .rail-steps {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .rail-step {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    width: 100%;
    padding: 0;
    text-align: left;
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    cursor: pointer;
  }
  .rail-step:disabled {
    cursor: default;
  }
  .rail-chain {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: none;
  }
  .connector {
    width: 2px;
    height: 20px;
    border-radius: 1px;
    background: var(--line-strong);
  }
  /* The chain colours in as the steps complete: green along the completed
     stretch, blending into blue where it reaches the active step. */
  .connector.done {
    background: var(--ok-btn);
  }
  .connector.tolive {
    background: linear-gradient(var(--ok-btn), var(--accent-btn));
  }
  .step-text {
    display: block;
    flex: 1;
    padding-top: 5px;
    min-width: 0;
  }
  .rail .step-summary,
  .rail .step-status {
    max-width: 180px;
  }
  .rail-foot {
    margin-top: auto;
    padding-top: 14px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    font-size: 12.5px;
  }
  /* The foot's own buttons and the ones `links` renders, not those inside
     the discard question. */
  .rail-foot > :global(.btn) {
    max-width: 100%;
  }
  .discard-inline {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 6px;
    font-size: 12px;
    color: var(--ink-soft);
  }
  .other-draft {
    max-width: 100%;
    margin-top: 4px;
  }

  /* A window 500px tall or less (the frame's .short): a narrow rail with the
     name and the saved line on top, and Discard pinned to the foot. */
  :global(.short) .rail {
    width: 156px;
    padding: 8px 6px 6px 12px;
  }
  :global(.short) .rail-slug {
    display: none;
  }
  :global(.short) .rail-name {
    font-size: 13px;
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  :global(.short) .rail-saved-top {
    display: flex;
    margin: 2px 0 6px;
  }
  :global(.short) .bubble {
    width: 24px;
    height: 24px;
    font-size: 11.5px;
  }
  :global(.short) .connector {
    height: 4px;
  }
  :global(.short) .step-text {
    padding-top: 4px;
  }
  :global(.short) .step-label {
    font-size: 13px;
  }
  :global(.short) .rail .step-summary,
  :global(.short) .rail .step-status {
    font-size: 11px;
    line-height: 13px;
    max-width: 118px;
  }
  :global(.short) .rail-foot {
    padding-top: 4px;
  }
</style>
