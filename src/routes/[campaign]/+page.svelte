<script lang="ts">
  import { page } from "$app/state";
  import { auth, login } from "$lib/auth.svelte.ts";
  import {
    CommandRunner,
    readForge,
    viewerId,
  } from "$lib/command-runner.svelte.ts";
  import type { ForgeClient } from "$lib/forge/types.ts";
  import type { CommandContext } from "$lib/commands.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import {
    DOCKED_QUERY,
    clampPanelWidth,
    readSidePanel,
  } from "$lib/side-panels.ts";
  import { MediaQuery } from "svelte/reactivity";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import RunnerBanner from "$lib/components/RunnerBanner.svelte";
  import Notice from "$lib/components/Notice.svelte";
  import RefreshNotice from "$lib/components/RefreshNotice.svelte";
  import PieceRail from "$lib/components/PieceRail.svelte";
  import PageState from "$lib/components/PageState.svelte";
  import PlanEditor from "$lib/components/PlanEditor.svelte";
  import ScoreView from "$lib/components/ScoreView.svelte";
  import SidePanel from "$lib/components/SidePanel.svelte";
  import TaskBox from "$lib/components/TaskBox.svelte";
  import VolunteerView from "$lib/components/VolunteerView.svelte";
  import BoardLanes from "$lib/components/board/BoardLanes.svelte";
  import BoardHero from "$lib/components/board/BoardHero.svelte";
  import BranchNotice from "$lib/components/board/BranchNotice.svelte";
  import CampaignInfo from "$lib/components/board/CampaignInfo.svelte";
  import ManageBar from "$lib/components/board/ManageBar.svelte";
  import PieceStrip from "$lib/components/board/PieceStrip.svelte";
  import ScopeToggle from "$lib/components/board/ScopeToggle.svelte";
  import VolunteerHeader from "$lib/components/board/VolunteerHeader.svelte";
  import { CampaignAddress } from "$lib/campaign-page/campaign-address.svelte.ts";
  import { BranchHint } from "$lib/campaign-page/branch-hint.svelte.ts";
  import {
    CampaignData,
    TableSync,
  } from "$lib/campaign-page/campaign-data.svelte.ts";
  import { ScoreHead } from "$lib/campaign-page/score-head.svelte.ts";
  import { BoardModel } from "$lib/campaign-page/board-model.svelte.ts";
  import { StripPreview } from "$lib/campaign-page/strip-preview.svelte.ts";
  import { PageChecks } from "$lib/campaign-page/page-checks.svelte.ts";
  import { TaskSelection } from "$lib/campaign-page/task-selection.svelte.ts";
  import { ScoreNav } from "$lib/campaign-page/score-nav.svelte.ts";
  import { EditorReturn } from "$lib/campaign-page/editor-return.svelte.ts";
  import { CampaignActions } from "$lib/campaign-page/campaign-actions.ts";
  import { DeepLink } from "$lib/campaign-page/deep-link.svelte.ts";

  // The URL carries only the campaign name; the repo it addresses is resolved
  // from it (campaign-address.svelte.ts).
  const campaign = $derived(page.params.campaign!);
  const address = new CampaignAddress(() => campaign);
  const owner = $derived(address.owner);
  const repo = $derived(address.repo);
  const repoId = $derived(address.repoId);
  // The acting user's stable numeric id (written to the tables); login is display-only.
  const viewer = $derived(viewerId());

  const branch = new BranchHint(
    () => owner,
    () => repo,
  );

  const runner = new CommandRunner();

  // The context every command runs against; progress updates feed the busy
  // overlay's step log.
  const ctx = (f: ForgeClient): CommandContext =>
    runner.context(f, { repoId, owner, repo, campaign });

  const data = new CampaignData(() => campaign, ctx);

  // UI-only state — the board, with the owner's manage takeover and the score
  // view (?score=) over it, and the side panel showing the ?task= task or the
  // campaign. Everything else derives from the tracking tables.
  let manage = $state(false);
  let planEditor = $state<ReturnType<typeof PlanEditor>>();
  // The side panel's size (side-panels.ts).
  let sidePanel = $state(readSidePanel());
  // The board row's rail takes its wide form only while four lanes fit
  // beside it and the side panel, at the panel's rendered width (its stored
  // width, capped by clampPanelWidth).
  let instrowBox = $state<DOMRectReadOnly | null>(null);
  const instrowWidth = $derived(instrowBox?.width ?? 0);
  let windowWidth = $state(0);
  // In a narrow portrait window (DOCKED_QUERY) and in a short window the view
  // is split: the content scrolls as one region and the side panel takes the
  // lower part of the screen (docked) or its right half (a short window).
  const panelOutQuery = new MediaQuery(`${DOCKED_QUERY}, (max-height: 500px)`);
  const panelOut = $derived(panelOutQuery.current);
  /** Four 200px lanes with 1px borders and three 12px gaps. */
  const LANES_WIDTH = 844;
  const ROW_GAP = 14;
  /** The rail's wide width (PieceRail.svelte). */
  const RAIL_WIDE = 168;
  // With the panel outside the board row (panelOut) the row is already
  // narrowed by it.
  const rowBesidePanel = $derived(
    panelOut
      ? instrowWidth
      : instrowWidth - clampPanelWidth(sidePanel.width, windowWidth) - ROW_GAP,
  );
  const railChips = $derived(
    instrowWidth > 0 && rowBesidePanel < RAIL_WIDE + ROW_GAP + LANES_WIDTH,
  );

  const scoreHead = new ScoreHead(
    data,
    () => owner,
    () => repo,
  );
  const model = new BoardModel(
    data,
    () => viewer,
    () => repoId,
  );
  const strip = new StripPreview(
    data,
    model,
    () => owner,
    () => repo,
  );
  const pageChecks = new PageChecks(
    data,
    model,
    () => selection.detailCard,
    () => owner,
    () => repo,
  );
  const selection = new TaskSelection(model, () => campaign);
  const nav = new ScoreNav(model, selection, () => campaign);
  const sync = new TableSync(data, runner, {
    owner: () => owner,
    repo: () => repo,
    repoId: () => repoId,
    // The plan editor holds polling while it is open, not under the score view.
    held: () => manage && !nav.scoreView,
    viewerChanged: () => (manage = false),
    settled: (entry) => editorReturn.settled(entry),
  });
  const editorReturn: EditorReturn = new EditorReturn({
    campaign: () => campaign,
    locks: () => data.locks,
    viewer: () => viewer,
    repoId: () => repoId,
    submit: (task) => actions.submitpr(task),
    abandon: (task) => actions.abandon(task, ""),
  });
  const actions: CampaignActions = new CampaignActions(runner, {
    campaign: () => campaign,
    repoId: () => repoId,
    taskDefs: () => data.taskDefs,
    ctx,
    load: () => data.load(),
    actedOn: editorReturn.actedOn,
    openTask: selection.openTask,
    planSaved: () => (manage = false),
  });
  new DeepLink(data, selection, editorReturn, {
    campaign: () => campaign,
    viewer: () => viewer,
    scoreView: () => !!nav.scoreView,
  });
</script>

<svelte:head>
  <title>{data.title || campaign} · Let's Encode!</title>
</svelte:head>

<svelte:window
  bind:innerWidth={windowWidth}
  onkeydown={(e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    // Escape in a text field belongs to the field; closing here would
    // discard what was typed.
    const target = e.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable]")) return;
    if (nav.scoreView) nav.closeScoreView();
    else if (selection.detailTask) selection.closeTask();
  }}
/>

{#if runner.busy && runner.overlay}
  <LoadingOverlay
    log={runner.log}
    finished={runner.held}
    error={runner.result?.error}
    outcome={runner.result?.outcome}
    message={runner.result?.message}
    onContinue={() => runner.dismiss()}
  />
{/if}

<!-- The last command's result: in the task box of a selected task, else at
     the top of the side panel; above the plan editor, which has no panel. -->
{#snippet resultBanner()}
  <RunnerBanner {runner} isPrivate={data.isPrivate} />
{/snippet}
{#snippet resultNote()}
  <RunnerBanner {runner} surface="inline" isPrivate={data.isPrivate} />
{/snippet}
{#snippet panelResult()}
  <RunnerBanner {runner} surface="strip" isPrivate={data.isPrivate} />
{/snippet}

{#snippet boardTaskBox(card: BoardCard)}
  <TaskBox
    {repoId}
    {card}
    pieceName={model.pieceNameOf(card.task)}
    zone={model.zoneOf(card.task)}
    {campaign}
    locks={data.locks}
    rows={data.rows}
    logins={data.logins}
    {viewer}
    canPush={data.canPush}
    {runner}
    tools={resultNote}
    checks={pageChecks.checksOf(card)}
    checksFailed={pageChecks.checksFor(card) === "failed"}
    onclaim={actions.claimValidate}
    editorError={editorReturn.editorError?.task === card.task
      ? editorReturn.editorError
      : null}
    changeRequestUrl={(n) => readForge().changeRequestWebUrl(owner, repo, n)}
    oneditor={actions.editor}
    onabandon={actions.abandon}
  />
{/snippet}

<!-- The side panel of the board and the volunteer view: the selected task,
     else the campaign. -->
{#snippet sidePanelFor(card: BoardCard | null, emptyLine: string)}
  {#if card}
    <SidePanel
      {repoId}
      task={card.task}
      zone={model.zoneOf(card.task)}
      review={card.column === "validation"}
      done={card.column === "done"}
      comments={data.comments}
      logins={data.logins}
      {viewer}
      canPush={data.canPush}
      {runner}
      bind:panel={sidePanel}
      ondeselect={selection.closeTask}
      onanchor={nav.showCommentInScore}
      oncomment={(kind, body, parent_id) =>
        actions.postComment(card.task, kind, body, parent_id)}
      onresolve={actions.resolveCommentRow}
    >
      {#snippet taskBox()}{@render boardTaskBox(card)}{/snippet}
    </SidePanel>
  {:else}
    <SidePanel
      {repoId}
      task=""
      {emptyLine}
      info={data.canPush ? campaignInfo : undefined}
      comments={data.comments}
      logins={data.logins}
      {viewer}
      canPush={data.canPush}
      {runner}
      bind:panel={sidePanel}
      banner={panelResult}
      onanchor={nav.showCommentInScore}
      oncomment={(kind, body, parent_id) =>
        actions.postComment("", kind, body, parent_id)}
      onresolve={actions.resolveCommentRow}
    />
  {/if}
{/snippet}

<!-- The campaign's details in the owner's side panel, above the campaign
     comments. -->
{#snippet campaignInfo()}
  <CampaignInfo
    {scoreHead}
    history={data.history}
    logins={data.logins}
    {owner}
    {repo}
    description={data.description}
    isPrivate={data.isPrivate}
    license={data.license}
    passThreshold={data.passThreshold}
  />
{/snippet}

<div class="console">
  {#if auth.status === "loading"}
    <PageState loading="the campaign" />
  {:else}
    {#if !auth.user}
      <Notice
        tone="warn"
        surface="strip"
        icon="eye"
        title={auth.expired ? "Your GitHub login has expired" : "Read-only"}
        detail="Log in to contribute to this campaign."
        action={{ label: "Log in with GitHub", run: () => login() }}
      />
    {/if}
    {#if manage && data.canPush && !nav.scoreView}
      {@render resultBanner()}
    {/if}
    {#if editorReturn.returnedGone}
      <Notice
        tone="err"
        surface="strip"
        title={`${editorReturn.returnedGone} no longer exists in this campaign`}
        detail="The outcome from mei-friend was not recorded."
        ondismiss={() => (editorReturn.returnedGone = null)}
      />
    {/if}
    {#if branch.hint}
      <BranchNotice {branch} hint={branch.hint} />
    {/if}

    {#if address.resolveError}
      <PageState
        error={address.resolveError}
        onretry={() => (address.resolveError = null)}
      />
    {:else if address.notFound}
      <PageState missingCampaign={campaign} />
    {:else if address.slugState}
      <PageState
        nameState={{
          name: campaign,
          state:
            address.slugState === "tombstoned" ? "blocked" : address.slugState,
        }}
      />
    {:else}
      <div class="viewcol">
        <RefreshNotice status={sync.refreshStatus} />
        {#if !address.resolved || data.loading}
          <PageState loading="the campaign" />
        {:else if data.loadError}
          <PageState error={data.loadError} onretry={() => data.load()} />
        {:else if data.notInitialised}
          <PageState noTables />
        {:else if nav.scoreView}
          {#key nav.scoreView.piece.path}
            <ScoreView
              {repoId}
              bind:this={nav.scoreViewRef}
              piece={nav.scoreView.piece}
              campaignTitle={data.title || repo}
              {owner}
              {repo}
              startPage={nav.startPage}
              anchor={nav.anchor}
              card={selection.detailCard}
              cardOnPiece={!!selection.detailCard &&
                (model.pieceIndexByTask.get(selection.detailCard.task) ?? 0) ===
                  nav.scoreView.index}
              cardZone={selection.detailCard
                ? model.zoneOf(selection.detailCard.task)
                : 0}
              banner={selection.detailCard ? undefined : panelResult}
              comments={data.comments}
              logins={data.logins}
              {viewer}
              canPush={data.canPush}
              {runner}
              bind:panel={sidePanel}
              ondeselect={selection.closeTask}
              onopenanchor={nav.showCommentInScore}
              oncomment={actions.postComment}
              onresolve={actions.resolveCommentRow}
            >
              {#snippet taskBox()}{#if selection.detailCard}{@render boardTaskBox(
                    selection.detailCard,
                  )}{/if}{/snippet}
            </ScoreView>
          {/key}
        {:else if manage && data.canPush}
          <ManageBar
            name={data.title || repo}
            history={data.history}
            busy={runner.busy}
            onback={() => (planEditor ? planEditor.close() : (manage = false))}
            onreap={() => actions.reaper()}
          />
          <PlanEditor
            bind:this={planEditor}
            taskDefs={data.taskDefs}
            rows={data.rows}
            validationColumns={data.validationColumns}
            locks={data.locks}
            history={data.history}
            logins={data.logins}
            pieceNames={model.pieceNames}
            busy={runner.busy}
            onsave={actions.savePlan}
            oncancel={() => (manage = false)}
          />
        {:else if !data.canPush}
          <!-- Split (panelOut): the list scrolls above or beside the panel. -->
          <div class="volsplit" class:split={panelOut}>
            <div class="volwrap">
              <div class="volcenter">
                <VolunteerHeader
                  name={data.title || repo}
                  standing={model.volStanding}
                  done={model.board.done}
                  total={model.board.total}
                  canViewScore={nav.canViewScore}
                  scoreHint={nav.scoreHint}
                  bind:viewScoreButton={nav.viewScoreButton}
                  onviewscore={nav.viewContextScore}
                />
                <div class="volrow sidehost">
                  <VolunteerView
                    {repoId}
                    {owner}
                    {repo}
                    cards={model.allCards}
                    nextCard={model.nextCard}
                    completedTask={editorReturn.completedTask}
                    taskDefs={data.taskDefs}
                    history={data.history}
                    locks={data.locks}
                    {viewer}
                    pieces={model.previewPieces}
                    progress={model.pieceProgress}
                    pieceIndex={model.pieceIndexByTask}
                    busy={runner.busy}
                    shownTask={selection.detailTask}
                    onact={actions.actOnCard}
                    onopen={selection.openTask}
                  />
                  {#if !panelOut}
                    <div class="sideslot">
                      {@render sidePanelFor(
                        selection.detailCard,
                        "Select a task to show it here.",
                      )}
                    </div>
                  {/if}
                </div>
              </div>
            </div>
            {#if panelOut}
              <div class="panelslot">
                {@render sidePanelFor(
                  selection.detailCard,
                  "Select a task to show it here.",
                )}
              </div>
            {/if}
          </div>
        {:else}
          <!-- Split (panelOut): the board scrolls above or beside the panel. -->
          <div class="boardview" class:split={panelOut}>
            <div class="boardscroll">
              <BoardHero
                name={data.title || repo}
                repoLabel={`${owner}/${repo}`}
                repoUrl={readForge().repoWebUrl(owner, repo)}
                canManage={!!auth.user && data.canPush}
                busy={runner.busy}
                canViewScore={nav.canViewScore}
                scoreHint={nav.scoreHint}
                bind:viewScoreButton={nav.viewScoreButton}
                board={model.board}
                attentionCards={model.attentionCards}
                bind:showAttention={model.showAttention}
                bind:scope={model.boardScope}
                onmanage={() => (manage = true)}
                onviewscore={nav.viewContextScore}
                onopen={selection.openTask}
              />

              <div class="instrow sidehost" bind:contentRect={instrowBox}>
                {#if model.previewPieces.length > 0 && !railChips}
                  <div class="railslot">
                    <PieceRail
                      pieces={model.previewPieces}
                      chips={false}
                      progress={model.pieceProgress}
                      counts={model.railCounts}
                      attention={model.attentionByPiece}
                      openCount={model.railOpenCount}
                      selected={model.selectedPiece}
                      onselect={(sel) => (model.selectedPiece = sel)}
                    />
                  </div>
                {/if}
                <div class="boardcol">
                  {#if railChips}
                    <!-- On a phone the board filter joins the piece dots;
                         the header keeps it elsewhere. -->
                    <div class="boardtools">
                      {#if model.previewPieces.length > 0}
                        <PieceRail
                          pieces={model.previewPieces}
                          chips
                          progress={model.pieceProgress}
                          counts={model.railCounts}
                          attention={model.attentionByPiece}
                          openCount={model.railOpenCount}
                          selected={model.selectedPiece}
                          onselect={(sel) => (model.selectedPiece = sel)}
                        />
                      {/if}
                      <ScopeToggle bind:scope={model.boardScope} />
                    </div>
                  {/if}
                  {#if model.railPiece}
                    <PieceStrip
                      piece={model.railPiece.piece}
                      index={model.railPiece.index}
                      progress={model.pieceProgress.get(
                        model.railPiece.piece.path,
                      )}
                      preview={strip.preview}
                      onretry={() => strip.attempt++}
                    />
                  {/if}
                  <BoardLanes
                    columns={model.scopedColumns}
                    laneTab={selection.laneTab}
                    boardScope={model.boardScope}
                    {repoId}
                    {viewer}
                    logins={data.logins}
                    detailTask={selection.detailTask}
                    completedTask={editorReturn.completedTask}
                    recentlyFinished={model.recentlyFinished}
                    piecesListed={model.piecesListed}
                    zoneOf={model.zoneOf}
                    reviewExpiry={model.reviewExpiry}
                    onpicklane={(lane) => (selection.pickedLane = lane)}
                    onopen={selection.openTask}
                  />
                </div>
                {#if !panelOut}
                  {@render sidePanelFor(
                    selection.detailCard,
                    "Select a task on the board to show it here.",
                  )}
                {/if}
              </div>
            </div>
            {#if panelOut}
              <div class="panelslot">
                {@render sidePanelFor(
                  selection.detailCard,
                  "Select a task on the board to show it here.",
                )}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  /* The result card above the plan editor, inset like the editor. */
  .console > :global(.live) > :global(.notice) {
    margin: 12px 32px 0;
  }
  .console {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-alt);
    background-image:
      radial-gradient(60% 90% at 15% 0%, var(--glow-blue), transparent 60%),
      radial-gradient(60% 90% at 85% 10%, var(--glow-green), transparent 60%);
    /* Board-only aliases onto the global recessed-surface tokens. */
    --well: var(--bg-inset);
    --track: var(--bg-tint);
    --hairline: var(--line);
  }

  /* Banner styles are shared app-wide in ui.css. */

  /* --------------------------------------------------------------- main */
  /* The view fills the window — the rail, board and side panel share every
     available column. Its minimum height is its content's. The width minimum
     is explicit: the inline-size containment below makes the content's own
     width invisible to sizing, and the board's stacking reacts to the
     column's width instead. */
  /* The column caps at the window: the board, the score view and the
     volunteer view scroll inside their own regions, and where their least
     sizes do not fit the window the column itself scrolls. */
  .viewcol {
    flex: 1;
    min-width: 340px;
    min-height: 0;
    overflow-y: auto;
    width: 100%;
    display: flex;
    flex-direction: column;
    container-type: inline-size;
    container-name: view;
  }
  /* Split (a narrow portrait window, or a short window): the content and
     the side panel share the window, the panel docked below in portrait
     (DOCKED_QUERY) and beside in a short window. The content scrolls as one
     region, its sections at their content's height; a gap separates it from
     the panel beside it, none from the panel docked below. The board's own
     part of this is in BoardLanes.svelte. */
  .volsplit,
  .boardview,
  .boardscroll {
    display: contents;
  }
  .volsplit.split,
  .boardview.split {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .split > .volwrap,
  .split > .boardscroll {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    container-type: inline-size;
    container-name: view;
  }
  .panelslot {
    flex: none;
    min-height: 0;
    display: flex;
    padding: 12px 16px 12px 0;
    box-sizing: border-box;
  }
  @media (orientation: portrait) and (max-width: 1100px) {
    .volsplit.split,
    .boardview.split {
      flex-direction: column;
    }
    /* Docked, the panel's top border meets the scrolling content directly. */
    .panelslot {
      flex-direction: column;
      padding: 0;
    }
  }
  .split .volcenter,
  .split .volrow,
  .split .instrow {
    flex: none;
    min-height: 0;
  }
  .split :global(.volunteer) {
    overflow-y: visible;
    padding-right: 0;
    scrollbar-gutter: auto;
  }

  /* The volunteer view: the header row, the task column and the side panel
     form one centred group, at most 1750px wide with its padding, clear of
     the footer. */
  .volwrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    padding: 18px 32px 14px;
    box-sizing: border-box;
  }
  .volcenter {
    flex: 1;
    min-height: 0;
    width: 100%;
    max-width: calc(1750px - 64px);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .volrow {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 14px;
  }
  /* The side panel's top edge lines up with the next-task card, below its
     badge. */
  .sideslot {
    flex: none;
    min-height: 0;
    display: flex;
    padding-top: 9px;
    box-sizing: border-box;
  }
  /* Narrow column: the header wraps its title over the count
     (VolunteerHeader.svelte). */
  @container (max-width: 700px) {
    .volwrap {
      padding: 12px 16px 14px;
    }
  }

  /* ---------------------------------------- rail · board · side panel row */
  .instrow {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 14px;
    /* Clear of the footer. */
    padding: 0 32px 14px;
  }
  .railslot {
    flex: none;
    display: flex;
    min-height: 0;
    align-self: flex-start;
    max-height: 100%;
  }
  @media (max-width: 1100px) {
    .instrow {
      padding: 0 20px 14px;
    }
  }
  .boardcol {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    /* The board's stacking query measures this column, which the rail and
       the side panel narrow independently of the window. */
    container-type: inline-size;
  }
  /* The piece dots and, in a phone-width view, the board filter beside them
     (the header's own filter then hides); with many pieces the filter moves
     to its own line and the dots take the full width. The board filter is
     ScopeToggle's root. */
  .boardtools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .boardtools > :global(.seg) {
    display: none;
    margin-left: auto;
    flex: none;
  }
  @container view (max-width: 700px) {
    .boardtools > :global(.seg) {
      display: inline-flex;
    }
    /* The Open lane tab below carries the open count. */
    .boardtools :global(.dotlabel) {
      display: none;
    }
  }
  /* A narrow view column (a phone): the side margins shrink. */
  @container (max-width: 700px) {
    .instrow {
      padding: 0 16px 14px;
    }
  }
</style>
