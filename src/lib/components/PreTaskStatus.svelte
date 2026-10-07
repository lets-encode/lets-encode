<!--
  A pre-task editor's lock state as a pill: held (with its expiry, the draft
  save state and an abandon button), run out (with a claim button), done,
  awaiting or failing review, blocked, claimed by someone else, or unclaimed
  with a claim button.
-->
<script lang="ts">
  import { handle } from "$lib/campaign-graph.ts";
  import { expiresIn } from "$lib/campaign-board.ts";
  import AbandonButton from "$lib/components/AbandonButton.svelte";
  import type { PreTaskSession } from "$lib/pre-task-session.svelte.ts";

  let { session }: { session: PreTaskSession } = $props();
  const d = $derived(session.data!);
</script>

{#if session.holds}
  <span
    class="lockpill ok"
    title={`Your claim ends ${new Date(d.encodingLockExpires).toLocaleString()}. Submit before then; afterwards the task is open to others.`}
    >you hold this task{expiresIn(d.encodingLockExpires, session.now)
      ? ` · ${expiresIn(d.encodingLockExpires, session.now)}`
      : ""}</span
  >
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
  <span class="lockpill red">your claim has run out — read-only</span>
  <button
    type="button"
    class="btn btn-pre"
    onclick={() => session.claim()}
    disabled={session.busy}>Claim task</button
  >
{:else if d.status === "completed"}
  <span class="lockpill grey">done — read-only</span>
{:else if d.status !== "encoding_required"}
  {#if session.failedVerdicts.length > 0 && session.validation?.openSlots === 0}
    <span class="lockpill red">changes requested — read-only</span>
  {:else}
    <span class="lockpill amber">submitted — awaiting review, read-only</span>
  {/if}
{:else if d.blockedBy}
  <span class="lockpill grey">waits for {d.blockedBy} — read-only</span>
{:else if d.encodingLockUser}
  <span class="lockpill amber"
    >claimed by @{handle(session.logins, d.encodingLockUser)} — read-only</span
  >
{:else}
  <span class="lockpill amber">unclaimed — read-only</span>
  <button
    type="button"
    class="btn btn-pre"
    onclick={() => session.claim()}
    disabled={session.busy}>Claim task</button
  >
{/if}

<style>
  .lockpill {
    flex: none;
    font-size: 11.5px;
    font-weight: 600;
    border-radius: 999px;
    line-height: 1;
    padding: 3px 10px;
  }
  .lockpill.ok {
    color: var(--ok);
    background: var(--ok-bg);
    border: 1px solid var(--ok-line);
  }
  .lockpill.amber {
    color: var(--owner);
    background: var(--owner-bg);
    border: 1px solid var(--owner-line);
  }
  .lockpill.grey {
    color: var(--ink-faint);
    background: var(--bg-tint);
    border: 1px solid var(--line);
  }
  .draftnote {
    font-size: 11.5px;
    color: var(--ink-faint);
  }
  .draftnote.err {
    color: var(--danger);
  }
  .lockpill.red {
    color: var(--danger);
    background: var(--danger-bg);
    border: 1px solid var(--danger-line);
  }
</style>
