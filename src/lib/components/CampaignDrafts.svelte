<!--
  Setups started in this browser and not finished. The wizard mirrors its entries
  into the browser's storage as they are entered, so one can be picked up here.

  Continuing loads the entries back into the wizard and opens it at /new, on
  the step the setup was left on. When the campaign's repository already
  exists, the page images it holds are read back from it first: their bytes
  are not kept between visits.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import { goto } from "$app/navigation";
  import { onDestroy } from "svelte";
  import { auth } from "$lib/auth.svelte.ts";
  import DiscardSetupConfirm from "$lib/components/DiscardSetupConfirm.svelte";
  import {
    readDraft,
    resumableDrafts,
    type WizardDraft,
  } from "$lib/wizard-draft.ts";
  import {
    WIZARD_STEPS,
    discardSetup,
    discardedRelease,
    registeredNote,
    resumeDraft,
    stepIndex,
  } from "$lib/wizard.svelte.ts";

  let drafts = $state<WizardDraft[]>([]);
  // The note on a name not given back is shown on this visit only.
  onDestroy(() => (discardedRelease.note = null));
  let busy = $state<string | null>(null);
  let confirming = $state<string | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    const owner = auth.user?.login;
    drafts = owner ? resumableDrafts(owner) : [];
  });

  /** "step x of y" for the step a draft was left on. */
  function stepLine(draft: WizardDraft): string {
    const step = draft.entries?.step;
    if (!step) return "";
    return `wizard step ${stepIndex(step) + 1} of ${WIZARD_STEPS.length}`;
  }

  async function continueSetup(draft: WizardDraft) {
    if (busy) return;
    error = null;
    confirming = null;
    busy = draft.handle;
    try {
      await resumeDraft(draft.owner, draft.handle);
      await goto("/new");
    } catch (err) {
      // A row whose record is gone — finished or discarded in another tab —
      // has nothing left to continue.
      if (!readDraft(draft.owner, draft.handle))
        drafts = drafts.filter((d) => d.handle !== draft.handle);
      console.error("Continuing a setup failed:", (err as Error).message);
      error = `Could not continue “${draft.handle}”: ${(err as Error).message}`;
    }
    busy = null;
  }

  async function discard(draft: WizardDraft) {
    drafts = drafts.filter((d) => d.handle !== draft.handle);
    confirming = null;
    await discardSetup(draft.owner, draft.handle, draft.claim);
  }
</script>

{#if drafts.length}
  <section class="drafts">
    <span class="dlabel">Drafts</span>
    {#each drafts as draft (draft.handle)}
      <div class="drow">
        <span class="dline">
          {draft.entries?.title?.trim() || draft.handle} — {stepLine(draft)} ·
          {draft.handle}
        </span>
        <button
          type="button"
          class="btn"
          onclick={() => continueSetup(draft)}
          disabled={busy !== null}
        >
          {busy === draft.handle
            ? "Working…"
            : "Resume"}{#if busy !== draft.handle}<Icon
              name="arrow-right"
              size={12}
            />{/if}
        </button>
        <span class="spacer"></span>
        {#if confirming === draft.handle}
          <span class="dnote">
            <DiscardSetupConfirm
              repo={draft.repo}
              onconfirm={() => discard(draft)}
              oncancel={() => (confirming = null)}
              disabled={busy !== null}
            />
          </span>
        {:else}
          <button
            type="button"
            class="btn btn-icon btn-danger"
            onclick={() => (confirming = draft.handle)}
            disabled={busy !== null || draft.claim?.registered}
            aria-label="Discard this setup"
            title={draft.claim?.registered
              ? registeredNote(draft.claim.name)
              : "Discard this setup"}><Icon name="trash" /></button
          >
        {/if}
      </div>
    {/each}

    {#if error}
      <p class="msg-error" role="alert">{error}</p>
    {/if}
  </section>
{/if}
{#if discardedRelease.note}
  <p class="msg-warn" role="status">{discardedRelease.note}</p>
{/if}

<style>
  .drafts {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .drow {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
    padding: 8px 16px;
    background: color-mix(in srgb, var(--card) 70%, transparent);
    border: 1px dashed var(--line-input);
    border-radius: 10px;
    min-width: 0;
  }
  .dlabel {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-faint);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .dline {
    font-size: 13px;
    color: var(--ink-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The question, with the repository note, is a sentence the reader needs
     whole: it takes the row's full width, above its buttons. */
  .dnote {
    flex: 1 1 100%;
  }
  .spacer {
    flex: 1;
  }
</style>
