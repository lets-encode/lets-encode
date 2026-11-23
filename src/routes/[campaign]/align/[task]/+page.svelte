<!--
  The encoding alignment of a piece that starts from an uploaded encoding:
  which measure of the file each of the piece's corrected measures holds.
  The score viewer (ScorePreview) shows the pages beside the merged score,
  so each measure box stands next to the music it received. The alignment is
  computed (alignEncoding); where it is wrong, the claim holder chooses the
  file staff of each score staff (step 1, AlignStaves), and fixes the
  selected measure to another file measure or to none or adds and removes
  file measures (step 2); the measures between fixed links are aligned
  again. Opening the view claims the task;
  the submission commits the merged score and the alignment record.
-->
<script lang="ts">
  import { page } from "$app/state";
  import { auth } from "$lib/auth.svelte.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import { recordCampaignTitle } from "$lib/campaign-title.svelte.ts";
  import { commentAnchor, type CommentRow } from "$lib/campaign-tables.ts";
  import type { MeasureAnchor } from "$lib/editor-units.ts";
  import { PreTaskSession } from "$lib/pre-task-session.svelte.ts";
  import { readSidePanel } from "$lib/side-panels.ts";
  import { AlignEditor } from "$lib/align/align-editor.svelte.ts";
  import { usesOmr } from "$lib/campaign-init.ts";
  import AlignFooter from "$lib/components/align/AlignFooter.svelte";
  import AlignSelection from "$lib/components/align/AlignSelection.svelte";
  import AlignSteps from "$lib/components/align/AlignSteps.svelte";
  import PageState from "$lib/components/PageState.svelte";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import PreTaskBox from "$lib/components/PreTaskBox.svelte";
  import PreTaskStatus from "$lib/components/PreTaskStatus.svelte";
  import ReviewActions from "$lib/components/ReviewActions.svelte";
  import RunnerBanner from "$lib/components/RunnerBanner.svelte";
  import RepoScorePreview from "$lib/components/RepoScorePreview.svelte";
  import TaskPageSidePanel from "$lib/components/TaskPageSidePanel.svelte";
  import TaskRunState from "$lib/components/TaskRunState.svelte";
  import DraftBubble from "$lib/components/DraftBubble.svelte";

  const campaign = $derived(page.params.campaign!);
  const taskId = $derived(page.params.task!);

  const session = new PreTaskSession(
    () => campaign,
    () => taskId,
    {
      loaded(d) {
        editor.load(d.alignment);
      },
    },
  );
  const runner = session.runner;
  const data = $derived(session.data);
  const tables = $derived(session.tables);
  $effect(() => {
    if (tables) recordCampaignTitle(campaign, tables.title);
  });
  const canEdit = $derived(session.canEdit);

  const editor = new AlignEditor({
    source: () => {
      const d = data;
      if (!d?.upload || !d.campaignScore) return null;
      return {
        current: d.campaignScore.mei,
        corrected: d.campaignScore.corrected,
        upload: d.upload,
        preparation: d.preparation,
      };
    },
    canEdit: () => canEdit,
  });
  const aligned = $derived(editor.aligned);

  // The score viewer.
  let preview = $state<ReturnType<typeof RepoScorePreview>>();
  let scoreW = $state(0);
  // The measures a problem refers to, highlighted in both panes.
  let anchor = $state<MeasureAnchor | null>(null);

  // Highlight the first run of a problem's measures and turn to it.
  function showProblem(measures: number[]) {
    if (!aligned || !measures.length) return;
    let last = measures[0];
    while (measures.includes(last + 1)) last++;
    const label = (i: number) => aligned!.layout[i].label;
    const page = preview?.pageOfMeasure(label(measures[0]), measures[0]) ?? -1;
    anchor = {
      page: page + 1,
      m1: parseInt(label(measures[0]), 10) || 0,
      m2: parseInt(label(last), 10) || 0,
    };
    if (page >= 0) preview?.showPage(page);
  }

  // Highlight a comment's measures and turn to their page.
  function showAnchorFor(c: CommentRow) {
    anchor = commentAnchor(c);
    preview?.setZones(true);
    preview?.showPage(anchor.page - 1);
  }

  // While the task is held, the fixed links are saved as a draft after each
  // pause in editing.
  $effect(() => {
    if (!canEdit || !aligned) return;
    session.draft(editor.edits());
  });

  const submit = () =>
    session.run(
      (c) =>
        invoke(
          commands.submitEncodingAlignment,
          { task_id: taskId, ...editor.edits() },
          c,
        ),
      { overviewOnSuccess: true },
    );

  let reviewAsking = $state(false);
  const reviewPrefill = () => {
    const selected = editor.selectedMeasure;
    const page = selected
      ? (preview?.pageOfMeasure(selected, editor.selectedAt) ?? -1)
      : -1;
    return selected && page >= 0
      ? { page: String(page + 1), m1: selected, m2: selected }
      : { page: "", m1: "", m2: "" };
  };

  let sidePanel = $state(readSidePanel());
  let panelTab = $state<"selection" | "comments">("selection");
  let sheetOpen = $state(false);
</script>

<svelte:head>
  <title
    >Encoding alignment · {session.pieceName || campaign} · Let's Encode!</title
  >
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

<div class="workshell sidehost" data-stage="pre">
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
  {:else if data && aligned}
    <div class="workmain scorecol" bind:clientWidth={scoreW}>
      <h1 class="vh">Encoding alignment · {session.pieceName || campaign}</h1>
      <div class="runrow">
        <TaskRunState task={taskId} repoId={session.campaign.repoId} pill />
      </div>
      {#if scoreW > 0}
        <RepoScorePreview
          bind:this={preview}
          owner={session.campaign.owner}
          repo={session.campaign.repo}
          fragment={data.fragment}
          mei={aligned.merged.mei}
          {anchor}
          initialPane={scoreW - 32 < 560 ? "facs" : "both"}
          onmeasureselect={(label, index) => {
            editor.selectedMeasure = label;
            editor.selectedAt = index;
          }}
        />
      {/if}
      <DraftBubble {session} />
    </div>

    {#snippet tools()}
      <AlignSteps
        step={editor.step}
        {aligned}
        used={editor.usedStaves.length}
        ongo={(step) => (editor.stepChoice = step)}
      />
    {/snippet}

    {#snippet selection()}
      <AlignSelection
        {editor}
        {canEdit}
        fixed={usesOmr(data.preparation)}
        {preview}
        oncomment={auth.user ? () => (panelTab = "comments") : undefined}
        onshowproblem={showProblem}
      />
    {/snippet}

    {#snippet status()}
      <PreTaskStatus {session} />
    {/snippet}

    {#snippet footer()}
      <AlignFooter
        {aligned}
        {canEdit}
        busy={session.busy}
        {status}
        onsubmit={submit}
      />
    {/snippet}

    {#snippet reviewFooter()}
      {#if session.card && session.reviewSub !== undefined}
        <ReviewActions
          repoId={session.campaign.repoId}
          task={session.card.task}
          sub={session.reviewSub}
          runner={session.runner}
          prefill={reviewPrefill}
          bind:asking={reviewAsking}
          onvalidate={(sub, verdict, comment) =>
            session.validate(sub, verdict, comment)}
          onreviewedit={(sub, comment) => session.reviewEdit(sub, comment)}
          onabandon={(sub) => session.abandon(sub)}
        />
      {/if}
    {/snippet}

    {#snippet resultNote()}
      <RunnerBanner {runner} surface="inline" />
    {/snippet}

    {#snippet taskBox(headAction: import("svelte").Snippet | undefined)}
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
        repoId={session.campaign.repoId}
        {tables}
        {taskId}
        review={data.status === "validation_required"}
        done={data.status === "completed"}
        viewer={session.viewer}
        {runner}
        bind:panel={sidePanel}
        {taskBox}
        {tools}
        {selection}
        selectionLabel="Alignment"
        selectionActive
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
  /* The score column: the viewer's toolbar and the side panel share their
     top edge, as in the review view. */
  .scorecol {
    position: relative;
    padding: 12px 16px 0;
    box-sizing: border-box;
  }
  /* The run state's pill above the viewer; takes room only while shown. */
  .runrow {
    flex: none;
  }
  .runrow:has(:global(.runstate)) {
    padding-bottom: 12px;
  }
</style>
