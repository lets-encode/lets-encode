<script module lang="ts">
  // The source side's share of the work area's width in each step, kept
  // across tasks for the session, as the wizard keeps its panes' sizes. Step
  // 2 gives the preview, where the groups are marked, most of the width.
  const split = $state<Record<1 | 2, number>>({ 1: 0.5, 2: 0.3 });
</script>

<script lang="ts">
  import { commentAnchor } from "$lib/campaign-tables.ts";
  import PageState from "$lib/components/PageState.svelte";
  import { page } from "$app/state";
  import type { Snippet } from "svelte";
  import { recordCampaignTitle } from "$lib/campaign-title.svelte.ts";
  import { auth } from "$lib/auth.svelte.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import {
    DOCKED_QUERY,
    PANEL_MIN_REVIEW,
    readSidePanel,
  } from "$lib/side-panels.ts";
  import { MediaQuery } from "svelte/reactivity";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import RunnerBanner from "$lib/components/RunnerBanner.svelte";
  import TaskPageSidePanel from "$lib/components/TaskPageSidePanel.svelte";
  import TaskRunState from "$lib/components/TaskRunState.svelte";
  import PreTaskBox from "$lib/components/PreTaskBox.svelte";
  import ReviewActions from "$lib/components/ReviewActions.svelte";
  import DraftBubble from "$lib/components/DraftBubble.svelte";
  import { PreTaskSession } from "$lib/pre-task-session.svelte.ts";
  import type { StaffGroupModel } from "$lib/mei-facsimile.ts";
  import { firstMeasureOf } from "$lib/setup/source-frame.ts";
  import { SetupModel } from "$lib/setup/setup-model.svelte.ts";
  import { SetupPreview } from "$lib/setup/setup-preview.svelte.ts";
  import { GroupMarking } from "$lib/setup/group-marking.svelte.ts";
  import { StaffListEditor } from "$lib/setup/staff-list.svelte.ts";
  import { SetupRecognition } from "$lib/setup/setup-recognition.svelte.ts";
  import { SetupSubmission } from "$lib/setup/setup-submission.svelte.ts";
  import SetupSourcePane from "$lib/components/setup/SetupSourcePane.svelte";
  import SetupPreviewPane from "$lib/components/setup/SetupPreviewPane.svelte";
  import SetupSummary from "$lib/components/setup/SetupSummary.svelte";
  import SetupForm from "$lib/components/setup/SetupForm.svelte";
  import SetupSteps from "$lib/components/setup/SetupSteps.svelte";
  import SetupFooter from "$lib/components/setup/SetupFooter.svelte";

  // The URL carries the campaign name and task; the repo is resolved from the
  // name (name → stable repo id → current owner/name) — see resolveCampaign.
  const campaign = $derived(page.params.campaign!);
  const taskId = $derived(page.params.task!);

  // The form's working copy of the score definition.
  const model = new SetupModel({
    canEdit: () => canEdit,
    taskId: () => taskId,
  });

  const session = new PreTaskSession(
    () => campaign,
    () => taskId,
    {
      loaded(d) {
        model.load(d);
      },
      // A claim of an OMR piece's setup task continues into the piece's
      // recognition in the same overlay.
      afterClaim(f, d) {
        if (!(d.preparation === "omr" && session.canEdit)) return null;
        recognition.recognisedFor = taskId;
        return recognition.steps(f, d);
      },
    },
  );
  const runner = session.runner;
  // The piece's recognition (an OMR-prepared piece); its service's calls
  // stop when the page goes away.
  const recognition: SetupRecognition = new SetupRecognition(
    session,
    () => taskId,
    model,
  );
  const data = $derived(session.data);
  const holds = $derived(session.holds);
  // Only the volunteer holding the task edits it; everyone else, and everyone
  // once it is done, sees its values read-only without the editing buttons.
  const canEdit = $derived(session.canEdit);
  const busy = $derived(session.busy);
  const repoId = $derived(session.campaign.repoId);
  const tables = $derived(session.tables);
  $effect(() => {
    if (tables) recordCampaignTitle(campaign, tables.title);
  });
  const viewer = $derived(session.viewer);

  // ------------------------------------------------------------- comments
  // The side panel beside the tool. Posting and resolving refresh the tables
  // only: a full reload would discard unsubmitted form values.
  let sidePanel = $state(readSidePanel());
  // The source side of the work area: the first measure's page, framed on
  // the measure and the names in front of its system, the measure outlined
  // (source-frame.ts). A comment anchor shows its page whole until the fit
  // button returns.
  const firstMeasure = $derived(firstMeasureOf(data?.model.pages));
  let anchorPage = $state<number | null>(null);
  function showAnchorFor(c: CommentRow) {
    const p = commentAnchor(c).page - 1;
    anchorPage = data && p >= 0 && p < data.model.pages.length ? p : null;
  }
  const shownPage = $derived(anchorPage ?? firstMeasure?.page ?? 0);
  // The anchor a change request opens with: the page shown.
  const reviewPrefill = () => ({ page: String(shownPage + 1), m1: "", m2: "" });

  // The divider moves the boundary between the source and the preview; each
  // keeps at least a fifth of the width.
  let desk = $state<HTMLDivElement>();

  // The form sits in the side panel. Docked below the score as a sheet
  // (DOCKED_QUERY) it shows one section at a time, chosen by a switch.
  const dockedQuery = new MediaQuery(DOCKED_QUERY, false);
  const docked = $derived(dockedQuery.current);
  // The setup's two steps: the staves with the key and time signature, then
  // the groups.
  let setupStep = $state<1 | 2>(1);
  let panelTab = $state<"selection" | "comments">("selection");

  // The preview of the setup beside the source.
  const preview = new SetupPreview(model, {
    data: () => data,
    firstMeasure: () => firstMeasure,
    anchorPage: () => anchorPage,
    markable: () => markable,
  });
  // Groups are marked in step 2, by the volunteer holding the task.
  const markable = $derived(
    canEdit && setupStep === 2 && model.staves.length > 1,
  );
  // While a reviewer's change request form is open (ReviewActions), a click
  // on a staff (on the page or in the summary) or on a group in the summary
  // fills its staff field.
  let reviewAsking = $state(false);
  let staffPick = $state<{ text: string } | null>(null);
  function pickStaff(i: number) {
    if (!reviewAsking) return;
    const label = model.staves[i]?.label;
    staffPick = { text: label ? `${i + 1} (${label})` : `${i + 1}` };
  }
  function pickGroup(g: StaffGroupModel) {
    if (!reviewAsking) return;
    staffPick = { text: `${g.start}–${g.end} (${g.symbol})` };
  }
  const marking = new GroupMarking(model, preview, {
    markable: () => markable,
    step: () => setupStep,
    picking: () => reviewAsking,
    pickStaff,
  });
  const staffList = new StaffListEditor(model, marking);
  const submission = new SetupSubmission(
    session,
    () => taskId,
    model,
    recognition,
  );

  // The page's effects, in this order: the preview's measuring, the draft,
  // the recognition, the groups' one-instrument guess, the transpositions
  // from the labels, the preview's render, its coloured staves and its staff
  // numbers.
  $effect(() => preview.measureRendering());
  $effect(() => submission.saveDraft());
  $effect(() => recognition.startWhenHeld());
  $effect(() => model.followInstrumentGuess());
  $effect(() => model.fillLabelsOnce());
  $effect(() => preview.render());
  $effect(() => preview.lightStaves(marking.lit));
  $effect(() => preview.observeSheet());

  const coarseQuery = new MediaQuery("(pointer: coarse)", false);
  const tapWord = $derived(coarseQuery.current ? "Tap" : "Click");
  // Docked, the sheet shows the marking line or the open group until it is
  // opened; the list of groups is in the opened sheet.
  let sheetOpen = $state(false);
  const compact = $derived(docked && !sheetOpen);
  function goStep(step: 1 | 2) {
    setupStep = step;
    marking.clearMark();
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape" && marking.markFrom !== null) marking.clearMark();
  }}
/>

<svelte:head>
  <title>Score setup · {session.pieceName || campaign} · Let's Encode!</title>
</svelte:head>

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
      coarseQuery.current &&
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
    <PageState loading="the score" />
  {:else if session.loadError}
    <PageState error={session.loadError} onretry={() => session.load()} />
  {:else if data}
    <!-- The work area: the source's first measure beside the preview of
         the setup, split by a divider that moves the boundary. A piece
         without page images has the preview alone. -->
    <div class="main">
      <h1 class="vh">Score setup · {session.pieceName || campaign}</h1>
      <div class="runrow"><TaskRunState task={taskId} {repoId} pill /></div>
      <div class="desk" bind:this={desk}>
        {#if firstMeasure && data.imageUrls[shownPage]}
          <SetupSourcePane
            url={data.imageUrls[shownPage]}
            page={data.model.pages[shownPage]}
            {shownPage}
            {firstMeasure}
            {anchorPage}
            onfit={() => (anchorPage = null)}
            align={preview.align}
            {desk}
            bind:split={() => split[setupStep], (v) => (split[setupStep] = v)}
            bind:facsW={preview.facsW}
            bind:facsH={preview.facsH}
          />
        {/if}
        <SetupPreviewPane
          {preview}
          meterValid={model.meterValid}
          groupsValid={model.groupsValid}
          {markable}
          picking={reviewAsking}
          lit={marking.lit}
          onpointerdown={(e) => marking.sheetDown(e)}
          onpointermove={(e) => marking.sheetMove(e)}
          onclick={(e) => marking.sheetClick(e)}
        />
      </div>
      <DraftBubble {session} />
    </div>

    <!-- The setup form, in the side panel's Setup tab. -->
    {#snippet setupForm()}
      {#if !holds}
        <SetupSummary
          {model}
          {preview}
          {marking}
          picking={reviewAsking}
          onpickstaff={pickStaff}
          onpickgroup={pickGroup}
        />
      {:else}
        <SetupForm
          {model}
          {staffList}
          {marking}
          {preview}
          {canEdit}
          hasNotation={data?.hasNotation}
          {docked}
          step={setupStep}
          ongo={goStep}
          {markable}
          {compact}
          {tapWord}
        />
      {/if}
    {/snippet}

    <!-- The task tools: the setup's steps, and transcribing failed
         staves again (an OMR-prepared piece). -->
    {#snippet tools()}
      {#if !docked}<SetupSteps
          step={setupStep}
          staves={model.staves.length}
          groups={model.groups.length}
          ongo={goStep}
        />{/if}
      {#if recognition.omr && canEdit && recognition.result && recognition.result.failed.length > 0}
        <button
          type="button"
          class="btn"
          onclick={() => recognition.recognise()}
          disabled={busy}
          title="Run the staff model again on the {recognition.result.failed
            .length} staves it could not transcribe"
        >
          Transcribe failed staves again
        </button>
      {/if}
    {/snippet}

    <!-- The task's action at the panel's bottom. -->
    {#snippet footer()}
      <SetupFooter
        {session}
        {model}
        {recognition}
        {submission}
        step={setupStep}
        ongo={goStep}
      />
    {/snippet}

    <!-- The viewer's verdict and Give back task, at the panel's bottom. -->
    {#snippet reviewFooter()}
      {#if session.card && session.reviewSub !== undefined}
        <ReviewActions
          {repoId}
          task={session.card.task}
          sub={session.reviewSub}
          runner={session.runner}
          prefill={reviewPrefill}
          measures={false}
          staffs
          {staffPick}
          bind:asking={reviewAsking}
          onvalidate={(sub, verdict, comment) =>
            session.validate(sub, verdict, comment)}
          onreviewedit={(sub, comment) => session.reviewEdit(sub, comment)}
          onabandon={(sub) => session.abandon(sub)}
        />
      {/if}
    {/snippet}

    <!-- The last command's result, in the task box. -->
    {#snippet resultNote()}
      <RunnerBanner {runner} surface="inline" />
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
          : undefined}
        {taskBox}
        tools={canEdit ? tools : undefined}
        selection={setupForm}
        selectionLabel="Setup"
        selectionActive={canEdit}
        bind:tab={panelTab}
        bind:open={sheetOpen}
        footer={session.footerMode === "edit"
          ? footer
          : session.footerMode === "review"
            ? reviewFooter
            : undefined}
        onanchor={showAnchorFor}
        oncomment={(...args) => session.postComment(...args)}
        onresolve={(id) => session.resolveComment(id)}
      />
    {/if}
  {/if}
</div>

<style>
  /* The whole tool: the form and its preview on the desk, with the comments
     panel — carrying the task box — beside it. The app's navigation bar and
     footer come from the layout, as on every other page. */
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
  .main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  /* The run state's pill above the work area; takes room only while shown. */
  .runrow {
    flex: none;
  }
  .runrow:has(:global(.runstate)) {
    padding: 12px 16px 0;
  }
  /* The source's first measure on the left, the preview of the setup
     beside it, both at the work area's full height, the divider (.pane-grip
     in ui.css) between them. */
  .desk {
    flex: 1;
    min-height: 0;
    display: flex;
    padding: 12px 16px;
    box-sizing: border-box;
    overflow: hidden;
  }
  @media (orientation: portrait) and (max-width: 1100px) {
    .desk {
      padding: 8px;
    }
  }
  /* Banner styles are shared app-wide in ui.css. */
</style>
