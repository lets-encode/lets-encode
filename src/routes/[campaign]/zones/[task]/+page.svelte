<script lang="ts">
  import PageState from "$lib/components/PageState.svelte";
  import { onDestroy, type Snippet } from "svelte";
  import { page } from "$app/state";
  import { recordCampaignTitle } from "$lib/campaign-title.svelte.ts";
  import { auth, forge } from "$lib/auth.svelte.ts";
  import { anchorCell, MAX_ANCHOR_LENGTH } from "$lib/campaign-submit.ts";
  import { correctorServices } from "$lib/corrector-services.ts";
  import type { ForgeClient } from "$lib/forge/types.ts";
  import type { FacsimileTaskData } from "$lib/commands.ts";
  import PreTaskStatus from "$lib/components/PreTaskStatus.svelte";
  import { commands, invoke } from "$lib/commands.ts";
  import type { CommandContext, Result } from "$lib/commands.ts";
  import { taskDescription } from "$lib/campaign-graph.ts";
  import { PANEL_MIN_REVIEW, readSidePanel } from "$lib/side-panels.ts";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import RunnerBanner from "$lib/components/RunnerBanner.svelte";
  import TaskPageSidePanel from "$lib/components/TaskPageSidePanel.svelte";
  import TaskRunState from "$lib/components/TaskRunState.svelte";
  import PreTaskBox from "$lib/components/PreTaskBox.svelte";
  import ReviewActions from "$lib/components/ReviewActions.svelte";
  import DraftBubble from "$lib/components/DraftBubble.svelte";
  import { PreTaskSession } from "$lib/pre-task-session.svelte.ts";
  import { createOmrClient } from "$lib/omr-client.ts";
  import { provider, omr as omrModels } from "$lib/forge/config.ts";
  import { STEP_NAMES } from "$lib/zones/edit-pages.ts";
  import { Corrector } from "$lib/zones/corrector.svelte.ts";
  import type { LayoutStep } from "$lib/zones/layout-steps.svelte.ts";
  import { NARROW_TOOL } from "$lib/zones/page-view.svelte.ts";
  import ZoneToolbar from "$lib/components/zones/ZoneToolbar.svelte";
  import ZoneViewerToolbar from "$lib/components/zones/ZoneViewerToolbar.svelte";
  import ZoneDesk from "$lib/components/zones/ZoneDesk.svelte";
  import ZoneSteps from "$lib/components/zones/ZoneSteps.svelte";
  import ZoneSelection from "$lib/components/zones/ZoneSelection.svelte";
  import ZoneFooter from "$lib/components/zones/ZoneFooter.svelte";
  import ZoneLoupe from "$lib/components/zones/ZoneLoupe.svelte";

  // The URL carries the campaign name and task; the repo is resolved from the
  // name (name → stable repo id → current owner/name) — see resolveCampaign.
  const campaign = $derived(page.params.campaign!);
  const taskId = $derived(page.params.task!);

  const session: PreTaskSession = new PreTaskSession(
    () => campaign,
    () => taskId,
    {
      loaded(d) {
        c.load(d, d.holdsLock && d.status === "encoding_required");
      },
      // A claim of an OMR layout task whose score carries no zones yet
      // continues into layout detection in the same overlay.
      afterClaim(f, d) {
        if (!detection.needsDetection()) return null;
        detection.detectedFor = taskId;
        return detection.detectSteps(servicesFor(f, d));
      },
    },
  );
  const runner = session.runner;
  // The recognition service's calls stop when the page goes away.
  const omrStop = new AbortController();
  onDestroy(() => omrStop.abort());
  const omrClient = () =>
    createOmrClient(provider.brokerUrl, { signal: omrStop.signal });
  const data = $derived(session.data);
  // The correction's network work on this task.
  const servicesFor = (f: ForgeClient, d: FacsimileTaskData) =>
    correctorServices({
      forge: f,
      data: d,
      owner,
      repo,
      repoId,
      taskId,
      omrClient,
    });
  const services = () => {
    const f = forge();
    return f && data ? servicesFor(f, data) : null;
  };
  const tables = $derived(session.tables);
  $effect(() => {
    if (tables) recordCampaignTitle(campaign, tables.title);
  });
  const holds = $derived(session.holds);
  const canEdit: boolean = $derived(session.canEdit);
  const busy = $derived(session.busy);
  const owner = $derived(session.campaign.owner);
  const repo = $derived(session.campaign.repo);
  const repoId = $derived(session.campaign.repoId);
  const viewer = $derived(session.viewer);
  // The task's kind: measure correction, which for an OMR-prepared piece
  // (omr-layout) also corrects the staff and grand-staff boxes.
  const taskTitle = $derived(taskDescription(data?.locator ?? "measure-zones"));
  const omr = $derived(data?.locator === "omr-layout");
  // A layout task of an 'omr-instruments' piece also names the instruments,
  // in a fourth step.
  const naming = $derived(omr && data?.preparation === "omr-instruments");
  const c: Corrector = new Corrector({
    data: () => data,
    omr: () => omr,
    naming: () => naming,
    canEdit: () => canEdit,
    runner,
    taskId: () => taskId,
    services,
    layoutModel: omrModels.layoutModel,
  });
  const { steps, model, ed, view, sel, instruments, transcriber, detection } =
    c;
  const coarse = $derived(c.coarse);
  const submitBlock = $derived(c.submitBlock);
  const boxName = $derived(c.boxName);
  const setLayoutStep = c.setLayoutStep;
  // The side panel's tab; selecting a box shows its controls.
  let panelTab = $state<"selection" | "comments">("selection");
  // A comment button counts up to open the panel's comment field.
  let compose = $state(0);

  // While the task is held, its boxes are saved as a draft after each pause
  // in editing. A drag in progress (ed.dragging) defers it to the drag's end,
  // so the score is not serialised on every pointer move.
  $effect(() => {
    if (ed.dragging || !session.canEdit || model.pages.length === 0) return;
    session.draft(c.draft());
  });

  const submit = () =>
    run(
      (ctx) =>
        omr
          ? invoke(
              commands.submitOmrLayout,
              { task_id: taskId, ...c.layoutSubmission() },
              ctx,
            )
          : invoke(
              commands.submitZones,
              { task_id: taskId, pages: c.pageModels() },
              ctx,
            ),
      { overviewOnSuccess: true },
    );

  const run = (
    command: (c: CommandContext) => Promise<Result>,
    opts?: { overviewOnSuccess?: boolean },
  ) => session.run(command, opts);

  // ------------------------------------------------------------- comments
  // The side panel beside the tool. Posting and resolving refresh the tables
  // only: a full reload would discard unsubmitted zone edits.
  // Beside the pages it is at least PANEL_MIN_TOOLS wide, so the steps,
  // the selected box's controls and the footer each keep to their rows.
  // It opens no wider than leaves the tool column
  // NARROW_TOOL wide (plus .main's 32px side padding and the panel's 16px
  // outer margin), so a width kept from a wider window does not give a
  // tablet the phone toolbar; a window too narrow for both gets the panel
  // at PANEL_MIN_TOOLS. The kept width itself is unchanged.
  const PANEL_MIN_TOOLS = 340;
  const keptPanel = readSidePanel();
  const besideMax = window.innerWidth - NARROW_TOOL - 48;
  let sidePanel = $state({
    ...keptPanel,
    width: Math.max(PANEL_MIN_TOOLS, Math.min(keptPanel.width, besideMax)),
  });
</script>

<svelte:head>
  <title>{taskTitle} · {session.pieceName || campaign} · Let's Encode!</title>
</svelte:head>

<svelte:window onpointerdown={c.closeViewOutside} onkeydown={c.keydown} />

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

<!-- On touch screens a long press opens no context menu (Android's save
     image menu) outside text fields and comment text. -->
<div
  class="workshell corrector sidehost"
  data-stage="pre"
  role="presentation"
  oncontextmenu={(e) => {
    if (
      coarse &&
      !(e.target as Element).closest(
        "input, textarea, [contenteditable], .cbody",
      )
    )
      e.preventDefault();
  }}
>
  {#if session.campaign.error}
    <PageState
      error={session.campaign.error}
      onretry={() => session.campaign.retry()}
    />
  {:else if session.campaign.notFound}
    <PageState missingCampaign={campaign} />
  {:else if auth.status === "loading" || !session.campaign.resolved}
    <PageState loading="the campaign" />
  {:else if !auth.user}
    <PageState loggedOut />
  {:else if session.loading}
    <PageState loading="the facsimile" />
  {:else if session.loadError}
    <PageState error={session.loadError} onretry={() => session.load()} />
  {:else if data}
    <div class="workmain main">
      <h1 class="vh">{taskTitle} · {session.pieceName || campaign}</h1>
      <ZoneToolbar
        {view}
        bar={toolbar}
        step4={steps.step4}
        {canEdit}
        {coarse}
        {boxName}
        {omr}
        bind:helpOpen={c.helpOpen}
        bind:viewOpen={c.viewOpen}
      />
      <div class="runrow"><TaskRunState task={taskId} {repoId} pill /></div>

      <ZoneDesk
        editor={ed}
        {model}
        {view}
        {sel}
        {instruments}
        tool={steps.tool}
        step4={steps.step4}
        {canEdit}
        {coarse}
      />
      <DraftBubble {session} />
    </div>

    <!-- The page toolbar: above or below the pages, or at the top of the
         side panel docked as a sheet on a phone (inSheet). -->
    {#snippet toolbar(narrow: boolean)}
      <ZoneViewerToolbar
        {narrow}
        editor={ed}
        {view}
        total={model.pages.length}
        {canEdit}
        {coarse}
        {boxName}
        step4={steps.step4}
        bind:helpOpen={c.helpOpen}
        bind:viewOpen={c.viewOpen}
      />
    {/snippet}

    {#snippet sheetBar()}
      <div class="sheetbar">
        {@render toolbar(true)}
      </div>
    {/snippet}

    <!-- The task tools in the side panel: the layout steps (an OMR-prepared
         piece) or the counts. -->
    {#snippet tools()}
      <ZoneSteps
        {model}
        {omr}
        {naming}
        layoutStep={steps.layoutStep}
        instrumentCount={instruments.shownNamed.instruments.length}
        onstep={setLayoutStep}
      />
    {/snippet}

    {#snippet selection()}
      <ZoneSelection
        editor={ed}
        {model}
        {sel}
        tool={steps.tool}
        step4={steps.step4}
        {canEdit}
        {coarse}
        docked={view.docked}
        labelMax={MAX_ANCHOR_LENGTH}
        oncompose={auth.user ? () => compose++ : undefined}
      />
    {/snippet}

    {#snippet status()}
      <PreTaskStatus {session} />
    {/snippet}

    <!-- The task's action at the panel's bottom: the claim or the draft
         state and give back, then the next step or the submission. -->
    {#snippet footer()}
      <ZoneFooter
        {status}
        {transcriber}
        {omr}
        {naming}
        layoutStep={steps.layoutStep}
        lastStep={steps.lastStep}
        step4={steps.step4}
        {canEdit}
        {busy}
        {submitBlock}
        onstep={setLayoutStep}
        onsubmit={submit}
      />
    {/snippet}

    <!-- In a layout review, Approve's place until every step was opened: the
         next step not opened yet. -->
    {#snippet reviewNext()}
      <button
        type="button"
        class="btn"
        onclick={() => setLayoutStep(steps.nextMissing as LayoutStep)}
        title={`Go on to step ${steps.nextMissing}. Approve is available once every step has been opened.`}
      >
        Next: {STEP_NAMES[steps.nextMissing - 1]}
      </button>
    {/snippet}

    <!-- The viewer's verdict and Give back task, at the panel's bottom. -->
    {#snippet reviewFooter()}
      {#if session.card && session.reviewSub !== undefined}
        <ReviewActions
          {repoId}
          approveBlock={steps.approveBlock}
          instead={reviewNext}
          task={session.card.task}
          sub={session.reviewSub}
          runner={session.runner}
          prefill={() => {
            const at = sel.reviewPrefill();
            return { ...at, m1: anchorCell(at.m1), m2: anchorCell(at.m2) };
          }}
          onvalidate={(sub, verdict, comment) =>
            session.validate(sub, verdict, comment)}
          onreviewedit={async (sub, comment) => {
            steps.editFrom = steps.layoutStep;
            const result = await session.reviewEdit(sub, comment);
            if (!result || result.error) steps.editFrom = null;
            return result;
          }}
          onabandon={(sub) => session.abandon(sub)}
        />
      {/if}
    {/snippet}

    <!-- The last command's result, in the task box. A failed detection is
         offered again only while the score has no boxes, which it would
         replace. -->
    {#snippet resultNote()}
      <RunnerBanner
        {runner}
        surface="inline"
        retryable={detection.needsDetection()}
      />
    {/snippet}

    {#snippet taskBox(headAction: Snippet | undefined)}
      {#if session.card}
        <PreTaskBox
          {session}
          {campaign}
          card={session.card}
          tools={resultNote}
          {headAction}
        />
      {/if}
    {/snippet}

    {#if tables}
      <TaskPageSidePanel
        {repoId}
        {tables}
        {taskId}
        review={data?.status === "validation_required"}
        done={data?.status === "completed"}
        {viewer}
        {runner}
        bind:panel={sidePanel}
        minWidth={session.reviewSub !== undefined
          ? PANEL_MIN_REVIEW
          : PANEL_MIN_TOOLS}
        {taskBox}
        {tools}
        {selection}
        selectionLabel="Selection"
        selectionActive={!!sel.selectedItem}
        selected={sel.selected}
        bind:tab={panelTab}
        {compose}
        footer={session.footerMode === "edit"
          ? footer
          : session.footerMode === "review"
            ? reviewFooter
            : undefined}
        bar={view.inSheet ? sheetBar : undefined}
        composerHint={sel.selectedLabel
          ? `Comment on measure ${sel.selectedLabel}…`
          : ""}
        onanchor={sel.showAnchorFor}
        oncomment={(task, kind, body, parent_id) =>
          session.postComment(
            task,
            kind,
            body,
            parent_id,
            kind === "comment" ? sel.commentAnchor() : undefined,
          )}
        onresolve={(id) => session.resolveComment(id)}
      />
    {/if}

    <ZoneLoupe editor={ed} {model} canvasW={view.canvasW} tool={steps.tool} />
  {/if}
</div>

<style>
  /* The whole tool (.workshell, ui.css): the desk the page sheets float on
     (the only scrolling region), with the side panel — carrying the task
     box — beside it. The app's navigation bar and footer come from the
     layout, as on every other page. */
  /* A phone sheet: less space around the steps and the selection's heading. */
  @media (orientation: portrait) and (max-width: 559px) {
    .corrector :global(.sptools) {
      padding-block: 6px;
    }
    .corrector :global(.spsel) {
      padding-block: 8px 10px;
    }
  }
  /* Banner styles are shared app-wide in ui.css. */
  /* The desk column beside the sidebar: the paging and zoom toolbar on top,
     result banners over the desk. */
  /* The tool column: its toolbar's top edge and the side panel's are one
     line, 12px below the navigation bar. */
  .main {
    padding: 12px 16px 0;
    box-sizing: border-box;
    container-type: inline-size;
  }
  /* The run state's pill above the work area; takes room only while shown. */
  .runrow {
    flex: none;
  }
  .runrow:has(:global(.runstate)) {
    padding: 8px 0 0;
  }
  /* Its padding holds the buttons' 44px press areas; the negative margin
     keeps the row 32px in the layout. */
  .sheetbar :global(.vtoolbar.narrow) {
    min-height: 32px;
    padding: 6px 3px;
    margin: -6px -3px;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }
  .sheetbar :global(.vtoolbar.narrow.drawing) {
    background: var(--st-wash);
    border: 1px solid var(--st);
    border-radius: 12px;
  }
</style>
