<!--
  The verdict controls of the review slot the viewer holds: Approve, Request
  changes and the note form a change request or an edit from review fills
  in. In a task's own view they sit in the side panel's footer with Give back
  task (onabandon) at the row's start, Approve at its end; in a task box
  (ValidationRecord) they fill the slot's row as two equal cells. With
  `staffs` the note form has a staff field, which the host fills from a
  click on a staff or group (staffPick) and which leads the note when sent.
  Commands run through callbacks the host passes in.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { FailComment, Result } from "$lib/commands.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import AbandonButton from "./AbandonButton.svelte";

  let {
    task,
    sub,
    runner,
    prefill,
    measures = true,
    staffs = false,
    staffPick = null,
    asking = $bindable(false),
    onvalidate,
    onreviewedit,
    onabandon,
  }: {
    task: string;
    /** The review slot the viewer holds. */
    sub: string;
    runner: CommandRunner;
    /** The anchor a fresh fail form opens with (page and measure range). */
    prefill: () => { page: string; m1: string; m2: string };
    /** The fail form asks for a measure range besides the page. */
    measures?: boolean;
    /** The fail form asks which staff or staves the request concerns. */
    staffs?: boolean;
    /** The staff or group the viewer last clicked, e.g. "3 (Violine I)" or
        "2–4 (brace)"; a new object for each click. */
    staffPick?: { text: string } | null;
    /** The note form is open. */
    asking?: boolean;
    onvalidate: (
      sub: string,
      verdict: string,
      comment?: FailComment,
    ) => Promise<Result | null>;
    /** Switch the viewer's review to editing; no Edit button without it. */
    onreviewedit?: (
      sub: string,
      comment: FailComment,
    ) => Promise<Result | null>;
    /** Give back the review; the footer form shows Give back task with it. */
    onabandon?: (sub: string) => void;
  } = $props();

  // A submission on this task still being processed (a claim or verdict):
  // the controls hold until it lands — a repeat would only be rejected.
  const processing = $derived(pendingVerdicts.taskProcessing(task));

  // The inline form a fail verdict or an edit from review fills in (its
  // mandatory comment).
  let failForm = $state<{
    body: string;
    staff: string;
    page: string;
    m1: string;
    m2: string;
  } | null>(null);

  $effect(() => {
    asking = failForm !== null;
  });
  // A click on a staff or group while the form is open fills the field.
  $effect(() => {
    const pick = staffPick;
    untrack(() => {
      if (pick && failForm) failForm.staff = pick.text;
    });
  });
  /** The note with its staff in front: "Staff 3 (Violine I): …". A field
      typed starting with a word is put in front as it is. */
  function withStaff(staff: string, body: string): string {
    const s = staff.trim();
    if (!s) return body;
    const lead = /^\d/.test(s)
      ? `${/^\d+\s*[–-]\s*\d/.test(s) ? "Staves" : "Staff"} ${s}`
      : s;
    return `${lead}: ${body}`;
  }

  async function submitFail(edit: boolean) {
    if (!failForm || !failForm.body.trim()) return;
    const form = failForm;
    const comment = {
      body: withStaff(form.staff, form.body),
      page: form.page.trim(),
      measure_start: form.m1.trim(),
      measure_end: form.m2.trim(),
    };
    const result = edit
      ? await onreviewedit?.(sub, comment)
      : await onvalidate(sub, "fail", comment);
    if (result?.ok) failForm = null;
  }
</script>

<div class="ractions" class:infoot={!!onabandon}>
  {#if onabandon}
    <AbandonButton
      review
      disabled={runner.busy || processing}
      onabandon={() => onabandon(sub)}
    />
  {/if}
  <span class="rverdict">
    <button
      type="button"
      class="btn btn-primary btn-finish approve"
      onclick={() => onvalidate(sub, "pass")}
      disabled={runner.busy || processing}
      title="Approve the submitted work.">Approve</button
    >
    <button
      type="button"
      class="btn btn-danger failbtn"
      class:on={!!failForm}
      onclick={() =>
        (failForm = failForm ? null : { body: "", staff: "", ...prefill() })}
      disabled={runner.busy || processing}
      title="Ask for changes — a request carries a note saying what needs to change."
      >Request changes</button
    >
  </span>
  {#if failForm}
    <div class="failform">
      <textarea
        rows="3"
        bind:value={failForm.body}
        placeholder="What needs to change? (required)"
      ></textarea>
      <div class="failform-anchor">
        <label>p. <input size="3" bind:value={failForm.page} /></label>
        {#if staffs}
          <label
            >staff <input
              class="staffin"
              bind:value={failForm.staff}
              placeholder="click a staff or group"
              title="Click a staff on the page or in the summary, or a brace or bracket in the summary, to fill this in. It is put in front of the note."
            /></label
          >
        {/if}
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
          title="Sends the change request with this note.">Send request</button
        >
      </div>
      {#if onreviewedit}
        <p class="editnote">
          Edit yourself gives you the task to edit. Your edit is then reviewed
          by someone else.
        </p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .ractions {
    flex-basis: 100%;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .mspacer {
    flex: 1;
  }
  /* The verdict pair fills its own line as two equal cells. */
  .rverdict {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    flex-basis: 100%;
  }
  /* In the footer: Give back task at the start, Request changes and then
     Approve at the end, as the editor's footer ends with its step's button;
     a narrow panel puts the pair on a line of its own. */
  .infoot .rverdict {
    display: flex;
    flex-basis: auto;
    margin-left: auto;
  }
  .infoot .approve {
    order: 2;
  }
  .infoot .failform {
    order: -1;
    flex-basis: 100%;
    margin: 0;
  }
  /* The open fail form keeps its trigger tinted, still an outline. */
  .failbtn.on {
    background: var(--danger-bg);
    border-color: var(--danger);
  }
  .failform {
    flex-basis: 100%;
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
  .failform-anchor .staffin {
    width: 12em;
  }
</style>
