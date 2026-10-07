<!--
  A task's box in the side panel (SidePanel.svelte) of the campaign page, the
  review view and the pre-task editors: one continuous card — piece-tinted header with the task's
  name over its piece, status pill, submission, fails and the viewer's own
  review slot, and the action footer. Commands run through callbacks the
  host page passes in.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "$lib/components/Icon.svelte";
  import { auth } from "$lib/auth.svelte.ts";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import { findRow } from "$lib/campaign-tables.ts";
  import type { CommentRow, LockRow, StateRow } from "$lib/campaign-tables.ts";
  import type { FailComment, Result } from "$lib/commands.ts";
  import {
    handle,
    pageOfLocator,
    preTaskHref,
    claimLabel,
    workPlace,
  } from "$lib/campaign-graph.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import {
    buildRecord,
    cardPill,
    elapsed,
    initialOf,
    orphanedFails,
  } from "$lib/campaign-board.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import AbandonButton from "./AbandonButton.svelte";
  import TaskHeading from "./TaskHeading.svelte";
  import TaskRunState from "./TaskRunState.svelte";
  import ValidationRecord from "./ValidationRecord.svelte";

  let {
    card,
    pieceName,
    zone = 0,
    campaign,
    comments,
    locks,
    rows,
    logins,
    viewer,
    canPush,
    runner,
    editorError = null,
    primary = true,
    inView = false,
    tools,
    prefill,
    measures = true,
    onshowanchor,
    onclaim,
    oneditor,
    onabandon,
    onvalidate,
    onreviewedit,
    onresolve,
  }: {
    card: BoardCard;
    /** The display name of the task's piece. */
    pieceName: string;
    /** The piece's colour slot, 1-based (--zone-N); 0 takes --zone from the
        surrounding side panel. */
    zone?: number;
    campaign: string;
    comments: CommentRow[];
    locks: LockRow[];
    rows: StateRow[];
    logins: Record<string, string>;
    viewer: string;
    canPush: boolean;
    runner: CommandRunner;
    /** An error from the return from mei-friend; `label` names mei-friend
        when the text is its own message. */
    editorError?: { label: string; text: string } | null;
    /** The footer's action is the view's primary action (a solid button);
        otherwise an outline, beside a primary elsewhere in the view. */
    primary?: boolean;
    /** The box sits in the task's own view (the review view or the
        pre-task's editor): the footer leaves out the links to that view and
        offers only review actions. */
    inView?: boolean;
    /** The view's own controls, below the status row. */
    tools?: Snippet;
    /** The anchor a fresh fail form opens with; defaults to the task's page. */
    prefill?: () => { page: string; m1: string; m2: string };
    /** The fail form asks for a measure range besides the page. */
    measures?: boolean;
    /** Highlight a comment's measure range in the score. */
    onshowanchor: (c: CommentRow) => void;
    onclaim: (task_id: string, subtask_id: string) => Promise<unknown>;
    /** Claim or open the task in mei-friend; not used in the review view. */
    oneditor?: (task_id: string) => Promise<void>;
    /** Abandon the viewer's claim: the task's encoding ('' subtask) or a review slot. */
    onabandon: (task_id: string, subtask_id: string) => Promise<unknown>;
    onvalidate: (
      task_id: string,
      subtask_id: string,
      verdict: string,
      comment?: FailComment,
    ) => Promise<Result | null>;
    /** Switch the viewer's review to editing, with the fail comment. */
    onreviewedit: (
      task_id: string,
      subtask_id: string,
      comment: FailComment,
    ) => Promise<Result | null>;
    onresolve: (comment_id: string) => Promise<unknown>;
  } = $props();

  // A submission on this task still being processed: every action in the
  // footer holds until it lands.
  const processing = $derived(pendingVerdicts.taskProcessing(card.task));
  /** The viewer's encoding claim on the task, if any. */
  const myEncodingLock = $derived(
    viewer === ""
      ? undefined
      : locks.find(
          (l) =>
            l.task_id === card.task &&
            l.subtask_id === "" &&
            l.kind === "encoding" &&
            l.user_id === viewer,
        ),
  );
  const mineEncoding = $derived(myEncodingLock !== undefined);
  const record = $derived(buildRecord(card, comments, viewer, logins));
  /** The validation slot the viewer may claim right now, if any. */
  const claimableSub = $derived(
    record.find((r) => r.key === "open" && r.claimable)?.sub,
  );
  /** The review slot the viewer holds a lock on, if any. */
  const myReviewSub = $derived(record.find((r) => r.mine)?.sub);
  const myReview = $derived(myReviewSub !== undefined);
  /** What the side record shows: fails, the viewer's own slot, and for the
      owner the slots held and passed. */
  const hasRecord = $derived(
    record.some(
      (r) =>
        r.key === "fail" ||
        r.mine ||
        (canPush && (r.key === "review" || r.key === "pass")),
    ) || orphanedFails(card, comments).length > 0,
  );
  const editorRoute = $derived(preTaskHref(campaign, card.locator, card.task));
  const editorName = $derived(workPlace(card.locator));

  // The submitted encoding behind the card, for the Submission section.
  const taskState = $derived(findRow(rows, card.task, ""));
  const encoderLogin = $derived(
    taskState?.encoder ? handle(logins, taskState.encoder) : "",
  );

  // What the task asks of the volunteer, in one line: the panel is where a
  // touch screen reads it.
  const help = $derived.by(() => {
    if (card.column === "done") return "";
    if (card.column === "validation")
      return card.pre
        ? `Check the submitted work in the ${editorName} and approve it or request changes.`
        : inView
          ? "Compare the encoding with the scan and approve it or request changes."
          : "Compare the encoding with the scan in the review view and approve it or request changes.";
    if (card.locator === "score-setup")
      return "Set the score's staves, clefs, key signature and time signature from the source.";
    if (card.locator === "omr-layout")
      return "Check the staff and measure boxes on each page and correct the wrong ones.";
    if (card.locator === "measure-zones")
      return "Check the measure boxes on each page and correct the wrong ones.";
    if (card.omr)
      return "Correct the notes that optical music recognition (OMR) read from this page, in the mei-friend editor.";
    return card.scope
      ? "Encode the music of this page in the mei-friend editor."
      : "Encode the music of the piece in the mei-friend editor.";
  });

  // The task's page, prefilling a fail's anchor.
  const taskPage = $derived(String(pageOfLocator(card.locator) ?? ""));
</script>

<div class="taskcard" style={zone ? `--zone: var(--zone-${zone})` : ""}>
  <div class="tsphead">
    <TaskHeading
      description={card.description}
      scope={card.scope}
      piece={pieceName}
      task={canPush ? card.task : ""}
    />
  </div>
  <TaskRunState task={card.task} bar />
  {#if editorError}
    <div class="banner err bar">
      <span
        >{#if editorError.label}<b>{editorError.label}:</b
          >{" "}{/if}{editorError.text}</span
      >
    </div>
  {/if}
  <div class="statusrow">
    <span
      class="pill c-{card.column}"
      title={card.column === "blocked"
        ? `Waits for ${card.waitsFor}.`
        : card.column === "done"
          ? card.doneLine
          : card.keptFrom
            ? `${card.keptFrom}'s claim ran out with unsubmitted changes. The next claim continues from them.`
            : myEncodingLock && card.column === "encoding"
              ? `Your claim ends ${new Date(myEncodingLock.expires).toLocaleString()}. Submit before then; afterwards the task is open to others.`
              : undefined}>{cardPill(card, viewer)}</span
    >
    {#if help}
      <p class="help">{help}</p>
    {/if}
  </div>
  {@render tools?.()}
  {#if encoderLogin}
    <div class="section">
      <span class="seclbl">Submission</span>
      <div class="subline">
        <span class="avatar">{initialOf(encoderLogin)}</span>
        <span class="subtext"
          >encoded by <b>{encoderLogin}</b>{taskState?.encoded_at
            ? elapsed(taskState.encoded_at) === "now"
              ? " · just now"
              : ` · ${elapsed(taskState.encoded_at)} ago`
            : ""}</span
        >
      </div>
    </div>
  {/if}
  {#if hasRecord}
    <div class="section">
      <ValidationRecord
        {card}
        {comments}
        {locks}
        {viewer}
        {logins}
        {canPush}
        {runner}
        prefill={prefill ?? (() => ({ page: taskPage, m1: "", m2: "" }))}
        {measures}
        {onshowanchor}
        {onvalidate}
        {onreviewedit}
        {onresolve}
      />
    </div>
  {/if}
  <!-- The one action the viewer can take on this task in its current
           state; a task the viewer cannot work on gets no footer. -->
  {#if inView && card.column !== "validation"}
    <!-- The review view offers no work actions. -->
  {:else if card.column === "ready"}
    <div class="tspfoot">
      {#if card.pre}
        <a
          class="btn btn-pre"
          class:btn-primary={primary}
          href={processing ? undefined : editorRoute}
          aria-disabled={processing}
          title={`Claims the task for you and opens the ${editorName}.`}
          >{claimLabel(card.locator)}</a
        >
      {:else}
        <button
          type="button"
          class="btn btn-enc"
          class:btn-primary={primary}
          onclick={() => oneditor?.(card.task)}
          disabled={runner.busy || !auth.user || processing}
          title={auth.user
            ? "Claims the task for you, then opens the score in mei-friend."
            : "Log in to claim a task."}
          >{claimLabel(card.locator)} <Icon name="external" /></button
        >
      {/if}
    </div>
  {:else if card.column === "encoding"}
    {#if card.pre && card.worker?.mine}
      <div class="tspfoot">
        <a
          class="btn"
          class:btn-primary={primary}
          href={processing ? undefined : editorRoute}
          aria-disabled={processing}
          title={`Continue your work in the ${editorName}.`}
          >Continue in {editorName}</a
        >
        <AbandonButton
          disabled={runner.busy || processing}
          onabandon={() => onabandon(card.task, "")}
        />
      </div>
    {:else if mineEncoding}
      <div class="tspfoot">
        <button
          type="button"
          class="btn"
          class:btn-primary={primary}
          onclick={() => oneditor?.(card.task)}
          disabled={runner.busy || processing}
          title="Opens the score in mei-friend. Completing the task there submits it for review."
          >Open in mei-friend <Icon name="external" /></button
        >
        <AbandonButton
          disabled={runner.busy || processing}
          onabandon={() => onabandon(card.task, "")}
        />
      </div>
    {/if}
  {:else if card.column === "validation"}
    {#if claimableSub !== undefined}
      <div class="tspfoot">
        <button
          type="button"
          class="btn btn-review"
          class:btn-primary={primary}
          onclick={() => onclaim(card.task, claimableSub)}
          disabled={runner.busy || processing}
          title="Reserve this review slot.">Claim to review</button
        >
        {#if !card.pre && !inView}
          <a
            class="btn btn-soft"
            href={`/${campaign}/review/${card.task}`}
            title="Open the full-screen review view: score and facsimile side by side, with the verdict controls."
            >Open review view</a
          >
        {/if}
      </div>
    {:else if myReview}
      <div class="tspfoot">
        {#if inView}
          <!-- The review happens in this view. -->
        {:else if card.pre}
          <a
            class="btn"
            class:btn-primary={primary}
            href={processing ? undefined : editorRoute}
            aria-disabled={processing}
            title={`Review the submitted work in the ${editorName}.`}
            >Open {editorName}</a
          >
        {:else}
          <a
            class="btn"
            class:btn-primary={primary}
            href={processing ? undefined : `/${campaign}/review/${card.task}`}
            aria-disabled={processing}
            title="Open the full-screen review view: score and facsimile side by side, with the verdict controls."
            >Open review view</a
          >
        {/if}
        <AbandonButton
          review
          disabled={runner.busy || processing}
          onabandon={() => onabandon(card.task, myReviewSub ?? "")}
        />
      </div>
    {/if}
  {:else if card.column === "done" && card.pre}
    <div class="tspfoot">
      <a
        class="btn"
        href={editorRoute}
        title={`Open the accepted work in the ${editorName}, read-only.`}
        >View {editorName}</a
      >
    </div>
  {/if}
</div>

<style>
  .taskcard {
    background: var(--card);
    border: 1px solid color-mix(in srgb, var(--zone) 45%, var(--line));
    border-radius: 12px;
    overflow-x: hidden;
    box-shadow: var(--shadow-sm);
  }
  .tsphead {
    background: color-mix(in srgb, var(--zone) 10%, var(--card));
    border-bottom: 1px solid color-mix(in srgb, var(--zone) 25%, var(--line));
    padding: 9px 12px;
  }
  .statusrow {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 10px 12px;
  }
  .help {
    flex-basis: 100%;
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
    color: var(--ink-soft);
  }
  .section {
    padding: 10px 12px;
    border-top: 1px solid var(--hairline, var(--line));
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .seclbl {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-soft);
  }
  .subline {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--accent-btn);
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .subtext {
    font-size: 11.5px;
    color: var(--ink-soft);
  }
  .subtext b {
    color: var(--ink);
  }
  .tspfoot {
    padding: 10px 12px;
    border-top: 1px solid var(--hairline, var(--line));
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  /* At the panel's narrowest a long label wraps rather than widening it. */
  .tspfoot .btn {
    flex: 1;
    white-space: normal;
  }

  /* ---------------------------------------------------------------- pills */
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 600;
    font-size: 11px;
    line-height: 1;
    padding: 4px 10px;
    border-radius: 999px;
    white-space: nowrap;
    background: var(--bg-alt);
    border: 1px solid var(--line);
    color: var(--ink-faint);
  }
  .pill.c-encoding {
    background: var(--info-bg);
    border-color: var(--info-line);
    color: var(--info);
  }
  .pill.c-validation {
    background: var(--warn-bg);
    border-color: var(--warn-line);
    color: var(--warn);
  }
  .pill.c-done {
    background: var(--ok-bg);
    border-color: var(--ok-line);
    color: var(--ok);
  }
</style>
