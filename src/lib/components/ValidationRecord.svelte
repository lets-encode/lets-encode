<!--
  A task's validation record in its task box: the viewer's own slot with its
  verdict controls (ReviewActions; without `actions` the host shows them
  elsewhere), and for the owner (canPush) also the slots held and
  passed under a "Reviews" heading. Change requests are listed with the
  task's comments in the side panel. The host's status pill
  carries the slot count and its footer the claim. Commands run through
  callbacks the host passes in.
-->
<script lang="ts">
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { LockRow } from "$lib/campaign-tables.ts";
  import type { FailComment, Result } from "$lib/commands.ts";
  import { buildRecord, expiresIn } from "$lib/campaign-board.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import ReviewActions from "./ReviewActions.svelte";

  let {
    card,
    locks = [],
    viewer,
    logins,
    canPush,
    runner,
    prefill,
    measures = true,
    actions = true,
    onvalidate,
    onreviewedit,
  }: {
    card: BoardCard;
    /** The claim locks, for when a held slot's claim expires. */
    locks?: LockRow[];
    logins: Record<string, string>;
    viewer: string;
    canPush: boolean;
    runner: CommandRunner;
    /** The anchor a fresh fail form opens with (page and measure range). */
    prefill: () => { page: string; m1: string; m2: string };
    /** The fail form asks for a measure range besides the page. */
    measures?: boolean;
    /** The viewer's slot carries its verdict controls. */
    actions?: boolean;
    onvalidate: (
      task_id: string,
      subtask_id: string,
      verdict: string,
      comment?: FailComment,
    ) => Promise<Result | null>;
    /** Switch the viewer's review to editing; no Edit button without it. */
    onreviewedit?: (
      task_id: string,
      subtask_id: string,
      comment: FailComment,
    ) => Promise<Result | null>;
  } = $props();

  /** How a slot's state reads in the record. */
  const slotLabel = (key: string): string =>
    ({
      pass: "approved",
      fail: "changes requested",
      review: "in review",
    })[key] ?? key;

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

{#snippet slotDot(key: string)}
  {#if key === "pass"}
    <img
      class="hand-pass"
      src="/green-hand.svg"
      alt={slotLabel(key)}
      title={slotLabel(key)}
    />
  {:else}
    <span class="dot {key}" aria-label={slotLabel(key)} title={slotLabel(key)}
    ></span>
  {/if}
{/snippet}

{#if rows.length > 0}
  <div class="rsec">
    {#if canPush}
      <div class="rlabel">Reviews</div>
    {/if}
    {#each rows as r (r.sub + "/" + r.slot)}
      <div class="rrow">
        {@render slotDot(r.key)}
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
        {:else if r.mine && actions}
          <ReviewActions
            task={card.task}
            sub={r.sub}
            {runner}
            {prefill}
            {measures}
            onvalidate={(sub, verdict, comment) =>
              onvalidate(card.task, sub, verdict, comment)}
            onreviewedit={onreviewedit &&
              ((sub, comment) => onreviewedit(card.task, sub, comment))}
          />
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
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--card);
    border: 1px solid var(--line-input);
    flex: none;
    display: inline-block;
  }
  /* The green thumbs-up hand marks a passed slot. */
  .hand-pass {
    height: 14px;
    flex: none;
  }
  .dot.fail {
    background: var(--danger-solid);
    border-color: var(--danger-solid);
  }
  .dot.review {
    background: var(--info-bg);
    border-color: var(--info);
  }
  .rlabel {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-soft);
    padding-bottom: 4px;
  }
  /* Wraps so the trailing controls stay visible in a narrow panel. */
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
