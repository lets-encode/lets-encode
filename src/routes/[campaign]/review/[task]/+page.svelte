<!--
  The review view: a full-screen surface for validating an encoding task. The
  score fills the window, facsimile and rendered encoding side by side, and
  the side panel on the right carries the task box — the campaign page's
  TaskBox with the verdict controls — pinned above the task's comments.
  Clicking a measure in either pane highlights it in both and prefills the
  fail form's anchor. Pre-tasks are reviewed in their own editors, not here.
-->
<script lang="ts">
  import { page } from "$app/state";
  import { recordCampaignTitle } from "$lib/campaign-title.svelte.ts";
  import { goto } from "$app/navigation";
  import { auth, login, forge } from "$lib/auth.svelte.ts";
  import type { ForgeClient } from "$lib/forge/types.ts";
  import {
    CommandRunner,
    readForge,
    viewerId,
  } from "$lib/command-runner.svelte.ts";
  import { commands, invoke, commentInput } from "$lib/commands.ts";
  import type { CommandContext, Result, FailComment } from "$lib/commands.ts";
  import { CampaignResolution } from "$lib/campaign-resolution.svelte.ts";
  import { campaignLoadFailure } from "$lib/campaign-resolve.ts";
  import {
    findRow,
    pieceNamesOf,
    piecePreparationsOf,
    commentAnchor,
    type MeasureAnchor,
  } from "$lib/campaign-tables.ts";
  import type {
    TaskRow,
    StateRow,
    LockRow,
    HistoryRow,
    CommentRow,
    PieceRef,
  } from "$lib/campaign-tables.ts";
  import { pageOfLocator, preTaskRoute } from "$lib/campaign-graph.ts";
  import { buildBoard } from "$lib/campaign-board.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import { readSidePanel } from "$lib/side-panels.ts";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import RunnerBanner from "$lib/components/RunnerBanner.svelte";
  import TaskPageSidePanel from "$lib/components/TaskPageSidePanel.svelte";
  import ScorePreview from "$lib/components/ScorePreview.svelte";
  import TaskBox from "$lib/components/TaskBox.svelte";

  // The URL carries the campaign name and task; the repo is resolved from the
  // name (name → stable repo id → current owner/name) — see resolveCampaign.
  const campaign = $derived(page.params.campaign!);
  const taskId = $derived(page.params.task!);
  const place = new CampaignResolution(() => campaign);
  const owner = $derived(place.owner);
  const repo = $derived(place.repo);
  const repoId = $derived(place.repoId);
  // The acting user's stable numeric id; login is display-only.
  const viewer = $derived(viewerId());

  let loading = $state(false);
  let loaded = $state(false);
  let loadError = $state<string | null>(null);
  let notInitialised = $state(false);
  let canPush = $state(false);
  let taskDefs = $state<TaskRow[]>([]);
  let rows = $state<StateRow[]>([]);
  let validationColumns = $state<string[]>([]);
  let locks = $state<LockRow[]>([]);
  let history = $state<HistoryRow[]>([]);
  let comments = $state<CommentRow[]>([]);
  let pieces = $state<PieceRef[]>([]);
  let logins = $state<Record<string, string>>({});
  let passThreshold = $state(1);
  let allowSelfValidation = $state(false);

  const runner = new CommandRunner();

  const board = $derived(
    buildBoard(
      {
        taskDefs,
        rows,
        validationColumns,
        locks,
        passThreshold,
        allowSelfValidation,
      },
      comments,
      history,
      viewer,
      logins,
      pieceNamesOf(pieces),
      undefined,
      piecePreparationsOf(pieces),
    ),
  );
  const card = $derived(
    board.columns.flatMap((c) => c.cards).find((c) => c.task === taskId) ??
      null,
  );
  const taskDef = $derived(findRow(taskDefs, taskId, ""));
  const fragment = $derived(taskDef?.fragment ?? "");
  /** The page a per-page task opens at, 0-based; null for a whole-piece task. */
  const taskPage = $derived.by(() => {
    const p = pageOfLocator(taskDef?.locator ?? "");
    return p ? p - 1 : null;
  });
  const startPage = $derived(taskPage ?? 0);

  // The score viewer, bound for the anchor jump and the fail-form prefill.
  let preview = $state<ReturnType<typeof ScorePreview>>();
  // The score column's width, padding included: where the preview inside it
  // is narrower than 560px (the preview's narrow width, a phone) the review
  // opens on the facsimile alone instead of side by side.
  let scoreW = $state(0);
  // The measure selected in the viewer, reported back for the fail form.
  let selectedMeasure = $state<string | null>(null);
  // The measure range a fail comment refers to, highlighted in both panes.
  let anchor = $state<MeasureAnchor | null>(null);
  function showAnchorFor(c: CommentRow) {
    anchor = commentAnchor(c);
    preview?.setZones(true);
    preview?.showPage(anchor.page - 1);
  }
  // A fresh fail form opens anchored to what the viewer is looking at.
  const prefill = () => ({
    page: String((preview?.currentPage() ?? 0) + 1),
    m1: selectedMeasure ?? "",
    m2: selectedMeasure ?? "",
  });

  // The side panel beside the score; the tables it reads are the ones this
  // page already loads.
  let sidePanel = $state(readSidePanel());
  const panelTables = $derived({
    taskDefs,
    comments,
    pieces,
    logins,
    canPush,
  });

  const ctx = (f: ForgeClient): CommandContext =>
    runner.context(f, { repoId, owner, repo });

  // Read the tracking tables for the task's record, discussion and controls.
  // Only the first read shows the loading state; refreshes update in place.
  async function load() {
    const f = readForge();
    const name = campaign;
    if (!loaded) loading = true;
    loadError = null;
    try {
      const tables = await invoke(commands.readTables, {}, ctx(f));
      if (name !== campaign) return;
      notInitialised = tables.notInitialised;
      recordCampaignTitle(name, tables.title);
      canPush = tables.canPush;
      taskDefs = tables.taskDefs;
      rows = tables.rows;
      validationColumns = tables.validationColumns;
      locks = tables.locks;
      history = tables.history;
      comments = tables.comments;
      pieces = tables.pieces;
      logins = tables.logins;
      passThreshold = tables.passThreshold;
      allowSelfValidation = tables.allowSelfValidation;
      loaded = true;
    } catch (e) {
      if (name === campaign) loadError = campaignLoadFailure(e);
    } finally {
      if (name === campaign) loading = false;
    }
  }

  // A same-route navigation to another campaign or task starts over.
  $effect(() => {
    void campaign;
    void taskId;
    loaded = false;
    loadError = null;
    anchor = null;
    selectedMeasure = null;
  });

  $effect(() => {
    if (auth.status !== "loading" && owner && repo && !loaded) load();
  });

  // Background verdicts refresh the tables when they land — unless a command
  // overlay is up, whose own after-refresh will catch the change.
  $effect(() =>
    pendingVerdicts.onSettled(() => {
      if (!runner.busy && owner && repo) load();
    }),
  );

  // Run a command: show the busy overlay, capture its result banner, then
  // refresh the tables. A verdict or send-back returns to the campaign page,
  // where its run state shows on the task.
  async function run(
    command: (c: CommandContext) => Promise<Result>,
    opts: { overviewOnSuccess?: boolean } = {},
  ) {
    const f = forge();
    if (!f) return null;
    return runner.run(
      () => command(ctx(f)),
      async (result) => {
        if (result.error) return;
        if (opts.overviewOnSuccess) {
          if (result.ok && !result.warn) await goto(`/${campaign}`);
          return;
        }
        // A background command changed nothing yet — the settle listener
        // refreshes when its verdict lands.
        if (result.background) return;
        runner.log.step("Refreshing tables…");
        await load();
      },
    );
  }

  const claim = (task_id: string, subtask_id: string) =>
    run((c) => invoke(commands.claimValidation, { task_id, subtask_id }, c));

  const validate = (
    task_id: string,
    subtask_id: string,
    verdict: string,
    comment?: FailComment,
  ) =>
    run(
      (c) =>
        invoke(
          commands.submitValidation,
          { task_id, subtask_id, verdict, ...(comment ? { comment } : {}) },
          c,
        ),
      { overviewOnSuccess: true },
    );

  const giveBack = (task_id: string, subtask_id: string) =>
    run((c) => invoke(commands.giveBack, { task_id, subtask_id }, c), {
      overviewOnSuccess: true,
    });

  const sendBackTask = (task_id: string) =>
    run((c) => invoke(commands.sendBack, { task_id }, c), {
      overviewOnSuccess: true,
    });

  const postComment = (
    task_id: string,
    kind: string,
    body: string,
    parent_id: string,
  ) =>
    run((c) =>
      invoke(
        commands.submitComment,
        commentInput(task_id, kind, body, parent_id),
        c,
      ),
    );

  const resolveCommentRow = (comment_id: string) =>
    run((c) => invoke(commands.resolveComment, { comment_id }, c));
</script>

<svelte:head>
  <title>{card ? card.title : "Review"} · Let's Encode!</title>
</svelte:head>

{#if runner.busy && runner.overlay}
  <LoadingOverlay
    log={runner.log}
    finished={runner.held}
    error={runner.result?.error}
    onContinue={() => runner.dismiss()}
  />
{/if}

{#snippet resultBanner()}
  <RunnerBanner {runner} bar />
{/snippet}

<div class="review sidehost">
  {#if auth.status === "loading"}
    <p class="msg muted">Loading…</p>
  {:else if place.error}
    <div class="msg banner err">
      <span>
        {place.error}
        <button type="button" class="linkish" onclick={() => place.retry()}
          >Try again</button
        >
      </span>
    </div>
  {:else if place.notFound}
    <div class="msg banner err">
      <span>
        No campaign called <code>{campaign}</code> was found.
        <a href="/campaigns">Back to all campaigns</a>.
      </span>
    </div>
  {:else if !place.resolved || loading}
    <p class="msg muted">Loading the task…</p>
  {:else if loadError}
    <div class="msg banner err"><span>{loadError}</span></div>
  {:else if notInitialised}
    <div class="msg banner err">
      <span>
        This repository has no tracking tables yet.
        <a href={`/${campaign}`}>Back to the campaign</a>.
      </span>
    </div>
  {:else if !card || !taskDef}
    <div class="msg banner err">
      <span>
        No task called <code>{taskId}</code> was found in this campaign.
        <a href={`/${campaign}`}>Back to the campaign</a>.
      </span>
    </div>
  {:else if card.pre}
    <div class="msg banner warn">
      <span>
        {card.title} is reviewed in its own editor.
        <a href={`/${campaign}/${preTaskRoute(card.locator)}/${card.task}`}
          >Open it</a
        >.
      </span>
    </div>
  {:else}
    {#snippet taskBox()}
      <TaskBox
        {card}
        pieceName={card.piece}
        {campaign}
        {comments}
        {locks}
        {rows}
        {logins}
        {viewer}
        {canPush}
        {runner}
        inReview
        {prefill}
        onshowanchor={showAnchorFor}
        onclaim={claim}
        ongiveback={giveBack}
        onvalidate={validate}
        onresolve={resolveCommentRow}
        onsendback={sendBackTask}
      />
    {/snippet}
    <div class="scorecol" bind:clientWidth={scoreW}>
      {#if !auth.user}
        <div class="banner warn">
          <span>
            {#if auth.expired}Your GitHub login has expired.{/if}
            Viewing read-only.
            <button type="button" class="linkish" onclick={() => login()}
              >Log in with GitHub</button
            >
            to review.
          </span>
        </div>
      {/if}
      {#if fragment}
        {#if scoreW > 0}
          <ScorePreview
            bind:this={preview}
            {owner}
            {repo}
            {fragment}
            {startPage}
            {anchor}
            initialPane={scoreW - 32 < 560 ? "facs" : "both"}
            initialView={taskPage === null ? null : "single"}
            onmeasureselect={(label) => (selectedMeasure = label)}
          />
        {/if}
      {:else}
        <p class="msg perr">
          No score file is recorded for {card.task}.
        </p>
      {/if}
    </div>
    <TaskPageSidePanel
      tables={panelTables}
      {taskId}
      {viewer}
      {runner}
      bind:panel={sidePanel}
      review={card.column === "validation"}
      banner={resultBanner}
      {taskBox}
      onanchor={showAnchorFor}
      oncomment={postComment}
      onresolve={resolveCommentRow}
    />
  {/if}
</div>

<style>
  .muted {
    color: var(--ink-faint);
  }
  .linkish {
    font: inherit;
    font-size: inherit;
    font-weight: 600;
    background: none;
    border: none;
    padding: 0;
    color: var(--link);
    cursor: pointer;
    text-decoration: underline;
  }
  .msg {
    margin: 24px auto;
    max-width: 640px;
    /* .review is a flex row; keep the message at content height. */
    align-self: flex-start;
  }
  .perr {
    padding: 14px;
    font-size: 12px;
    color: var(--danger);
  }

  /* The whole view: the score with the side panel beside it, filling the
     window under the navigation bar. */
  .review {
    flex: 1;
    min-height: 0;
    display: flex;
    background: var(--bg);
  }
  /* The side panel brings no outer spacing of its own; the score view's
     host row provides it there. Docked below the score it spans the width. */
  .review > :global(.spwrap:not(.docked)) {
    margin: 12px 16px 12px 0;
  }
  /* The score column: the preview's toolbar and the side panel share their
     top edge, 12px below the navigation bar. */
  .scorecol {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 12px 16px 0;
    box-sizing: border-box;
  }
</style>
