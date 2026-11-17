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
    wizard,
    type WIZARD_STEPS,
    type WizardStepId,
  } from "$lib/wizard.svelte.ts";
  import WizardStep from "./WizardStep.svelte";

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
      <li>
        <!-- The compact rail has the campaign name on top already. -->
        <WizardStep
          rail
          step={s}
          index={i}
          {current}
          last={i === steps.length - 1}
          value={short && s.id === "name" ? "" : valueOf(i, s.id)}
          {backDisabled}
          {navBlocked}
        />
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
      {#if otherDrafts.length}
        <div class="others-head">Resume another setup</div>
      {/if}
      {#each otherDrafts as draft (draft.handle)}
        {@const name = draft.entries?.title?.trim() || draft.handle}
        <button
          type="button"
          class="btn other-draft"
          title={`Resume setup of “${name}”`}
          aria-label={`Resume setup of “${name}”`}
          onclick={() => onResume(draft.handle)}
          disabled={resuming !== null || backDisabled}
        >
          <span class="resume-text">
            {resuming === draft.handle ? "Working…" : name}
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
  /* ---- Shared with the step track: saved line ------------------------- */
  .saved,
  .others-head {
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
    font: 400 12px var(--mono);
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
  :global(.short) .rail-foot {
    padding-top: 4px;
  }
</style>
