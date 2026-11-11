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
  import Notice, { splitMessage } from "$lib/components/Notice.svelte";
  import { auth } from "$lib/auth.svelte.ts";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import { findRow } from "$lib/campaign-tables.ts";
  import type { LockRow, StateRow } from "$lib/campaign-tables.ts";
  import {
    handle,
    pageOfLocator,
    preTaskHref,
    preTaskInstruction,
    reviewViewHref,
    taskAction,
    taskActionHref,
    workPlace,
  } from "$lib/campaign-graph.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import { REASON_TEXT } from "$lib/coordinator-policy.ts";
  import { encodingClaimOf } from "$lib/campaign-claim.ts";
  import {
    buildRecord,
    cardPill,
    timeAgo,
    initialOf,
    stageOf,
  } from "$lib/campaign-board.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import AbandonButton from "./AbandonButton.svelte";
  import TaskHeading from "./TaskHeading.svelte";
  import TaskRunState from "./TaskRunState.svelte";
  import ValidationRecord from "./ValidationRecord.svelte";

  let {
    repoId,
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
    changeRequestUrl,
    inView = false,
    tools,
    headAction,
    checks = [],
    checksFailed = false,
    onclaim,
    oneditor,
    onabandon,
  }: {
    /** The campaign's repository id; task ids repeat across campaigns. */
    repoId: number;
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
    /** The web address of the campaign's pull request `number`, for the
        link of a rejected submission. */
    changeRequestUrl?: (number: number) => string;
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
    /** The page checks could not be read. */
    checksFailed?: boolean;
    onclaim: (task_id: string, subtask_id: string) => Promise<unknown>;
    /** Claim or open the task in mei-friend; not used in the review view. */
    oneditor?: (task_id: string) => Promise<void>;
    /** Abandon the viewer's claim: the task's encoding ('' subtask) or a review slot. */
    onabandon: (task_id: string, subtask_id: string) => Promise<unknown>;
  } = $props();

  // A submission on this task still being processed: every action in the
  // footer holds until it lands.
  const processing = $derived(
    pendingVerdicts.taskProcessing(card.task, repoId),
  );
  // A submission's run state takes the status pill's place while it shows.
  const runState = $derived(pendingVerdicts.forTask(card.task, repoId));
  /** The viewer's encoding claim on the task, if any. */
  const myEncodingLock = $derived(encodingClaimOf(locks, card.task, viewer));
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
    if (card.pre) return preTaskInstruction(card.locator, true);
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
  class="taskcard on-tint"
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
  <div class="statusrow">
    <TaskRunState task={card.task} {repoId} pill />
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
    {:else if checksFailed && card.column !== "done"}
      <span
        class="chip chip-note"
        title="The checks of this page against the scan could not be read. Reload the page to try again."
        >Checks not read</span
      >
    {/if}
    {#if help}
      <p class="help">{help}</p>
    {/if}
  </div>
  {#if card.rejected && !runState}
    {@const { pr, reason } = card.rejected}
    {@const why = REASON_TEXT[reason] ?? reason}
    {#snippet rejectedTitle()}
      Submission {#if changeRequestUrl && pr}<a
          href={changeRequestUrl(Number(pr))}
          target="_blank"
          rel="noreferrer">#{pr}</a
        >{:else if pr}#{pr}{/if} rejected
    {/snippet}
    <Notice
      tone="err"
      surface="inline"
      title={rejectedTitle}
      detail={`${why.charAt(0).toUpperCase()}${why.slice(1)}.`}
    />
  {/if}
  {#if editorError}
    {@const text = editorError.label
      ? { title: editorError.label, detail: editorError.text }
      : splitMessage(editorError.text)}
    <Notice
      tone="err"
      surface="inline"
      title={text.title}
      detail={text.detail}
      action={editorError.confirm
        ? {
            label: editorError.confirm.label,
            run: editorError.confirm.run,
            disabled: runner.busy,
          }
        : undefined}
    />
  {/if}
  {@render tools?.()}
  {#snippet submission()}
    <div class="section">
      <span class="seclbl">Submission</span>
      <div class="subline">
        <span class="avatar">{initialOf(encoderLogin)}</span>
        <span class="subtext"
          >submitted by <b>{encoderLogin}</b>{timeAgo(
            taskState?.encoded_at ?? "",
          )
            ? ` · ${timeAgo(taskState?.encoded_at ?? "")}`
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
    {@const act = taskAction(card, "claim")}
    <div class="tspfoot">
      {#if act.target === "mei-friend"}
        <button
          type="button"
          class="btn btn-primary btn-{act.stage}"
          onclick={() => oneditor?.(card.task)}
          disabled={runner.busy || !auth.user || processing}
          title={auth.user ? act.title : "Log in with GitHub to claim a task."}
          >{act.label} <Icon name="external" /></button
        >
      {:else}
        <a
          class="btn btn-primary btn-{act.stage}"
          href={processing
            ? undefined
            : (taskActionHref(campaign, card, act) ?? undefined)}
          aria-disabled={processing}
          title={act.title}>{act.label}</a
        >
      {/if}
    </div>
  {:else if card.column === "encoding"}
    {#if (card.pre && card.worker?.mine) || (!card.pre && mineEncoding)}
      {@const act = taskAction(card, "continue")}
      <div class="tspfoot">
        {#if act.target === "mei-friend"}
          <button
            type="button"
            class="btn btn-primary"
            onclick={() => oneditor?.(card.task)}
            disabled={runner.busy || processing}
            title={act.title}>{act.label} <Icon name="external" /></button
          >
        {:else}
          <a
            class="btn btn-primary"
            href={processing
              ? undefined
              : (taskActionHref(campaign, card, act) ?? undefined)}
            aria-disabled={processing}
            title={act.title}>{act.label}</a
          >
        {/if}
        <AbandonButton
          disabled={runner.busy || processing}
          onabandon={() => onabandon(card.task, "")}
        />
      </div>
    {/if}
  {:else if card.column === "validation"}
    {#if claimableSub !== undefined}
      {@const act = taskAction(card, "claim-review")}
      <div class="tspfoot">
        <button
          type="button"
          class="btn btn-primary btn-{act.stage}"
          onclick={() => onclaim(card.task, claimableSub)}
          disabled={runner.busy || processing}
          title={act.title}>{act.label}</button
        >
        {#if !card.pre && !inView}
          <a
            class="btn btn-soft"
            href={reviewViewHref(campaign, card.task)}
            title="Open the full-screen review view: score and facsimile side by side, with the Approve and Request changes buttons."
            >Open review</a
          >
        {/if}
      </div>
    {:else if myReview && !inView}
      {@const act = taskAction(card, "continue-review")}
      <div class="tspfoot">
        <a
          class="btn btn-primary"
          href={processing
            ? undefined
            : (taskActionHref(campaign, card, act) ?? undefined)}
          aria-disabled={processing}
          title={act.title}>{act.label}</a
        >
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
