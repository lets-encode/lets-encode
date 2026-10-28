<!--
  A task's box in the side panel (SidePanel.svelte) of the campaign page, the
  review view and the pre-task editors: one continuous card — piece-tinted header with the task's
  name over its piece, status pill, submission and the viewer's own review
  slot (docked, DOCKED_QUERY, the submission and others' reviews fold
  behind a disclosure), and the action footer. Commands run through callbacks the
  host page passes in.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import { DOCKED_QUERY } from "$lib/side-panels.ts";
  import Icon from "$lib/components/Icon.svelte";
  import { auth } from "$lib/auth.svelte.ts";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import { findRow } from "$lib/campaign-tables.ts";
  import type { LockRow, StateRow } from "$lib/campaign-tables.ts";
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
    stageOf,
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
    headAction,
    checks = [],
    onclaim,
    oneditor,
    onabandon,
  }: {
    card: BoardCard;
    /** The display name of the task's piece. */
    pieceName: string;
    /** The piece's colour slot, 1-based (--zone-N); 0 takes --zone from the
        surrounding side panel. */
    zone?: number;
    campaign: string;
    locks: LockRow[];
    rows: StateRow[];
    logins: Record<string, string>;
    viewer: string;
    canPush: boolean;
    runner: CommandRunner;
    /** An error from the return from mei-friend; `label` names mei-friend
        when the text is its own message, `confirm` offers the action the
        return did not take. */
    editorError?: {
      label: string;
      text: string;
      confirm?: { label: string; run: () => void };
    } | null;
    /** The footer's action is the view's primary action (a solid button);
        otherwise an outline, beside a primary elsewhere in the view. */
    primary?: boolean;
    /** The box sits in the task's own view (the review view or the
        pre-task's editor): the footer leaves out the links to that view, and
        Give back task goes to the view's side panel footer (ReviewActions),
        beside the verdict controls. */
    inView?: boolean;
    /** The view's own controls, below the status row. */
    tools?: Snippet;
    /** A control at the heading's right end (the side panel's comments
        button). */
    headAction?: Snippet;
    /** Why the task's page is to be checked against the scan
        (omr-page-checks.ts); none shows no mark. */
    checks?: string[];
    onclaim: (task_id: string, subtask_id: string) => Promise<unknown>;
    /** Claim or open the task in mei-friend; not used in the review view. */
    oneditor?: (task_id: string) => Promise<void>;
    /** Abandon the viewer's claim: the task's encoding ('' subtask) or a review slot. */
    onabandon: (task_id: string, subtask_id: string) => Promise<unknown>;
  } = $props();

  // A submission on this task still being processed: every action in the
  // footer holds until it lands.
  const processing = $derived(pendingVerdicts.taskProcessing(card.task));
  // A submission's run state takes the status pill's place while it shows.
  const runState = $derived(pendingVerdicts.forTask(card.task));
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
  const record = $derived(buildRecord(card, viewer, logins));
  /** The validation slot the viewer may claim right now, if any. */
  const claimableSub = $derived(
    record.find((r) => r.key === "open" && r.claimable)?.sub,
  );
  /** The review slot the viewer holds a lock on, if any. */
  const myReviewSub = $derived(record.find((r) => r.mine)?.sub);
  const myReview = $derived(myReviewSub !== undefined);
  /** What the side record shows: the viewer's own slot, and for the owner
      the slots held and passed. */
  const hasRecord = $derived(
    record.some(
      (r) => r.mine || (canPush && (r.key === "review" || r.key === "pass")),
    ),
  );
  // On a phone the submission and the reviews the viewer does not hold fold
  // away, leaving the task's comments room in the docked panel.
  const compact = new MediaQuery(DOCKED_QUERY, false);
  const foldRecord = $derived(compact.current && hasRecord && !myReview);
  const editorRoute = $derived(preTaskHref(campaign, card.locator, card.task));
  // The first page task of a piece whose instruments were named is claimed
  // and continued in the app's score check, which makes its draft.
  const checkRoute = $derived(`/${campaign}/check/${card.task}`);
  const editorName = $derived(workPlace(card.locator));

  // The submitted encoding behind the card, for the Submission section.
  const taskState = $derived(findRow(rows, card.task, ""));
  const encoderLogin = $derived(
    taskState?.encoder ? handle(logins, taskState.encoder) : "",
  );
  const foldLabel = $derived(
    encoderLogin && foldRecord
      ? "Submission and reviews"
      : encoderLogin
        ? "Submission"
        : foldRecord
          ? "Reviews"
          : "",
  );

  // What the task asks of the volunteer, and for the score setup how its
  // view is used: the panel is where a touch screen reads it.
  const help = $derived.by(() => {
    if (card.column === "done") return "";
    if (card.column === "validation") {
      // "page 1 of “Die Fledermaus”", "“Die Fledermaus”", "page 1", "".
      const page = pageOfLocator(card.locator);
      const piece = pieceName ? `“${pieceName}”` : "";
      const what = [page === null ? "" : `page ${page}`, piece]
        .filter(Boolean)
        .join(" of ");
      const encoding = what ? `the encoding of ${what}` : "the encoding";
      return taskState?.encoder === viewer && !claimableSub && !myReview
        ? "Another volunteer reviews your submission."
        : card.pre
          ? `Check the submitted work in the ${editorName} and approve it or request changes.`
          : inView
            ? `Compare ${encoding} with the scan and approve it or request changes.`
            : `Compare ${encoding} with the scan in the review view and approve it or request changes.`;
    }
    if (card.locator === "score-setup")
      return "Copy the staves, clefs, key signature and time signature from the source's first measure, shown with its staves level with the preview's; the divider between them resizes the two. In step 2, mark each brace or bracket by clicking or tapping its first and last staff in the preview.";
    if (card.locator === "omr-layout")
      return "Check the staff boxes, then the grand staves, then the measures on each page and correct the wrong ones.";
    if (card.locator === "measure-zones")
      return "Check the measure boxes on each page and correct the wrong ones.";
    if (card.omr)
      return "Correct the notes of this page's draft, read automatically from the scan, in the mei-friend editor.";
    return card.scope
      ? "Encode the music of this page in the mei-friend editor."
      : "Encode the music of the piece in the mei-friend editor.";
  });

  // The stage whose colour the box and its side panel take (ui.css).
  const stage = $derived(stageOf(card));
</script>

<div
  class="taskcard"
  data-stage={stage}
  style={zone ? `--zone: var(--zone-${zone})` : ""}
>
  <div class="tsphead">
    <TaskHeading
      description={card.description}
      scope={card.scope}
      piece={pieceName}
      task={canPush ? card.task : ""}
    />
    {@render headAction?.()}
  </div>
  {#if editorError}
    <div class="banner err bar">
      <span
        >{#if editorError.label}<b>{editorError.label}:</b
          >{" "}{/if}{editorError.text}</span
      >
      {#if editorError.confirm}
        <button
          type="button"
          class="btn btn-soft"
          disabled={runner.busy}
          onclick={editorError.confirm.run}>{editorError.confirm.label}</button
        >
      {/if}
    </div>
  {/if}
  <div class="statusrow">
    <TaskRunState task={card.task} pill />
    {#if !runState}
      <span
        class="chip"
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
    {/if}
    {#if checks.length && card.column !== "done"}
      <span
        class="chip chip-note"
        title={`Check the clefs, key, meter and staves of this page against the scan. ${checks.join(" ")}`}
        >Check</span
      >
    {/if}
    {#if help}
      <p class="help">{help}</p>
    {/if}
  </div>
  {@render tools?.()}
  {#snippet submission()}
    <div class="section">
      <span class="seclbl">Submission</span>
      <div class="subline">
        <span class="avatar">{initialOf(encoderLogin)}</span>
        <span class="subtext"
          >submitted by <b>{encoderLogin}</b>{taskState?.encoded_at
            ? elapsed(taskState.encoded_at) === "now"
              ? " · just now"
              : ` · ${elapsed(taskState.encoded_at)} ago`
            : ""}</span
        >
      </div>
    </div>
  {/snippet}
  {#snippet reviewRecord()}
    <div class="section">
      <ValidationRecord {card} {locks} {viewer} {logins} {canPush} />
    </div>
  {/snippet}
  {#if compact.current && foldLabel}
    <details class="more">
      <summary><span>{foldLabel}</span><Icon name="chevron-down" /></summary>
      {#if encoderLogin}{@render submission()}{/if}
      {#if foldRecord}{@render reviewRecord()}{/if}
    </details>
    {#if hasRecord && !foldRecord}{@render reviewRecord()}{/if}
  {:else}
    {#if encoderLogin}{@render submission()}{/if}
    {#if hasRecord}{@render reviewRecord()}{/if}
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
      {:else if card.checksOpening}
        <a
          class="btn btn-enc"
          class:btn-primary={primary}
          href={processing ? undefined : checkRoute}
          aria-disabled={processing}
          title="Claims the task for you and opens the score check: the clefs, key signatures, meter and transpositions of the score's staves, before the draft opens in mei-friend."
          >Claim & open score check</a
        >
      {:else}
        <button
          type="button"
          class="btn btn-enc"
          class:btn-primary={primary}
          onclick={() => oneditor?.(card.task)}
          disabled={runner.busy || !auth.user || processing}
          title={auth.user
            ? "Claims this task for you and opens the score in mei-friend."
            : "Log in with GitHub to claim a task."}
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
    {:else if mineEncoding && card.checksOpening}
      <div class="tspfoot">
        <a
          class="btn"
          class:btn-primary={primary}
          href={processing ? undefined : checkRoute}
          aria-disabled={processing}
          title="Continue in the score check, which opens the draft in mei-friend."
          >Continue in score check</a
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
          title="Claims a review of this task for you.">Claim to review</button
        >
        {#if !card.pre && !inView}
          <a
            class="btn btn-soft"
            href={`/${campaign}/review/${card.task}`}
            title="Open the full-screen review view: score and facsimile side by side, with the Approve and Request changes buttons."
            >Open review</a
          >
        {/if}
      </div>
    {:else if myReview && !inView}
      <div class="tspfoot">
        {#if card.pre}
          <a
            class="btn"
            class:btn-primary={primary}
            href={processing ? undefined : editorRoute}
            aria-disabled={processing}
            title={`Review the submitted work in the ${editorName}.`}
            >Continue in {editorName}</a
          >
        {:else}
          <a
            class="btn"
            class:btn-primary={primary}
            href={processing ? undefined : `/${campaign}/review/${card.task}`}
            aria-disabled={processing}
            title="Open the full-screen review view: score and facsimile side by side, with the Approve and Request changes buttons."
            >Continue in review</a
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
  /* The box is the top of its side panel's sheet (SidePanel): the heading
     and status in the stage's wash, the submission, reviews and actions on
     slate below, each section under a hairline. Buttons sit on paper. */
  .taskcard {
    overflow-x: hidden;
    --btn-bg: var(--card);
    --btn-shadow: 0 1px 2px rgba(31, 36, 51, 0.1);
    --btn-bg-hover: color-mix(in srgb, var(--ink) 5%, var(--card));
  }
  /* The heading's width is a container (taskhead), so a control at its
     right end can drop its label where the heading is narrow. */
  .tsphead {
    container: taskhead / inline-size;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    background: var(--st-wash);
    padding: 10px 16px 4px;
  }
  .tsphead > :global(.taskheading) {
    flex: 1;
  }
  .statusrow {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 6px 16px 14px;
    background: var(--st-wash);
  }
  .help {
    flex-basis: 100%;
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
    color: var(--ink-soft);
  }
  .section {
    padding: 12px 16px;
    background: var(--band);
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .more {
    background: var(--band);
    border-top: 1px solid var(--line);
  }
  .more summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 36px;
    padding: 0 16px;
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-soft);
    cursor: pointer;
    list-style: none;
  }
  .more summary::-webkit-details-marker {
    display: none;
  }
  .more summary :global(svg) {
    transition: transform 160ms ease-out;
  }
  .more[open] summary :global(svg) {
    transform: rotate(180deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .more summary :global(svg) {
      transition: none;
    }
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
    padding: 12px 16px;
    background: var(--band);
    border-top: 1px solid var(--line);
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  /* Buttons share the row while their labels fit on one line, else each
     takes its own; a label longer than the panel wraps rather than widening
     it. */
  .tspfoot .btn {
    flex: 1 1 auto;
    white-space: normal;
  }
  .tspfoot .btn {
    padding-block: 4px;
  }
  /* On a touch screen the 32px buttons take a 44px press through an
     invisible ::after. */
  @media (pointer: coarse) {
    .tspfoot .btn {
      position: relative;
    }
    .tspfoot .btn::after {
      content: "";
      position: absolute;
      inset: -6px;
    }
  }
</style>
