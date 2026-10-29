<!--
  The encoding alignment of a piece that starts from an uploaded encoding:
  which measure of the file each of the piece's corrected measures holds.
  The score viewer (ScorePreview) shows the pages beside the merged score,
  so each measure box stands next to the music it received. The alignment is
  computed (alignEncoding); where it is wrong, the claim holder fixes the
  selected measure to another file measure or to none, and the measures
  between fixed links are aligned again. Opening the view claims the task;
  the submission commits the merged score and the alignment record.
-->
<script lang="ts">
  import { page } from "$app/state";
  import { auth } from "$lib/auth.svelte.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import { recordCampaignTitle } from "$lib/campaign-title.svelte.ts";
  import type { MeasureAnchor } from "$lib/campaign-tables.ts";
  import { PreTaskSession } from "$lib/pre-task-session.svelte.ts";
  import { readSidePanel } from "$lib/side-panels.ts";
  import {
    differentReason,
    labelRanges,
    pinsOf,
    type FileSlot,
    type Pin,
  } from "$lib/encoding-align.ts";
  import { alignEncoding, type AlignedEncoding } from "$lib/encoding-merge.ts";
  import Icon from "$lib/components/Icon.svelte";
  import PageState from "$lib/components/PageState.svelte";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import MeasureSelection from "$lib/components/MeasureSelection.svelte";
  import PreTaskBox from "$lib/components/PreTaskBox.svelte";
  import PreTaskStatus from "$lib/components/PreTaskStatus.svelte";
  import ReviewActions from "$lib/components/ReviewActions.svelte";
  import RunnerBanner from "$lib/components/RunnerBanner.svelte";
  import ScorePreview from "$lib/components/ScorePreview.svelte";
  import TaskPageSidePanel from "$lib/components/TaskPageSidePanel.svelte";
  import TaskRunState from "$lib/components/TaskRunState.svelte";
  import DraftBubble from "$lib/components/DraftBubble.svelte";

  const campaign = $derived(page.params.campaign!);
  const taskId = $derived(page.params.task!);

  // The fixed links.
  let pins = $state<Pin[]>([]);

  const session = new PreTaskSession(
    () => campaign,
    () => taskId,
    {
      loaded(d) {
        pins = pinsOf(d.alignment);
      },
      reset() {
        pins = [];
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

  const result = $derived.by(
    (): { ok: AlignedEncoding } | { error: string } | null => {
      const d = data;
      if (!d?.upload || !d.campaignScore) return null;
      try {
        return {
          ok: alignEncoding({
            current: d.campaignScore.mei,
            corrected: d.campaignScore.corrected,
            upload: d.upload,
            preparation: d.preparation,
            pins: $state.snapshot(pins),
          }),
        };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
  );
  const aligned = $derived<AlignedEncoding | null>(
    result && "ok" in result ? result.ok : null,
  );

  // The score viewer, and the measure selected in it (a layout measure label).
  let preview = $state<ReturnType<typeof ScorePreview>>();
  let scoreW = $state(0);
  let selectedMeasure = $state<string | null>(null);
  // The measures a problem refers to, highlighted in both panes.
  let anchor = $state<MeasureAnchor | null>(null);

  const selectedBox = $derived.by(() => {
    if (selectedMeasure === null || !aligned) return null;
    const i = aligned.layout.findIndex((m) => m.label === selectedMeasure);
    return i < 0 ? null : i;
  });
  const selectedMatch = $derived(
    selectedBox === null
      ? null
      : (aligned?.alignment.matches[selectedBox] ?? null),
  );

  // The file measures some layout measure holds.
  const held = $derived(
    new Set(
      (aligned?.alignment.matches ?? []).flatMap((s) => (s ? [s.measure] : [])),
    ),
  );

  function fileLabel(slot: FileSlot): string {
    const m = aligned?.file[slot.measure];
    if (!m) return "";
    const label = m.label || String(slot.measure + 1);
    return m.span > 1 ? `${label}·${slot.part + 1}` : label;
  }

  const measuresWord = (list: number[]) =>
    list.length === 1 ? "Measure" : "Measures";

  // The problems worth a look, each one line; `measures` are the layout
  // measures it concerns, highlighted when it is clicked.
  const problems = $derived.by(() => {
    if (!aligned || aligned.summary.kind === "different") return [];
    const { layout, file, alignment, staffMap, staffCount } = aligned;
    const out: { text: string; title: string; measures: number[] }[] = [];
    if (alignment.ambiguous.length)
      out.push({
        text: `${measuresWord(alignment.ambiguous)} ${labelRanges(layout, alignment.ambiguous)}: placement not certain`,
        title:
          "The repeats, endings and breaks do not decide which file measures go here. Check them against the file and fix a measure where it is wrong.",
        measures: alignment.ambiguous,
      });
    const conflicts = alignment.conflicts.flatMap((c, i) => (c ? [i] : []));
    if (conflicts.length)
      out.push({
        text: `${measuresWord(conflicts)} ${labelRanges(layout, conflicts)}: ${conflicts.length === 1 ? "differs" : "differ"} from the file`,
        title:
          "The file measure placed here has a repeat, ending or break the page does not show, or the other way round.",
        measures: conflicts,
      });
    const free = file.flatMap((_, i) => (held.has(i) ? [] : [i]));
    if (free.length)
      out.push({
        text: `File ${measuresWord(free).toLowerCase()} ${labelRanges(file, free)}: no place on the pages`,
        title:
          "These measures of the file are left out of the score. The uploaded file stays in the campaign unchanged.",
        measures: [],
      });
    if (staffMap.length !== staffCount)
      out.push({
        text: `The file has ${staffMap.length} staves, the pages ${staffCount}`,
        title:
          "The file's staves go to the page's staves from the top down; staves without a counterpart stay empty or are left out.",
        measures: [],
      });
    return out;
  });

  // Highlight the first run of a problem's measures and turn to it.
  function showProblem(measures: number[]) {
    if (!aligned || !measures.length) return;
    let last = measures[0];
    while (measures.includes(last + 1)) last++;
    const label = (i: number) => aligned!.layout[i].label;
    const page = preview?.pageOfMeasure(label(measures[0])) ?? -1;
    anchor = {
      page: page + 1,
      m1: parseInt(label(measures[0]), 10) || 0,
      m2: parseInt(label(last), 10) || 0,
    };
    if (page >= 0) preview?.showPage(page);
  }

  // Whether the selected measure's file measure was chosen in the select.
  const chosen = $derived(pins.some((pin) => pin.box === selectedBox));

  /** Fix the selected measure to `slot`, dropping the fixed links out of order with it. */
  function fix(slot: FileSlot | null) {
    const box = selectedBox;
    if (box === null) return;
    pins = [
      ...pins.filter(
        (pin) =>
          pin.box !== box &&
          !(
            slot &&
            pin.slot &&
            (pin.box < box
              ? pin.slot.measure >= slot.measure
              : pin.slot.measure <= slot.measure)
          ),
      ),
      { box, slot },
    ];
  }

  // While the task is held, the fixed links are saved as a draft after each
  // pause in editing.
  $effect(() => {
    if (!canEdit || !aligned) return;
    session.draft({ pins: $state.snapshot(pins) });
  });

  const submit = () =>
    session.run(
      (c) =>
        invoke(
          commands.submitEncodingAlignment,
          { task_id: taskId, pins: $state.snapshot(pins) },
          c,
        ),
      { overviewOnSuccess: true },
    );

  let reviewAsking = $state(false);
  const reviewPrefill = () => {
    const page = selectedMeasure
      ? (preview?.pageOfMeasure(selectedMeasure) ?? -1)
      : -1;
    return selectedMeasure && page >= 0
      ? { page: String(page + 1), m1: selectedMeasure, m2: selectedMeasure }
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
    onContinue={() => runner.dismiss()}
  />
{/if}

<div class="aligner sidehost" data-stage="pre">
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
  {:else if result && "error" in result}
    <PageState
      error={`Could not align the uploaded encoding: ${result.error}`}
    />
  {:else if data && aligned}
    <div class="scorecol" bind:clientWidth={scoreW}>
      <h1 class="vh">Encoding alignment · {session.pieceName || campaign}</h1>
      <div class="runrow"><TaskRunState task={taskId} pill /></div>
      {#if scoreW > 0}
        <ScorePreview
          bind:this={preview}
          owner={session.campaign.owner}
          repo={session.campaign.repo}
          fragment={data.fragment}
          mei={aligned.merged.mei}
          {anchor}
          initialPane={scoreW - 32 < 560 ? "facs" : "both"}
          onmeasureselect={(label) => (selectedMeasure = label)}
        />
      {/if}
      <DraftBubble {session} />
    </div>

    {#snippet selection()}
      <MeasureSelection
        label={selectedMeasure}
        page={selectedMeasure
          ? (preview?.pageOfMeasure(selectedMeasure) ?? -1)
          : -1}
        {preview}
        oncomment={auth.user ? () => (panelTab = "comments") : undefined}
        empty="Select a measure on the score to see which file measure it holds."
      >
        {#if selectedBox !== null}
          <p class="selflagtext">
            {selectedMatch
              ? `Holds file measure ${fileLabel(selectedMatch)}`
              : "Holds no file measure"}
          </p>
        {/if}
        {#snippet actions()}
          {#if canEdit && selectedBox !== null}
            <select
              class="ctl"
              value={selectedMatch ? String(selectedMatch.measure) : ""}
              onchange={(e) => {
                const v = e.currentTarget.value;
                fix(v === "" ? null : { measure: Number(v), part: 0 });
              }}
              aria-label="File measure for this measure"
              title="Choose the file measure this measure holds, or none. The measures around it are placed again to fit."
            >
              <option value="">No file measure</option>
              {#each aligned.file as m, i (i)}
                <option value={String(i)}
                  >File measure {m.label || i + 1}{held.has(i)
                    ? ""
                    : " (no place)"}</option
                >
              {/each}
            </select>
            {#if chosen}
              <button
                type="button"
                class="btn"
                onclick={() =>
                  (pins = pins.filter((pin) => pin.box !== selectedBox))}
                title="Let the alignment choose the file measure for this measure again"
                ><Icon name="wand" />Place automatically</button
              >
            {/if}
          {/if}
        {/snippet}
      </MeasureSelection>
      {#if aligned.summary.kind === "different"}
        <p class="msg-error">{differentReason(aligned.summary)}</p>
      {:else if problems.length}
        <ul class="problems">
          {#each problems as problem (problem.text)}
            <li>
              <Icon name="warning" size={14} />
              {#if problem.measures.length}
                <button
                  type="button"
                  class="linkish"
                  title={problem.title}
                  onclick={() => showProblem(problem.measures)}
                  >{problem.text}</button
                >
              {:else}
                <span title={problem.title}>{problem.text}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/snippet}

    {#snippet footer()}
      <div class="wfoot">
        <span class="abcount wsum">
          {aligned.summary.filled} of {aligned.layout.length} measures from the file
          {#if aligned.summary.empty}· {aligned.summary.empty} empty{/if}
        </span>
        <span class="wstatus"><PreTaskStatus {session} /></span>
        <button
          type="button"
          class="btn btn-primary btn-pre"
          onclick={() => submit()}
          disabled={session.busy ||
            !canEdit ||
            aligned.summary.kind === "different"}
          title={aligned.summary.kind === "different"
            ? differentReason(aligned.summary)
            : "Submit the measures placed from the file for review"}
        >
          Submit alignment
        </button>
      </div>
    {/snippet}

    {#snippet reviewFooter()}
      {#if session.card && session.reviewSub !== undefined}
        <ReviewActions
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
      <RunnerBanner {runner} bar collapsible />
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
        {tables}
        {taskId}
        done={data.status === "completed"}
        viewer={session.viewer}
        {runner}
        bind:panel={sidePanel}
        {taskBox}
        {selection}
        selectionLabel="Alignment"
        selectionActive
        bind:tab={panelTab}
        bind:open={sheetOpen}
        footer={data.status === "encoding_required"
          ? footer
          : session.reviewSub !== undefined
            ? reviewFooter
            : undefined}
        onanchor={() => {}}
        oncomment={(...args) => session.postComment(...args)}
        onresolve={(id) => session.resolveComment(id)}
      />
    {/if}
  {/if}
</div>

<style>
  .aligner {
    flex: 1;
    min-height: 0;
    display: flex;
    background: var(--desk);
    box-shadow: var(--shadow-inset);
  }
  .aligner > :global(.spwrap:not(.docked)) {
    margin: 12px 16px 4px 0;
  }
  /* The score column: the viewer's toolbar and the side panel share their
     top edge, as in the review view. */
  .scorecol {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
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
  .problems {
    list-style: none;
    margin: 12px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
    color: var(--ink-soft);
  }
  .problems li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .problems :global(svg) {
    flex: none;
    color: var(--warn-solid);
  }
  .wfoot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .wsum {
    flex-basis: 100%;
  }
  .wstatus {
    flex: 1;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    min-width: 0;
  }
  .abcount {
    font-size: 12.5px;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
