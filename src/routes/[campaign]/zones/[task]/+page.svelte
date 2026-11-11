<script lang="ts">
  import PageState from "$lib/components/PageState.svelte";
  import { onDestroy, tick, untrack, type Snippet } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import { page } from "$app/state";
  import { recordCampaignTitle } from "$lib/campaign-title.svelte.ts";
  import { auth } from "$lib/auth.svelte.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import type { CommandContext, Result } from "$lib/commands.ts";
  import { taskDescription } from "$lib/campaign-graph.ts";
  import { PANEL_MIN_REVIEW, readSidePanel } from "$lib/side-panels.ts";
  import type { MeasureBox } from "$lib/mei-facsimile.ts";
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
  import { BoxEditor } from "$lib/box-editor.svelte.ts";
  import {
    boxNameOf,
    STEP_LAYERS,
    STEP_NAMES,
    toPageModels,
    type Layer,
  } from "$lib/zones/edit-pages.ts";
  import {
    draftInput,
    layoutSubmission,
    submitBlock as submitBlockOf,
    type SubmitState,
    type ZoneWork,
  } from "$lib/zones/submission.ts";
  import {
    ZonePages,
    type ZoneEditor,
    type ZoneSnapshot,
  } from "$lib/zones/zone-pages.svelte.ts";
  import {
    LayoutSteps,
    type LayoutStep,
  } from "$lib/zones/layout-steps.svelte.ts";
  import { NARROW_TOOL, PageView } from "$lib/zones/page-view.svelte.ts";
  import { BoxSelection } from "$lib/zones/box-selection.svelte.ts";
  import { InstrumentStep } from "$lib/zones/instrument-step.svelte.ts";
  import { StaffTranscription } from "$lib/zones/staff-transcription.svelte.ts";
  import { LayoutDetection } from "$lib/zones/layout-detection.svelte.ts";
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
        ed.clear();
        view.anchor = { page: 0, frac: 0 };
        model.load(d);
        // An edit switched to from a review continues at the step that was
        // in view: the steps before it count as checked. At the instruments
        // step it starts at the first system.
        const from = steps.editFrom;
        steps.editFrom = null;
        if (from && d.holdsLock && d.status === "encoding_required") {
          for (const layer of STEP_LAYERS.slice(0, from - 1))
            model.seen[layer] = model.pages.map((_, p) => p);
          if (from === 4) {
            model.named = { ...model.named, fixed: false };
            view.step4Pages = false;
            view.step4Top.names = view.step4Top.pages = 0;
            tick().then(() => view.desk?.scrollTo({ top: 0 }));
          }
        }
        ed.resetHistory();
      },
      // A claim of an OMR layout task whose score carries no zones yet
      // continues into layout detection in the same overlay.
      afterClaim(f, d) {
        if (!detection.needsDetection()) return null;
        detection.detectedFor = taskId;
        return detection.detectSteps(f, d.fragment);
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
  const steps: LayoutSteps = new LayoutSteps({
    omr: () => omr,
    naming: () => naming,
  });
  const model: ZonePages = new ZonePages({
    canEdit: () => canEdit,
    commit: () => ed.commit(),
  });
  // A page's boxes in a layer, the active one by default.
  const items = (p: number, layer: Layer = steps.tool) => model.items(p, layer);

  // The selection, the gestures and the undo history of the active layer's
  // boxes. In page pixels: a box is at least MIN_BOX each way, a drawn box
  // under DROP_BELOW was a click on the page, and an arrow key moves NUDGE
  // (NUDGE_FAR with Shift).
  const MIN_BOX = 5;
  const DROP_BELOW = 8;
  const NUDGE = 2;
  const NUDGE_FAR = 10;
  const ed: ZoneEditor = new BoxEditor<{ box: MeasureBox }, ZoneSnapshot>({
    items: (p) => (model.pages[p] ? items(p) : []),
    box: (item) => item.box,
    page: (p) => model.pages[p],
    surface: (p) => view.svgEls[p],
    screenWidth: (p) => view.canvasW[p] || model.pages[p]?.width || 0,
    canEdit: () => canEdit,
    canDraw: () => canEdit && view.showBoxes,
    shown: () => view.showBoxes,
    touch: () => coarse,
    scope: () => steps.tool,
    add: (p, box) => items(p)[model.addBox(p, steps.tool, box)],
    remove: (p, item) => {
      const list = items(p);
      const z = list.indexOf(item);
      if (z >= 0) list.splice(z, 1);
    },
    minSize: () => MIN_BOX,
    dropBelow: () => DROP_BELOW,
    nudge: { near: NUDGE, far: NUDGE_FAR },
    changed: settle,
    snapshot: () => model.snapshot(),
    restore: (s) => model.restore(s),
  });
  $effect(() => ed.listen());

  // The cursor class for a resize handle: a corner gets the diagonal arrows,
  // a side the axis arrows.

  // The selected box's handles: the four edges, then the four corners.

  // Arrow keys on a focused resize handle move that handle's edges.

  // On a touch screen a finger drag on the page scrolls it: a tap selects a
  // box, the selected box and its handles drag, and new boxes are drawn only
  // in draw mode.
  const coarseQuery = new MediaQuery("(pointer: coarse)", false);
  const coarse = $derived(coarseQuery.current);
  // The side panel's tab; selecting a box shows its controls.
  let panelTab = $state<"selection" | "comments">("selection");
  // A comment button counts up to open the panel's comment field.
  let compose = $state(0);

  const view: PageView = new PageView({
    pages: () => model.pages,
    data: () => data,
    coarse: () => coarse,
    step4: () => steps.step4,
    deselect: () => ed.select(0, null),
    boxesToggled: () => ed.clear(),
  });
  const sel = new BoxSelection({
    editor: ed,
    model,
    view,
    tool: () => steps.tool,
    canEdit: () => canEdit,
    settle,
  });

  // The pages shown in each step. Submission waits until every page with
  // boxes in a step has been on screen in that step.
  $effect(() => {
    const shown = view.shownPages;
    const layer = steps.tool;
    if (steps.step4) return;
    untrack(() => model.markSeen(layer, shown));
  });

  const instruments = new InstrumentStep({
    model,
    runner,
    omr: () => omr,
    naming: () => naming,
    layoutStep: () => steps.layoutStep,
    canEdit: () => canEdit,
    taskId: () => taskId,
    data: () => data,
    owner: () => owner,
    repo: () => repo,
    commit: () => ed.commit(),
  });
  const transcriber = new StaffTranscription({
    omr: () => omr,
    naming: () => naming,
    step4: () => steps.step4,
    canEdit: () => canEdit,
    data: () => data,
    pages: () => model.pages,
    owner: () => owner,
    repo: () => repo,
    repoId: () => repoId,
    omrClient,
  });

  // The work as the draft, the submission and its checks read it.
  const work: ZoneWork & SubmitState = {
    get omr() {
      return omr;
    },
    get naming() {
      return naming;
    },
    get pages() {
      return model.pages;
    },
    get rawLayouts() {
      return model.rawLayouts;
    },
    get named() {
      return model.named;
    },
    get recognition() {
      return transcriber.recognition;
    },
    get seen() {
      return model.seen;
    },
    get shownNamed() {
      return instruments.shownNamed;
    },
    get namingModels() {
      return instruments.namingModels;
    },
    get runningKey() {
      return transcriber.runningKey;
    },
    get recognisedKey() {
      return transcriber.recognisedKey;
    },
    get staffKey() {
      return transcriber.staffKey;
    },
  };
  // Why the task cannot be submitted yet, or null when it can.
  const submitBlock = $derived(submitBlockOf(work));

  // While the task is held, its boxes are saved as a draft after each pause
  // in editing. A drag in progress (ed.dragging) defers it to the drag's end,
  // so the score is not serialised on every pointer move.
  $effect(() => {
    if (ed.dragging || !session.canEdit || model.pages.length === 0) return;
    session.draft(draftInput(work, omrModels.layoutModel));
  });

  const submit = () =>
    run(
      (c) =>
        omr
          ? invoke(
              commands.submitOmrLayout,
              {
                task_id: taskId,
                ...layoutSubmission(work, omrModels.layoutModel),
              },
              c,
            )
          : invoke(
              commands.submitZones,
              { task_id: taskId, pages: toPageModels(model.pages, omr) },
              c,
            ),
      { overviewOnSuccess: true },
    );

  const detection: LayoutDetection = new LayoutDetection({
    model,
    runner,
    omr: () => omr,
    canEdit: () => canEdit,
    data: () => data,
    taskId: () => taskId,
    repoId: () => repoId,
    owner: () => owner,
    repo: () => repo,
    omrClient,
    detected: () => {
      setLayoutStep(1);
      ed.resetHistory();
    },
  });

  // Each step starts at the top of the first page.
  function setLayoutStep(step: LayoutStep) {
    steps.layoutStep = step;
    view.step4Pages = false;
    view.step4Top.names = view.step4Top.pages = 0;
    ed.setDrawMode(false);
    view.showPage(0);
  }

  // Page p's boxes changed: re-sort the active layer and record the step.
  function settle(p: number) {
    model.resortLayer(p, steps.tool);
    ed.commit();
  }

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

  // What one box of the active layer is called.
  const boxName = $derived(boxNameOf(steps.tool));

  // The page's keys. Text fields keep their own keys; undo, redo and Esc
  // work from any other control; the editing keys (A, D, N, Delete, the
  // arrows) only on the pages or with nothing focused, so a key on a panel
  // control never moves a box or turns a page. While a drag or a Shift+drag
  // is under way, Esc undoes it and the other keys do nothing.
  function keydown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable]")) return;
    if (ed.keydown(e)) return;
    if (e.key === "Escape" && (helpOpen || viewOpen || sel.selected)) {
      if (helpOpen) helpOpen = false;
      else if (viewOpen) viewOpen = false;
      else ed.select(0, null);
      return;
    }
    if (target !== document.body && !target.closest(".desk")) return;
    if ((e.key === "Delete" || e.key === "Backspace") && sel.selected) {
      e.preventDefault();
      ed.deleteSelection();
    } else if (
      (e.key === "a" || e.key === "A" || e.key === "d" || e.key === "D") &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      // The keys leave the view where it is.
      sel.stepSelection(e.key === "a" || e.key === "A" ? -1 : 1, false);
    } else if (
      (e.key === "n" || e.key === "N") &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      sel.newBox();
    } else if (e.key.startsWith("Arrow") && canEdit && sel.selectedItem) {
      // A selected box takes the arrow keys; without one, ← → turn pages.
      ed.nudge(e, sel.selectedItem.p, sel.selectedItem.item);
    } else if (e.key === "ArrowRight") {
      view.go(1);
    } else if (e.key === "ArrowLeft") {
      view.go(-1);
    }
  }

  // The editor help and the View options behind the toolbar's ⋯ button.
  let helpOpen = $state(false);
  let viewOpen = $state(false);
  // A press outside the View options closes them.
  function closeViewOutside(e: PointerEvent) {
    if (viewOpen && !(e.target as Element).closest(".viewmenu, .viewbtn"))
      viewOpen = false;
  }
</script>

<svelte:head>
  <title>{taskTitle} · {session.pieceName || campaign} · Let's Encode!</title>
</svelte:head>

<svelte:window onpointerdown={closeViewOutside} onkeydown={keydown} />

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
  class="corrector sidehost"
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
    <div class="main">
      <h1 class="vh">{taskTitle} · {session.pieceName || campaign}</h1>
      <ZoneToolbar
        {view}
        bar={toolbar}
        step4={steps.step4}
        {canEdit}
        {coarse}
        {boxName}
        {omr}
        bind:helpOpen
        bind:viewOpen
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
        bind:helpOpen
        bind:viewOpen
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
        oncompose={() => compose++}
      />
    {/snippet}

    <!-- The task's action at the panel's bottom: the claim or the draft
         state and give back, then the next step or the submission. -->
    {#snippet footer()}
      <ZoneFooter
        {session}
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
        class="btn btn-secondary"
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
          prefill={sel.reviewPrefill}
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
  /* The whole tool: the desk the page sheets float on (the only scrolling
     region), with the side panel — carrying the task box — beside it.
     The app's navigation bar and footer come from the layout, as on every
     other page. */
  .corrector {
    flex: 1;
    min-height: 0;
    display: flex;
    background: var(--desk);
    box-shadow: var(--shadow-inset);
  }
  /* The side panel brings no outer spacing of its own; the score view's
     host row provides it there. Docked below the tool it spans the width. */
  .corrector > :global(.spwrap:not(.docked)) {
    margin: 12px 16px 4px 0;
  }
  /* A phone sheet: less space around the steps and the selection's heading. */
  @media (orientation: portrait) and (max-width: 559px) {
    .corrector :global(.sptools) {
      padding-block: 6px;
    }
    .corrector :global(.spsel) {
      padding-block: 8px 10px;
    }
  }
  /* The layers' hues, as "r, g, b" for rgba(): on the paper they stay the
     same in both themes. The --ink-* colours for text and glyphs beside the
     paper are theme tokens (theme.css). */
  .corrector {
    --layer-staff: 128, 34, 64;
    --layer-grand: 38, 100, 60;
    --layer-measure: 14, 129, 149;
    --layer-movement: 139, 95, 191;
    --layer-system: 36, 82, 178;
  }
  /* Banner styles are shared app-wide in ui.css. */
  /* The desk column beside the sidebar: the paging and zoom toolbar on top,
     result banners over the desk. */
  /* The tool column: its toolbar's top edge and the side panel's are one
     line, 12px below the navigation bar. */
  .main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
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
