<!--
  A task's validation record in its task box: the viewer's own slot, and for
  the owner (canPush) also the slots held and passed under a "Reviews"
  heading. The verdict controls are in the task's own view (ReviewActions).
  Change requests are listed with the task's comments in the side panel.
  The host's status pill carries the slot count and its footer the claim.
-->
<script lang="ts">
  import type { LockRow } from "$lib/campaign-tables.ts";
  import { buildRecord, expiresIn } from "$lib/campaign-board.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import SlotMark, { slotLabel } from "./SlotMark.svelte";

  let {
    card,
    locks = [],
    viewer,
    logins,
    canPush,
  }: {
    card: BoardCard;
    /** The claim locks, for when a held slot's claim expires. */
    locks?: LockRow[];
    logins: Record<string, string>;
    viewer: string;
    canPush: boolean;
  } = $props();

  // With one slot in all, its rows need no slot number.
  const slotName = (slot: number) =>
    card.slots.length > 1 ? `Slot ${slot + 1} · ` : "";
  /** When the claim on a held slot expires; '' for none. */
  const slotExpiry = (sub: string, userId: string) => {
    const lock = locks.find(
      (l) =>
        l.task_id === card.task &&
        l.subtask_id === sub &&
        l.kind === "validation" &&
        l.user_id === userId,
    );
    return lock ? expiresIn(lock.expires) : "";
  };

  const rows = $derived(
    buildRecord(card, viewer, logins).filter(
      (r) => r.mine || (canPush && (r.key === "review" || r.key === "pass")),
    ),
  );
</script>

{#if rows.length > 0}
  <div class="rsec">
    {#if canPush}
      <div class="rlabel">Reviews</div>
    {/if}
    {#each rows as r (r.sub + "/" + r.slot)}
      <div class="rrow">
        <SlotMark key={r.key} />
        <span class="rslot">{slotName(r.slot)}{slotLabel(r.key)}</span>
        {#if r.login}
          <span class="rwho"
            >{r.login} · {r.key === "review"
              ? slotExpiry(r.sub, r.userId)
              : r.elapsed}</span
          >
        {/if}
        <span class="mspacer"></span>
        {#if r.key === "pass"}
          <span class="muted small-note">no remarks</span>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .muted {
    color: var(--ink-faint);
  }
  .mspacer {
    flex: 1;
  }
  .rlabel {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-soft);
    padding-bottom: 4px;
  }
  /* Wraps so the row's end stays visible in a narrow panel. */
  .rrow {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    padding: 10px 0;
    border-bottom: 1px solid var(--line);
  }
  .rslot {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
  }
  .rwho {
    font-size: 12px;
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .small-note {
    font-size: 11.5px;
    white-space: nowrap;
  }
</style>
