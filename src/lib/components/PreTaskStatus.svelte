<!--
  A pre-task editor's claim controls beside the task box's status pill: for
  a held claim the draft save state and an abandon button, for a claim that
  ran out a note and a claim button, and for an unclaimed, unblocked task a
  claim button.
-->
<script lang="ts">
  import AbandonButton from "$lib/components/AbandonButton.svelte";
  import type { PreTaskSession } from "$lib/pre-task-session.svelte.ts";

  let { session }: { session: PreTaskSession } = $props();
  const d = $derived(session.data!);
</script>

{#if session.holds}
  {#if session.draftState === "saving"}
    <span class="draftnote">saving draft…</span>
  {:else if session.draftState === "saved"}
    <span
      class="draftnote"
      title="Your changes are saved. They stay when you leave the page and are kept if your claim runs out."
      >draft saved</span
    >
  {:else if session.draftState}
    <span class="draftnote err">{session.draftState}</span>
  {/if}
  <AbandonButton
    disabled={session.busy}
    onabandon={() => session.abandon("")}
  />
{:else if session.claimRanOut}
  <span class="draftnote err"
    >Your claim has run out. The editor is read-only.</span
  >
  <button
    type="button"
    class="btn btn-pre"
    onclick={() => session.claim()}
    disabled={session.busy}>Claim task</button
  >
{:else if d.status === "encoding_required" && !d.blockedBy && !d.encodingLockUser}
  <button
    type="button"
    class="btn btn-pre"
    onclick={() => session.claim()}
    disabled={session.busy}>Claim task</button
  >
{/if}

<style>
  .draftnote {
    font-size: 11.5px;
    color: var(--ink-faint);
  }
  .draftnote.err {
    color: var(--danger);
  }
</style>
