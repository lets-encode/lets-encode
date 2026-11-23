<!--
  One of the wizard frame's popups, placed against the window by `style`:
  the account's other setups to resume, the discard question, or the step's
  intro and info.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import Notice, { splitMessage } from "$lib/components/Notice.svelte";
  import type { WizardDraft } from "$lib/wizard-draft.ts";
  import type { PopupKind } from "$lib/wizard/popup-place.ts";

  let {
    kind,
    style,
    otherDrafts,
    resuming,
    resumeError,
    onResume,
    backDisabled,
    discardQuestion,
    intro,
    info,
  }: {
    kind: PopupKind;
    style: string;
    otherDrafts: WizardDraft[];
    resuming: string | null;
    resumeError: string | null;
    onResume: (handle: string) => void;
    backDisabled: boolean;
    discardQuestion: Snippet;
    intro: string | undefined;
    info: Snippet | undefined;
  } = $props();
</script>

<div class="popover popup {kind}-popup" {style} data-popup>
  {#if kind === "others"}
    <div class="grouplabel popup-head">Other setups on this account</div>
    {#each otherDrafts as draft (draft.handle)}
      <button
        type="button"
        class="resume"
        onclick={() => onResume(draft.handle)}
        disabled={resuming !== null || backDisabled}
      >
        <span class="resume-text">
          {resuming === draft.handle
            ? "Working…"
            : `Resume setup of “${draft.entries?.title?.trim() || draft.handle}”`}
        </span>
      </button>
    {/each}
    {#if resumeError}
      <Notice tone="err" {...splitMessage(resumeError)} />
    {/if}
  {:else if kind === "discard"}
    {@render discardQuestion()}
  {:else}
    {#if intro}<p>{intro}</p>{/if}
    {@render info?.()}
  {/if}
</div>

<style>
  .popup {
    position: fixed;
    z-index: var(--z-popover);
    box-sizing: border-box;
    padding: 8px;
  }
  .discard-popup {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    font-size: 13px;
    color: var(--ink);
    background: var(--danger-wash);
    border-color: var(--danger-line);
  }
  .info-popup {
    padding: 12px 14px;
    font-size: 13px;
    line-height: 1.45;
    color: var(--ink-soft);
  }
  .info-popup p {
    margin: 0;
  }
  .info-popup :global(ul) {
    margin: 8px 0 0;
    padding: 0;
  }
  .popup-head {
    padding: 6px 8px 4px;
  }
  .resume {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 44px;
    padding: 0 10px;
    border: none;
    background: none;
    border-radius: 8px;
    font: 13px var(--font);
    color: var(--ink);
    text-align: left;
    cursor: pointer;
  }
  .resume-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  @media (hover: hover) {
    .resume:hover:not(:disabled) {
      background: var(--accent-tint);
    }
  }
  .popup :global(.notice) {
    margin: 6px 4px 2px;
  }
</style>
