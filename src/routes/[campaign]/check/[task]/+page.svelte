<!--
  The score check of the first page task of an 'omr-instruments' piece: the
  clef, key signature and transposition of every staff of the opening score
  definition, and the score's key and meter, as the layout task proposed them
  from the recognition. Each staff is shown beside the scan of the staff box
  where it first appears. Opening the view claims the task; nothing is saved
  until "Open draft in mei-friend" makes the page's draft with the checked
  definition (openEditor), commits both to the task branch and hands off.
  Once the branch holds the draft, the view shows the checked values
  read-only and opens mei-friend on it.
-->
<script lang="ts">
  import { page } from "$app/state";
  import { auth, login } from "$lib/auth.svelte.ts";
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
    staffInstrumentName,
    staffPlan,
    withLayerTranspositions,
    type PlannedStaff,
  } from "$lib/instrument-naming.ts";
  import {
    CLEF_OPTIONS,
    COMMON_CLEFS,
    KEY_SIGNATURES,
    clefGlyph,
    clefOption,
    clefText,
    followedKey,
    setClef,
    setTransposition,
    settleKey,
    transOf,
    transposes,
    unpitched,
  } from "$lib/staff-edit.ts";
  import {
    COMMON_TRANSPOSITIONS,
    PITCHES,
    fromCustom,
    keysigText,
    soundsText,
    toCustom,
    transpositionFromLabel,
  } from "$lib/transposition.ts";
  import { SvelteSet } from "svelte/reactivity";
  import Icon from "$lib/components/Icon.svelte";
  import GlyphSelect from "$lib/components/GlyphSelect.svelte";
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
        // instrument's name gives ("Klarinette in A", "Kontrabass").
        if (d.holdsLock && d.status === "encoding_required" && !d.workSource)
          for (const staff of staves) {
            const planned = (
              d.instruments
                ? staffPlan(d.instruments, d.model.pages).staves
                : []
            ).find((s) => s.id === staff.id);
            const name = planned ? staffInstrumentName(planned) : "";
            const t = name ? transpositionFromLabel(name) : null;
            if (t && !transposes(staff) && !unpitched(staff))
              setTransposition(keysig, staff, t);
          }
      },
      reset() {
        staves = [];
        loadedDef = null;
      },
    },
  );
  const runner = session.runner;
  const data = $derived(session.data);
  const tables = $derived(session.tables);
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
  const checkedDef = $derived<ScoreDefModel | null>(
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
  // The checked definition, where a layer that is an instrument of its own
  // takes the transposition of the staff that carries its part alone.
  const scoreDef = $derived<ScoreDefModel | null>(
    checkedDef && data?.instruments
      ? withLayerTranspositions(
          checkedDef,
          staffPlan(data.instruments, data.model.pages),
        )
      : checkedDef,
  );

  // Per score staff: its name (the instrument's, with the parts the staff
  // carries), and the staff box where it is first printed (staffPlan), with
  // the end of that system's first measure, where the crop beside it ends.
  const rows = $derived.by(() => {
    if (!data) return [];
    const pages = data.model.pages;
    const plan = data.instruments ? staffPlan(data.instruments, pages) : null;
    const first = new Map<
      string,
      { page: number; box: MeasureBox; end: number }
    >();
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
      });
    }
    const firstPage = Math.min(
      ...[...first.values()].map((f) => f.page),
      Infinity,
    );
    return staves.map((staff) => {
      const planned = plan?.staves.find((s) => s.id === staff.id);
      const name = planned ? plannedName(planned) : staff.label;
      const at = staff.id ? first.get(staff.id) : undefined;
      return { staff, name, at, later: !!at && at.page > firstPage };
    });
  });

  // A planned staff's row name: its instrument, the parts it carries in
  // some system, and for a grand staff which of its staves it is; where the
  // parts are instruments, the parts alone ("Violoncello, Kontrabass").
  function plannedName(planned: PlannedStaff): string {
    const { instrument } = planned;
    if (instrument.partsAreInstruments && planned.parts.length)
      return planned.parts.map((p) => instrument.parts[p].name).join(", ");
    const parts = planned.parts.map((p) => instrument.parts[p].name).join(".");
    const grand = instrument.grand ? ` (staff ${planned.position})` : "";
    return `${instrument.name}${parts ? ` ${parts}` : ""}${grand}`;
  }

  /**
   * The crop of a staff box: from a little before the box (the end of a
   * printed name) to `end`, with room above and below.
   */
  function cropOf(box: MeasureBox, end: number) {
    const staff = box.lry - box.uly;
    const pad = 0.45 * staff;
    const x = Math.max(0, box.ulx - 1.5 * staff);
    const y = Math.max(0, box.uly - pad);
    return { x, y, w: Math.max(end, box.lrx) - x, h: box.lry + pad - y };
  }
  const CROP_HEIGHT = 64;

  // Staves showing the pitch fields although a listed transposition matches.
  const transCustom = new SvelteSet<StaffModel>();
  /** The transposition select's value: 'none', a list index, or 'other'. */
  function transValue(staff: StaffModel): string {
    if (transCustom.has(staff)) return "other";
    if (!transposes(staff)) return "none";
    const i = COMMON_TRANSPOSITIONS.findIndex(
      (t) => t.diat === staff.transDiat && t.semi === staff.transSemi,
    );
    return i < 0 ? "other" : String(i);
  }

  function pickTransposition(staff: StaffModel, value: string) {
    if (value === "other") {
      transCustom.add(staff);
      return;
    }
    transCustom.delete(staff);
    setTransposition(
      keysig,
      staff,
      value === "none" ? null : COMMON_TRANSPOSITIONS[Number(value)],
    );
  }
  /** The pitch fields of a staff with a transposition outside the list. */
  const customOf = (staff: StaffModel) =>
    toCustom(transOf(staff)) ?? { pitch: "C", higher: false, octaves: 0 };
  function setCustom(
    staff: StaffModel,
    change: Partial<ReturnType<typeof customOf>>,
  ) {
    setTransposition(
      keysig,
      staff,
      fromCustom({ ...customOf(staff), ...change }),
    );
  }

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
    onContinue={() => runner.dismiss()}
  />
{/if}

<div class="checker sidehost" data-stage="encode">
  {#if session.campaign.error}
    <div class="deskwrap">
      <div class="banner err">
        <span>
          {session.campaign.error}
          <button
            type="button"
            class="linkish"
            onclick={() => session.campaign.retry()}>Try again</button
          >
        </span>
      </div>
    </div>
  {:else if session.campaign.notFound}
    <div class="deskwrap">
      <div class="banner err">
        <span>
          No campaign called <code>{campaign}</code> was found.
          <a href="/campaigns">Back to all campaigns</a>.
        </span>
      </div>
    </div>
  {:else if auth.status === "loading" || !session.campaign.resolved}
    <div class="deskwrap"><p class="muted">Loading…</p></div>
  {:else if !auth.user}
    <div class="deskwrap">
      <div class="banner warn">
        <span>
          {#if auth.expired}Your GitHub login has expired.{/if}
          Please
          <button type="button" class="linkish" onclick={() => login()}
            >log in with GitHub</button
          >
          to work on this task.
        </span>
      </div>
    </div>
  {:else if session.loading}
    <div class="deskwrap"><p class="muted">Loading the score…</p></div>
  {:else if session.loadError}
    <div class="deskwrap">
      <div class="banner err">
        <span>
          {session.loadError}
          <button type="button" class="linkish" onclick={() => session.load()}
            >Try again</button
          >
        </span>
      </div>
    </div>
  {:else if data}
    <div class="main">
      <h1 class="vh">Score check · {session.pieceName || campaign}</h1>
      <div class="runrow"><TaskRunState task={taskId} pill /></div>
      <div class="deskwrap">
        <fieldset class="check" disabled={!canEdit}>
          <div class="scorerow">
            <label class="field">
              <span class="flabel">Key</span>
              <select
                class="ctl"
                bind:value={keysig}
                onchange={() => staves.forEach((s) => settleKey(keysig, s))}
                title="The key signature of the score: that of the staves that do not transpose."
              >
                {#each KEY_SIGNATURES as k (k.value)}
                  <option value={k.value}>{k.label}</option>
                {/each}
              </select>
            </label>
            <label class="field">
              <span class="flabel">Meter</span>
              <select
                class="ctl"
                bind:value={meterType}
                title="The time signature the piece opens with: numbers, or the symbol for common or cut time."
              >
                <option value="numeric">Numbers</option>
                <option value="common">Common time</option>
                <option value="cut">Cut time</option>
              </select>
            </label>
            {#if meterType === "numeric"}
              <input
                class="ctl count"
                class:bad={!meterValid}
                bind:value={meterCount}
                inputmode="numeric"
                aria-label="Beats per measure"
                title="The upper number of the time signature."
              />
              <span class="over">/</span>
              <select
                class="ctl"
                bind:value={meterUnit}
                aria-label="Beat unit"
                title="The lower number of the time signature."
              >
                {#each [1, 2, 4, 8, 16] as u (u)}
                  <option value={String(u)}>{u}</option>
                {/each}
              </select>
            {/if}
          </div>
          <ol class="rows">
            {#each rows as row, i (row.staff.id ?? i)}
              {@const staff = row.staff}
              <li class="row">
                <span class="name" title={row.name}
                  >{row.name || `Staff ${i + 1}`}</span
                >
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
                    <select
                      class="ctl trans"
                      value={transValue(staff)}
                      onchange={(e) =>
                        pickTransposition(
                          staff,
                          (e.target as HTMLSelectElement).value,
                        )}
                      aria-label={`${row.name}: transposition`}
                      title={transposes(staff)
                        ? `Sounds ${soundsText(transOf(staff))} than written.`
                        : "Whether the instrument transposes: its music is written at another pitch than it sounds."}
                    >
                      <option value="none">Not transposing</option>
                      {#each COMMON_TRANSPOSITIONS as t, n (n)}
                        <option value={String(n)}>{t.label}</option>
                      {/each}
                      <option value="other">Other…</option>
                    </select>
                    <select
                      class="ctl key"
                      value={staff.keysig ?? ""}
                      onchange={(e) => {
                        const v = (e.target as HTMLSelectElement).value;
                        if (v === "") delete staff.keysig;
                        else staff.keysig = v;
                        settleKey(keysig, staff);
                      }}
                      aria-label={`${row.name}: key signature`}
                      title={staff.keysig === undefined
                        ? transposes(staff)
                          ? "The key signature of this staff: the score's, moved by the transposition."
                          : "The key signature of this staff: the score's."
                        : "The key signature of this staff, chosen for it alone."}
                    >
                      <optgroup
                        label={transposes(staff)
                          ? "Score key, transposed"
                          : "Score key"}
                      >
                        <option value=""
                          >{keysigText(followedKey(keysig, staff))}</option
                        >
                      </optgroup>
                      <optgroup label="This staff only">
                        {#each KEY_SIGNATURES as k (k.value)}
                          <option value={k.value}>{k.label}</option>
                        {/each}
                      </optgroup>
                    </select>
                    {#if transValue(staff) === "other"}
                      {@const c = customOf(staff)}
                      <select
                        class="ctl"
                        value={c.pitch}
                        onchange={(e) =>
                          setCustom(staff, {
                            pitch: (e.target as HTMLSelectElement).value,
                          })}
                        aria-label={`${row.name}: instrument pitch`}
                        title="The pitch the instrument is in: the note that sounds when a C is written."
                      >
                        {#each PITCHES as p (p.name)}
                          <option value={p.name}>in {p.name}</option>
                        {/each}
                      </select>
                      <select
                        class="ctl"
                        value={c.higher ? "higher" : "lower"}
                        onchange={(e) =>
                          setCustom(staff, {
                            higher:
                              (e.target as HTMLSelectElement).value ===
                              "higher",
                          })}
                        aria-label={`${row.name}: sounds higher or lower`}
                        title="Whether the instrument sounds higher or lower than written."
                      >
                        <option value="lower">sounds lower</option>
                        <option value="higher">sounds higher</option>
                      </select>
                      <select
                        class="ctl"
                        value={String(c.octaves)}
                        onchange={(e) =>
                          setCustom(staff, {
                            octaves: Number(
                              (e.target as HTMLSelectElement).value,
                            ),
                          })}
                        aria-label={`${row.name}: added octaves`}
                        title="Whole octaves added to the interval, as for a bass clarinet."
                      >
                        <option value="0">no octave</option>
                        <option value="1">+1 octave</option>
                        <option value="2">+2 octaves</option>
                      </select>
                    {/if}
                  {/if}
                </div>
                {#if row.at && data.imageUrls[row.at.page]}
                  {@const pg = data.model.pages[row.at.page]}
                  {@const v = cropOf(row.at.box, row.at.end)}
                  <div class="cropcell">
                    {#if row.later}
                      <span
                        class="first"
                        title="The staff first appears on this page, so the scan shown is from there."
                        >p. {row.at.page + 1}</span
                      >
                    {/if}
                    <svg
                      class="crop"
                      viewBox={`${v.x} ${v.y} ${v.w} ${v.h}`}
                      style:width={`${(v.w / v.h) * CROP_HEIGHT}px`}
                      style:height={`${CROP_HEIGHT}px`}
                      role="img"
                      aria-label={`${row.name} on page ${row.at.page + 1}`}
                    >
                      <image
                        href={data.imageUrls[row.at.page]}
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
        <span class="wstatus"><PreTaskStatus {session} /></span>
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
        footer={data.status === "encoding_required" ? footer : undefined}
        bind:open={sheetOpen}
        onanchor={() => {}}
        oncomment={(...args) => session.postComment(...args)}
        onresolve={(id) => session.resolveComment(id)}
      />
    {/if}
  {/if}
</div>

<style>
  .muted {
    color: var(--ink-faint);
    font-size: 0.9rem;
  }
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
  .scorerow {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
    margin-bottom: 12px;
  }
  .field {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .flabel {
    font-size: 12.5px;
    color: var(--ink-soft);
  }
  .count {
    width: 3.5em;
  }
  .over {
    color: var(--ink-faint);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* One staff: its name, its clef, transposition and key, and the scan of
     the staff where it first appears. */
  .row {
    display: grid;
    grid-template-columns: minmax(120px, 200px) auto minmax(0, 1fr);
    align-items: center;
    gap: 12px;
    padding: 4px 8px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  .name {
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .controls .trans {
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
      gap: 6px;
    }
  }
</style>
