<!--
  A task's validation record in its task box: the viewer's own slot with its
  approve/request-changes/edit controls and the note form a change request or
  an edit fills in, and for the owner (canPush) also the slots held and
  passed under a "Reviews" heading. Change requests are listed with the
  task's comments in the side panel. The host's status pill
  carries the slot count and its footer the claim. Commands run through
  callbacks the host passes in.
-->
<script lang="ts">
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { LockRow } from "$lib/campaign-tables.ts";
  import type { FailComment, Result } from "$lib/commands.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import { buildRecord, expiresIn } from "$lib/campaign-board.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";

  let {
    card,
    locks = [],
    viewer,
    logins,
    canPush,
    runner,
    prefill,
    measures = true,
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
  // A submission on this task still being processed (a claim or verdict):
  // the slot controls hold until it lands — a repeat would only
  // be rejected.
  const processing = $derived(pendingVerdicts.taskProcessing(card.task));

  // The inline form a fail verdict or an edit from review fills in (its
  // mandatory comment).
  let failForm = $state<{
    sub: string;
    body: string;
    page: string;
    m1: string;
    m2: string;
  } | null>(null);

  async function submitFail(edit: boolean) {
    if (!failForm || !failForm.body.trim()) return;
    const form = failForm;
    const comment = {
      body: form.body,
      page: form.page.trim(),
      measure_start: form.m1.trim(),
      measure_end: form.m2.trim(),
    };
    const result = edit
      ? await onreviewedit?.(card.task, form.sub, comment)
      : await onvalidate(card.task, form.sub, "fail", comment);
    if (result?.ok) failForm = null;
  }
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
        {:else if r.mine}
          <span class="rverdict">
            <button
              type="button"
              class="btn btn-primary btn-finish"
              onclick={() => onvalidate(card.task, r.sub, "pass")}
              disabled={runner.busy || processing}
              title="Approve the submitted work.">Approve</button
            >
            <button
              type="button"
              class="btn btn-danger failbtn"
              class:on={failForm?.sub === r.sub}
              onclick={() =>
                (failForm =
                  failForm?.sub === r.sub
                    ? null
                    : { sub: r.sub, body: "", ...prefill() })}
              disabled={runner.busy || processing}
              title="Ask for changes — a request carries a note saying what needs to change."
              >Request changes</button
            >
          </span>
        {/if}
      </div>
      {#if failForm && failForm.sub === r.sub && r.mine}
        <div class="failform">
          <textarea
            rows="3"
            bind:value={failForm.body}
            placeholder="What needs to change? (required)"
          ></textarea>
          <div class="failform-anchor">
            <label>p. <input size="3" bind:value={failForm.page} /></label>
            {#if measures}
              <label
                >m. <input
                  size="4"
                  bind:value={failForm.m1}
                  placeholder="from"
                /></label
              >
              <label
                >– <input
                  size="4"
                  bind:value={failForm.m2}
                  placeholder="to"
                /></label
              >
            {/if}
            <span class="mspacer"></span>
            {#if onreviewedit}
              <button
                type="button"
                class="btn"
                onclick={() => submitFail(true)}
                disabled={runner.busy || !failForm.body.trim() || processing}
                title="Requests changes with this note and gives you the task to edit. Your edit is then reviewed by someone else."
                >Edit yourself</button
              >
            {/if}
            <button
              type="button"
              class="btn btn-danger"
              onclick={() => submitFail(false)}
              disabled={runner.busy || !failForm.body.trim() || processing}
              title="Sends the change request with this note."
              >Send request</button
            >
          </div>
          {#if onreviewedit}
            <p class="editnote">
              Edit yourself gives you the task to edit. Your edit is then
              reviewed by someone else.
            </p>
          {/if}
        </div>
      {/if}
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
    border-bottom: 1px solid var(--hairline);
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
  /* The verdict pair fills its own line as two equal cells. */
  .rverdict {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    flex-basis: 100%;
  }
  /* The open fail form keeps its trigger tinted, still an outline. */
  .failbtn.on {
    background: var(--danger-bg);
    border-color: var(--danger);
  }
  .failform {
    border: 1px solid var(--danger-line);
    border-radius: 10px;
    padding: 10px 12px;
    margin: 8px 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--danger-wash);
  }
  .failform textarea {
    font: inherit;
    font-size: 12.5px;
    padding: 7px 10px;
    border: 1px solid var(--line-input);
    border-radius: 8px;
    background: var(--card);
    color: var(--ink);
    resize: vertical;
  }
  .editnote {
    margin: 0;
    font-size: 11.5px;
    color: var(--ink-soft);
  }
  .failform-anchor {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    color: var(--ink-soft);
    flex-wrap: wrap;
  }
  .failform-anchor input {
    font: inherit;
    font-size: 11.5px;
    padding: 3px 6px;
    border: 1px solid var(--line-input);
    border-radius: 6px;
    background: var(--card);
    color: var(--ink);
    width: 3.2em;
  }
</style>
