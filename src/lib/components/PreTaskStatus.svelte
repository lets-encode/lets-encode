<!--
  A pre-task editor's claim controls beside the task box's status pill: for
  a held claim an abandon button (the draft save state shows over the pages,
  DraftBubble), for a claim that ran out a note and a claim button, and for
  an unclaimed, unblocked task a claim button.
-->
<script lang="ts">
  import AbandonButton from "$lib/components/AbandonButton.svelte";
  import type { PreTaskSession } from "$lib/pre-task-session.svelte.ts";

  let { session }: { session: PreTaskSession } = $props();
  const d = $derived(session.data!);
</script>

{#if session.holds}
  <AbandonButton
    disabled={session.busy}
    onabandon={() => session.abandon("")}
  />
{:else if session.claimRanOut}
  <span class="claimnote">Your claim has run out. The editor is read-only.</span
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
  .claimnote {
    font-size: 11.5px;
    color: var(--danger);
  }
</style>
