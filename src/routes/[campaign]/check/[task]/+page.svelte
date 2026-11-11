<!--
  The score check of the first page task of an 'omr-instruments' piece: the
  clef, key signature and transposition of every staff of the opening score
  definition, and the score's key and meter, as the layout task proposed them
  from the recognition. Each staff is shown beside the scan of the staff box
  where it first appears; the staves of one grand staff share one box and one
  scan. Opening the view claims the task; nothing is saved
  until "Open draft in mei-friend" makes the page's draft with the checked
  definition (openEditor), commits both to the task branch and hands off.
  Once the branch holds the draft, the view shows the checked values
  read-only and opens mei-friend on it.
-->
<script lang="ts">
  import { reviewViewHref } from "$lib/campaign-graph.ts";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { auth } from "$lib/auth.svelte.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import { openMeiFriend } from "$lib/command-runner.svelte.ts";
  import { recordCampaignTitle } from "$lib/campaign-title.svelte.ts";
  import { PreTaskSession } from "$lib/pre-task-session.svelte.ts";
  import { readSidePanel } from "$lib/side-panels.ts";
  import type {
    MeasureBox,
    ScoreDefModel,
    StaffModel,
  } from "$lib/mei-facsimile.ts";
  import {
    namingUnits,
    staffPlan,
    type PlannedStaff,
  } from "$lib/instrument-naming.ts";
  import {
    CLEF_OPTIONS,
    COMMON_CLEFS,
    clefGlyph,
    clefOption,
    clefText,
    setClef,
    setTransposition,
    settleKey,
    transposes,
    unpitched,
  } from "$lib/staff-edit.ts";
  import { keysigText, transpositionFromLabel } from "$lib/transposition.ts";
  import Icon from "$lib/components/Icon.svelte";
  import PageState from "$lib/components/PageState.svelte";
  import GlyphSelect from "$lib/components/GlyphSelect.svelte";
  import MusicGlyph from "$lib/components/MusicGlyph.svelte";
  import KeyTimeFields from "$lib/components/KeyTimeFields.svelte";
  import StaffPitchSelects from "$lib/components/StaffPitchSelects.svelte";
  import StaffCustomPitch from "$lib/components/StaffCustomPitch.svelte";
  import { StaffPitchEditor } from "$lib/staff-pitch.svelte.ts";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import PreTaskBox from "$lib/components/PreTaskBox.svelte";
  import PreTaskStatus from "$lib/components/PreTaskStatus.svelte";
  import RunnerBanner from "$lib/components/RunnerBanner.svelte";
  import TaskPageSidePanel from "$lib/components/TaskPageSidePanel.svelte";
  import TaskRunState from "$lib/components/TaskRunState.svelte";

  const campaign = $derived(page.params.campaign!);
  const taskId = $derived(page.params.task!);

  // The check's working copy of the opening score definition.
  let staves = $state<StaffModel[]>([]);
  let keysig = $state("0");
  let meterType = $state<"numeric" | "common" | "cut">("numeric");
  let meterCount = $state("4");
  let meterUnit = $state("4");
  // The definition as loaded, for the base of the checked one (groups).
  let loadedDef = $state<ScoreDefModel | null>(null);

  const session = new PreTaskSession(
    () => campaign,
    () => taskId,
    {
      loaded(d) {
        const def = d.model.scoreDef;
        loadedDef = def;
        staves = def.staves.map((s) => ({ ...s }));
        keysig = def.keysig;
        meterType =
          def.meterSym === "" ? "numeric" : (def.meterSym as "common" | "cut");
        meterCount = def.meterCount;
        meterUnit = def.meterUnit;
        // The layout task sets no transpositions: for the claim holder
        // before the draft, a staff without one takes the one its
        // instrument's name gives ("Klarinette in A").
        if (d.holdsLock && d.status === "encoding_required" && !d.workSource)
          for (const staff of staves) {
            const name = (
              d.instruments
                ? staffPlan(d.instruments, d.model.pages).staves
                : []
            ).find((s) => s.id === staff.id)?.instrument.name;
            const t = name ? transpositionFromLabel(name) : null;
            if (t && !transposes(staff) && !unpitched(staff))
              setTransposition(keysig, staff, t);
          }
      },
    },
  );
  const runner = session.runner;
  const data = $derived(session.data);
  const tables = $derived(session.tables);
  // A task in review is reviewed in the review view.
  $effect(() => {
    if (data?.status === "validation_required")
      goto(reviewViewHref(campaign, taskId), { replaceState: true });
  });
  $effect(() => {
    if (tables) recordCampaignTitle(campaign, tables.title);
  });
  // The task branch already holds the draft (or work kept from an expired
  // claim): the check was made, and mei-friend opens on that work.
  const drafted = $derived(Boolean(data?.workSource));
  const canEdit = $derived(session.canEdit && !drafted);

  const meterValid = $derived(
    meterType !== "numeric" || /^[1-9]\d*$/.test(meterCount.trim()),
  );
  const scoreDef = $derived<ScoreDefModel | null>(
    loadedDef && {
      ...loadedDef,
      staves,
      keysig,
      meterCount:
        meterType === "numeric"
          ? meterCount.trim()
          : meterType === "cut"
            ? "2"
            : "4",
      meterUnit:
        meterType === "numeric" ? meterUnit : meterType === "cut" ? "2" : "4",
      meterSym: meterType === "numeric" ? "" : meterType,
    },
  );

  // Per score staff: its name (the instrument's, with the parts the staff
  // carries), and the staff box where it is first printed (staffPlan), with
  // the end of that system's first measure, where the crop beside it ends.
  // The staves of a grand-staff instrument that first appear in one grand
  // staff make one group, shown in one box with one crop; every other staff
  // is a group of its own.
  const groups = $derived.by(() => {
    if (!data) return [];
    const pages = data.model.pages;
    const plan = data.instruments ? staffPlan(data.instruments, pages) : null;
    const first = new Map<
      string,
      { page: number; box: MeasureBox; end: number; unit: number }
    >();
    const units = namingUnits(pages);
    for (const planned of plan?.staves ?? []) {
      if (!planned.first) continue;
      const pg = pages[planned.first.page];
      const box = pg.staves?.[planned.first.box];
      if (!box) continue;
      const measures = pg.zones.filter(
        (z) => z.box.uly <= box.lry && z.box.lry >= box.uly,
      );
      const opening = measures.reduce<MeasureBox | null>(
        (a, z) => (!a || z.box.ulx < a.ulx ? z.box : a),
        null,
      );
      first.set(planned.id, {
        page: planned.first.page,
        box,
        end: opening?.lrx ?? box.lrx,
        unit: units.findIndex(
          (u) =>
            u.page === planned.first!.page &&
            u.staves.includes(planned.first!.box),
        ),
      });
    }
    const firstPage = Math.min(
      ...[...first.values()].map((f) => f.page),
      Infinity,
    );
    const rows = staves.map((staff, i) => {
      const planned = plan?.staves.find((s) => s.id === staff.id);
      const name =
        (planned ? plannedName(planned) : staff.label) || `Staff ${i + 1}`;
      const at = staff.id ? first.get(staff.id) : undefined;
      return { staff, name, at, grand: planned?.instrument.grand && planned };
    });
    const grouped: { rows: typeof rows; later: boolean }[] = [];
    for (const row of rows) {
      const last = grouped[grouped.length - 1]?.rows[0];
      if (
        row.grand &&
        last?.grand &&
        last.grand.instrument === row.grand.instrument &&
        row.at &&
        row.at.unit >= 0 &&
        last.at?.unit === row.at.unit
      )
        grouped[grouped.length - 1].rows.push(row);
      else
        grouped.push({
          rows: [row],
          later: !!row.at && row.at.page > firstPage,
        });
    }
    return grouped;
  });

  // A planned staff's row name: its instrument, the parts it carries in
  // some system, and for a grand staff which of its staves it is.
  function plannedName(planned: PlannedStaff): string {
    const { instrument } = planned;
    const parts = planned.parts.map((p) => instrument.parts[p].name).join(".");
    const grand = instrument.grand ? ` (staff ${planned.position})` : "";
    return `${instrument.name}${parts ? ` ${parts}` : ""}${grand}`;
  }

  /**
   * The crop of the staff boxes of one group: from a little before the boxes
   * (the end of a printed name) to `end`, with room above and below, and its
   * height on screen, where one staff with its room is CROP_HEIGHT high.
   */
  function cropOf(boxes: MeasureBox[], end: number) {
    const staff =
      boxes.reduce((sum, b) => sum + b.lry - b.uly, 0) / boxes.length;
    const pad = 0.45 * staff;
    const x = Math.max(0, Math.min(...boxes.map((b) => b.ulx)) - 1.5 * staff);
    const y = Math.max(0, Math.min(...boxes.map((b) => b.uly)) - pad);
    const w = Math.max(end, ...boxes.map((b) => b.lrx)) - x;
    const h = Math.max(...boxes.map((b) => b.lry)) + pad - y;
    return { x, y, w, h, height: (h * CROP_HEIGHT) / (staff + 2 * pad) };
  }
  const CROP_HEIGHT = 64;

  // The staves' transposition fields (StaffPitchSelects, StaffCustomPitch).
  const pitch = new StaffPitchEditor(() => keysig);

  function openDraft() {
    const def = scoreDef;
    void session
      .run((c) =>
        invoke(
          commands.openEditor,
          {
            task_id: taskId,
            campaign,
            base: location.origin,
            ...(drafted || !def ? {} : { scoreDef: $state.snapshot(def) }),
          },
          c,
        ),
      )
      .then(openMeiFriend);
  }

  let sidePanel = $state(readSidePanel());
  let sheetOpen = $state(false);
</script>

<svelte:head>
  <title>Score check · {session.pieceName || campaign} · Let's Encode!</title>
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

<div class="checker sidehost" data-stage="encode">
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
    <div class="main">
      <h1 class="vh">Score check · {session.pieceName || campaign}</h1>
      <div class="runrow">
        <TaskRunState task={taskId} repoId={session.campaign.repoId} pill />
      </div>
      <div class="deskwrap">
        <fieldset class="check" disabled={!canEdit}>
          <div class="scorerow">
            <KeyTimeFields
              bind:keysig
              bind:meterType
              bind:meterCount
              bind:meterUnit
              {meterValid}
              onkeychange={() => staves.forEach((s) => settleKey(keysig, s))}
            />
          </div>
          <ol class="rows">
            {#each groups as group, g (group.rows[0].staff.id ?? g)}
              {@const at = group.rows[0].at}
              {@const names = group.rows.map((r) => r.name).join(", ")}
              <li
                class="row"
                class:grand={group.rows.length > 1}
                style:--lines={group.rows.length}
              >
                {#if group.rows.length > 1}
                  <span
                    class="gbrace"
                    title="A grand staff: these staves belong to one instrument."
                    ><MusicGlyph name="brace" stretch /></span
                  >
                {/if}
                {#each group.rows as row (row.staff.id ?? row.name)}
                  {@const staff = row.staff}
                  <span class="name" title={row.name}>{row.name}</span>
                  <div class="controls">
                    <GlyphSelect
                      class="ctl clef"
                      options={clefOption(staff)
                        ? CLEF_OPTIONS
                        : [
                            {
                              value: "",
                              label: clefText(staff),
                              glyph: clefGlyph(staff),
                            },
                            ...CLEF_OPTIONS,
                          ]}
                      top={COMMON_CLEFS}
                      value={clefOption(staff)?.value ?? ""}
                      onchange={(v) => setClef(keysig, staff, v)}
                      label={`${row.name}: clef`}
                      title="The clef this staff opens with."
                    />
                    {#if !unpitched(staff)}
                      <StaffPitchSelects
                        editor={pitch}
                        {staff}
                        scoreKey={keysig}
                        name={row.name}
                      />
                      {#if pitch.value(staff) === "other"}
                        <StaffCustomPitch
                          editor={pitch}
                          {staff}
                          name={row.name}
                        />
                      {/if}
                    {/if}
                  </div>
                {/each}
                {#if at && data.imageUrls[at.page]}
                  {@const pg = data.model.pages[at.page]}
                  {@const v = cropOf(
                    group.rows.map((r) => r.at!.box),
                    Math.max(...group.rows.map((r) => r.at!.end)),
                  )}
                  <div class="cropcell">
                    <span
                      class="first"
                      title={group.later
                        ? "The staff first appears on this page, so the scan shown is from there."
                        : undefined}>Page {at.page + 1} · Facsimile</span
                    >
                    <svg
                      class="crop"
                      viewBox={`${v.x} ${v.y} ${v.w} ${v.h}`}
                      style:width={`${(v.w / v.h) * v.height}px`}
                      style:height={`${v.height}px`}
                      role="img"
                      aria-label={`${names} on page ${at.page + 1}`}
                    >
                      <image
                        href={data.imageUrls[at.page]}
                        x="0"
                        y="0"
                        width={pg.width}
                        height={pg.height}
                      />
                    </svg>
                  </div>
                {/if}
              </li>
            {/each}
          </ol>
        </fieldset>
      </div>
    </div>

    {#snippet footer()}
      <div class="wfoot">
        <span class="abcount wsum">
          {staves.length} staves · {keysigText(keysig)} · {meterType ===
          "numeric"
            ? `${meterCount}/${meterUnit}`
            : meterType === "common"
              ? "common time"
              : "cut time"}
        </span>
        <span class="wstatus"><PreTaskStatus {session} stage="enc" /></span>
        {#if session.holds}
          <button
            type="button"
            class="btn btn-primary btn-enc"
            onclick={openDraft}
            disabled={session.busy || !meterValid}
            title={drafted
              ? "Opens your work on this page in mei-friend. Completing the task there submits it for review."
              : "Makes the draft of this page with these clefs, key signatures, meter and transpositions and opens it in mei-friend. Completing the task there submits it for review."}
            >{drafted ? "Open in mei-friend" : "Open draft in mei-friend"}
            <Icon name="external" /></button
          >
        {/if}
      </div>
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
        done={data.status === "completed"}
        viewer={session.viewer}
        {runner}
        bind:panel={sidePanel}
        {taskBox}
        footer={data.status === "encoding_required" ? footer : undefined}
        bind:open={sheetOpen}
        oncomment={(...args) => session.postComment(...args)}
        onresolve={(id) => session.resolveComment(id)}
      />
    {/if}
  {/if}
</div>

<style>
  .checker {
    flex: 1;
    min-height: 0;
    display: flex;
    background: var(--desk);
    box-shadow: var(--shadow-inset);
  }
  .checker > :global(.spwrap:not(.docked)) {
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
  .deskwrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 12px 16px;
    box-sizing: border-box;
  }
  .check {
    border: 0;
    margin: 0;
    padding: 0;
    min-width: 0;
  }
  /* The key and time signature fields (KeyTimeFields) above the staves. */
  .scorerow {
    max-width: 28em;
    margin-bottom: 12px;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* One staff, or the staves of one grand staff: per staff a line with its
     name and its clef, transposition and key, and beside the lines the scan
     of the staves where they first appear. */
  .row {
    display: grid;
    grid-template-columns: minmax(120px, 200px) auto minmax(0, 1fr);
    grid-auto-rows: 1fr;
    align-items: center;
    gap: 4px 12px;
    padding: 4px 8px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  /* A grand staff's box: a brace before the lines of its staves. The brace
     and its gap come off the name's column, so the controls stand where
     those of a single staff do. */
  .row.grand {
    grid-template-columns: 10px minmax(98px, 178px) auto minmax(0, 1fr);
  }
  .gbrace {
    grid-column: 1;
    grid-row: 1 / span var(--lines);
    align-self: stretch;
    margin: 4px 0;
    color: var(--ink-grand);
  }
  .row > .name {
    grid-column: 1;
  }
  .row > .controls {
    grid-column: 2;
  }
  .row > .cropcell {
    grid-column: 3;
    grid-row: 1 / span var(--lines);
  }
  .row.grand > .name {
    grid-column: 2;
  }
  .row.grand > .controls {
    grid-column: 3;
  }
  .row.grand > .cropcell {
    grid-column: 4;
  }
  .name {
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .controls :global(.trans) {
    max-width: 14em;
  }
  .controls {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .cropcell {
    min-width: 0;
    overflow-x: auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .crop {
    display: block;
    flex: none;
  }
  .first {
    flex: none;
    font-size: 11.5px;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
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
  @media (max-width: 900px) {
    .row {
      grid-template-columns: minmax(0, 1fr);
      grid-auto-rows: auto;
      gap: 6px;
    }
    .row.grand {
      grid-template-columns: 10px minmax(0, 1fr);
    }
    .row > .name,
    .row > .controls,
    .row > .cropcell {
      grid-column: 1;
      grid-row: auto;
    }
    .row.grand > .name,
    .row.grand > .controls,
    .row.grand > .cropcell {
      grid-column: 2;
    }
    .gbrace {
      grid-row: 1 / span calc(2 * var(--lines));
    }
  }
</style>
