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
  import {
    commentAnchor,
    type CommentRow,
    type MeasureAnchor,
  } from "$lib/campaign-tables.ts";
  import { PreTaskSession } from "$lib/pre-task-session.svelte.ts";
  import { readSidePanel } from "$lib/side-panels.ts";
  import {
    addFileMeasure,
    differentReason,
    fileEditsOf,
    labelRanges,
    pinsOf,
    scoreStavesOf,
    shiftPins,
    withoutAddedMeasure,
    type FileEdits,
    type FileSlot,
    type Pin,
  } from "$lib/encoding-align.ts";
  import {
    alignEncoding,
    type AlignedEncoding,
    type EncodingInput,
  } from "$lib/encoding-merge.ts";
  import { usesOmr } from "$lib/campaign-init.ts";
  import AlignStaves from "$lib/components/AlignStaves.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import PageState from "$lib/components/PageState.svelte";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import MeasureSelection from "$lib/components/MeasureSelection.svelte";
  import PreTaskBox from "$lib/components/PreTaskBox.svelte";
  import PreTaskStatus from "$lib/components/PreTaskStatus.svelte";
  import ReviewActions from "$lib/components/ReviewActions.svelte";
  import RunnerBanner from "$lib/components/RunnerBanner.svelte";
  import ScorePreview from "$lib/components/ScorePreview.svelte";
  import StepGlyph from "$lib/components/StepGlyph.svelte";
  import TaskPageSidePanel from "$lib/components/TaskPageSidePanel.svelte";
  import TaskRunState from "$lib/components/TaskRunState.svelte";
  import DraftBubble from "$lib/components/DraftBubble.svelte";

  const campaign = $derived(page.params.campaign!);
  const taskId = $derived(page.params.task!);

  // The fixed links, the score staves and the file measure edits chosen.
  let pins = $state<Pin[]>([]);
  let scoreStaves = $state<(number | null)[] | undefined>();
  let fileEdits = $state<FileEdits>({ removed: [], added: [] });
  // The panel's step chosen: 1 the staves, 2 the measures; null before any.
  let stepChoice = $state<1 | 2 | null>(null);

  const session = new PreTaskSession(
    () => campaign,
    () => taskId,
    {
      loaded(d) {
        pins = pinsOf(d.alignment);
        scoreStaves = scoreStavesOf(d.alignment);
        fileEdits = fileEditsOf(d.alignment);
        stepChoice = null;
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

  const input = $derived.by((): EncodingInput | null => {
    const d = data;
    if (!d?.upload || !d.campaignScore) return null;
    return {
      current: d.campaignScore.mei,
      corrected: d.campaignScore.corrected,
      upload: d.upload,
      preparation: d.preparation,
      pins: $state.snapshot(pins),
      scoreStaves: $state.snapshot(scoreStaves),
      fileEdits: $state.snapshot(fileEdits),
    };
  });
  const aligned = $derived.by((): AlignedEncoding | null =>
    input ? alignEncoding(input) : null,
  );

  // The file staves used, and whether the automatic map uses every file
  // staff in order: then, without staves chosen, the panel opens on the
  // measures.
  const usedStaves = $derived(
    aligned?.scoreStaves.filter((s) => s !== null) ?? [],
  );
  const step = $derived(
    stepChoice ??
      (scoreStaves === undefined &&
      aligned &&
      usedStaves.length === aligned.fileStaves.length &&
      usedStaves.every((s, i) => s === i + 1)
        ? 2
        : 1),
  );
  // The automatic score staves, for marking the reviewer's changed rows.
  const automatic = $derived(
    !canEdit && step === 1 && input && scoreStaves !== undefined
      ? alignEncoding({ ...input, scoreStaves: undefined }).scoreStaves
      : null,
  );

  // The score viewer, and the measure selected in it: a layout measure label
  // and, where the viewer knows it, its position among the layout measures.
  let preview = $state<ReturnType<typeof ScorePreview>>();
  let scoreW = $state(0);
  let selectedMeasure = $state<string | null>(null);
  let selectedAt = $state<number | null>(null);
  // The measures a problem refers to, highlighted in both panes.
  let anchor = $state<MeasureAnchor | null>(null);

  const selectedBox = $derived.by(() => {
    if (selectedMeasure === null || !aligned) return null;
    if (selectedAt !== null)
      return selectedAt < aligned.layout.length ? selectedAt : null;
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

  // The empty measures added to the file.
  const addedIds = $derived(new Set(aligned?.fileAdded.map((a) => a.id)));

  /** A file measure's label, else its place in the file before the edits. */
  const ownLabel = (id: string, label: string) =>
    label || String((aligned?.fileIds.indexOf(id) ?? 0) + 1);

  function fileLabel(slot: FileSlot): string {
    const m = aligned?.file[slot.measure];
    if (!m) return "";
    const label = ownLabel(m.id, m.label);
    return m.span > 1 ? `${label}·${slot.part + 1}` : label;
  }

  /** Change the file measure edits; the fixed links stay on their measures. */
  function editFile(next: FileEdits) {
    if (!aligned) return;
    pins = shiftPins(pins, aligned.fileIds, fileEdits, next);
    fileEdits = next;
  }

  /** Remove file measure `i` (of the edited file) from the file. */
  function removeFileMeasure(i: number) {
    const id = aligned?.file[i]?.id;
    if (!id) return;
    editFile(
      addedIds.has(id)
        ? withoutAddedMeasure(fileEdits, id)
        : { removed: [...fileEdits.removed, id], added: fileEdits.added },
    );
  }

  // The changes to the file's measures, each with its undo.
  const fileChanges = $derived.by(() => {
    if (!aligned) return [];
    const { file, fileAdded, fileRemoved } = aligned;
    return [
      ...fileAdded.map((a) => {
        const k = file.findIndex((m) => m.id === a.id);
        const before = file
          .slice(0, k)
          .reverse()
          .find((m) => !addedIds.has(m.id));
        return {
          key: a.id,
          added: true,
          text: before
            ? `Empty measure added after file measure ${ownLabel(before.id, before.label)}`
            : "Empty measure added at the start",
          undo: () => editFile(withoutAddedMeasure(fileEdits, a.id)),
        };
      }),
      ...fileRemoved.map((r) => ({
        key: r.id,
        added: false,
        text: `File measure ${ownLabel(r.id, r.label)} removed`,
        undo: () =>
          editFile({
            removed: fileEdits.removed.filter((id) => id !== r.id),
            added: fileEdits.added,
          }),
      })),
    ];
  });

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
          "The file's staves go to the page's staves from the top down or, where the pages name their instruments, to the staves with the same clef and the same place in a brace; staves without a counterpart stay empty or are left out.",
        measures: [],
      });
    const { movedEvents, crossStaffRemoved, neighbourRemoved, droppedGroups } =
      aligned.merged;
    if (movedEvents)
      out.push({
        text: `${movedEvents} ${movedEvents === 1 ? "mark" : "marks"} moved to the first staff from the file`,
        title:
          "Tempo, rehearsal marks, directions and dynamics on staves that are left out now stand on the first staff that comes from the file.",
        measures: [],
      });
    const crossStaff = crossStaffRemoved + neighbourRemoved;
    if (crossStaff)
      out.push({
        text: `${crossStaff} cross-staff ${crossStaff === 1 ? "note" : "notes"} returned to ${crossStaff === 1 ? "its" : "their"} own staff`,
        title:
          "These notes, chords, rests or beams were drawn on a staff that is left out or no longer next to theirs, so they stay on their own staff.",
        measures: [],
      });
    if (droppedGroups)
      out.push({
        text: `${droppedGroups} ${droppedGroups === 1 ? "brace or bracket" : "braces or brackets"} left out`,
        title:
          "A brace or bracket of the file is kept only where all its staves are used and stand next to each other in the same order.",
        measures: [],
      });
    for (const p of aligned.problems)
      out.push({
        text: p.text,
        title:
          "The merged score names something it does not contain. Submit is held until this is fixed.",
        measures: p.measure === null ? [] : [p.measure],
      });
    return out;
  });

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
    session.draft({
      pins: $state.snapshot(pins),
      scoreStaves: $state.snapshot(scoreStaves),
      fileEdits: $state.snapshot(fileEdits),
    });
  });

  const submit = () =>
    session.run(
      (c) =>
        invoke(
          commands.submitEncodingAlignment,
          {
            task_id: taskId,
            pins: $state.snapshot(pins),
            scoreStaves: $state.snapshot(scoreStaves),
            fileEdits: $state.snapshot(fileEdits),
          },
          c,
        ),
      { overviewOnSuccess: true },
    );

  let reviewAsking = $state(false);
  const reviewPrefill = () => {
    const page = selectedMeasure
      ? (preview?.pageOfMeasure(selectedMeasure, selectedAt) ?? -1)
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
    outcome={runner.result?.outcome}
    message={runner.result?.message}
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
  {:else if data && aligned}
    <div class="scorecol" bind:clientWidth={scoreW}>
      <h1 class="vh">Encoding alignment · {session.pieceName || campaign}</h1>
      <div class="runrow">
        <TaskRunState task={taskId} repoId={session.campaign.repoId} pill />
      </div>
      {#if scoreW > 0}
        <ScorePreview
          bind:this={preview}
          owner={session.campaign.owner}
          repo={session.campaign.repo}
          fragment={data.fragment}
          mei={aligned.merged.mei}
          {anchor}
          initialPane={scoreW - 32 < 560 ? "facs" : "both"}
          onmeasureselect={(label, index) => {
            selectedMeasure = label;
            selectedAt = index;
          }}
        />
      {/if}
      <DraftBubble {session} />
    </div>

    <!-- The task tools: the alignment's two steps. -->
    {#snippet tools()}
      <div
        class="steps"
        role="group"
        aria-label="Steps"
        title="The two steps of the encoding alignment."
      >
        {#each [{ step: 1, glyph: "staves", tone: "var(--ink-staff)", long: "Staves", count: `${usedStaves.length} of ${aligned.fileStaves.length} used`, n: `${usedStaves.length}/${aligned.fileStaves.length}` }, { step: 2, glyph: "measure", tone: "var(--ink-measure)", long: "Measures", count: `${aligned.summary.filled} of ${aligned.layout.length}`, n: `${aligned.summary.filled}/${aligned.layout.length}` }] as st (st.step)}
          <button
            type="button"
            class="step"
            class:on={step === st.step}
            aria-pressed={step === st.step}
            onclick={() => (stepChoice = st.step as 1 | 2)}
            aria-label={`${st.step} · ${st.long}, ${st.count}`}
            ><span class="stepno">{st.step}</span><StepGlyph
              kind={st.glyph as "staves" | "measure"}
              tone={st.tone}
            /><span class="steplong">{st.long}</span><span class="stepshort"
              >{st.long}</span
            ><span class="stepn">{st.n}</span><span class="stepcount"
              >{st.count}</span
            ></button
          >
        {/each}
      </div>
    {/snippet}

    {#snippet selection()}
      {#if step === 1}
        <AlignStaves
          staves={aligned.scoreStaves}
          fileStaves={aligned.fileStaves}
          names={aligned.layoutStaffNames}
          {automatic}
          fixed={usesOmr(data.preparation)}
          {canEdit}
          chosen={scoreStaves !== undefined}
          onchange={(list) => {
            stepChoice = 1;
            scoreStaves = list;
          }}
        />
      {:else}
        <MeasureSelection
          label={selectedMeasure}
          page={selectedMeasure
            ? (preview?.pageOfMeasure(selectedMeasure, selectedAt) ?? -1)
            : -1}
          {preview}
          oncomment={auth.user ? () => (panelTab = "comments") : undefined}
          empty="Select a measure on the score to see which file measure it holds."
        >
          {#if selectedBox !== null}
            <p class="selflagtext">
              {!selectedMatch
                ? "Holds no file measure"
                : addedIds.has(aligned.file[selectedMatch.measure].id)
                  ? "Holds an added empty measure"
                  : `Holds file measure ${fileLabel(selectedMatch)}`}
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
                    >{addedIds.has(m.id)
                      ? "Added empty measure"
                      : `File measure ${ownLabel(m.id, m.label)}`}{held.has(i)
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
              {#if selectedMatch}
                {@const m = selectedMatch.measure}
                <button
                  type="button"
                  class="btn"
                  onclick={() =>
                    editFile(
                      addFileMeasure(
                        fileEdits,
                        aligned.file.map((f) => f.id),
                        m,
                        "before",
                      ),
                    )}
                  title="Insert an empty measure into the file before the file measure this measure holds"
                  ><Icon name="plus" />Add file measure before</button
                >
                <button
                  type="button"
                  class="btn"
                  onclick={() =>
                    editFile(
                      addFileMeasure(
                        fileEdits,
                        aligned.file.map((f) => f.id),
                        m,
                        "after",
                      ),
                    )}
                  title="Insert an empty measure into the file after the file measure this measure holds"
                  ><Icon name="plus" />Add file measure after</button
                >
                <button
                  type="button"
                  class="btn btn-danger"
                  onclick={() => removeFileMeasure(m)}
                  title="Take the file measure this measure holds out of the file; the file measures after it move up"
                  ><Icon name="trash" />Remove file measure</button
                >
              {/if}
            {/if}
          {/snippet}
        </MeasureSelection>
        {#if fileChanges.length}
          <div class="filechanges">
            <p class="selgroup">Changes to the file's measures</p>
            <ul class="problems">
              {#each fileChanges as change (change.key)}
                <li>
                  <span class="ptext">{change.text}</span>
                  {#if canEdit}
                    <button
                      type="button"
                      class="btn btn-icon"
                      onclick={change.undo}
                      aria-label={change.added
                        ? "Remove this empty measure"
                        : "Put this file measure back"}
                      title={change.added
                        ? "Remove this empty measure from the file"
                        : "Put this file measure back into the file"}
                      ><Icon name={change.added ? "close" : "undo"} /></button
                    >
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      {/if}
      {#if aligned.summary.kind === "different"}
        <p class="msg-error">{differentReason(aligned.summary)}</p>
      {:else if problems.length}
        <ul class="problems">
          {#each problems as problem, i (i)}
            <li>
              <Icon name="warning" size={14} />
              <span class="ptext" title={problem.title}>{problem.text}</span>
              {#if problem.measures.length}
                <button
                  type="button"
                  class="btn"
                  onclick={() => showProblem(problem.measures)}>Show</button
                >
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
            aligned.summary.kind === "different" ||
            aligned.problems.length > 0}
          title={aligned.summary.kind === "different"
            ? differentReason(aligned.summary)
            : aligned.problems.length
              ? "The merged score names staves or elements it does not contain. Fix the problems listed in the panel first."
              : "Submit the measures placed from the file for review"}
        >
          Submit alignment
        </button>
      </div>
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
  /* The changes to the file's measures, under their group name. */
  .filechanges {
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .filechanges .problems {
    margin: 0;
  }
  .problems li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  /* The problem's text, its Show button at the line's right end. */
  .ptext {
    flex: 1;
    min-width: 0;
  }
  .problems > li > :global(svg) {
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
