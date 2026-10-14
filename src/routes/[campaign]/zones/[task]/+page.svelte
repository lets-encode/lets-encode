<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import { tick, untrack } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import { page } from "$app/state";
  import { recordCampaignTitle } from "$lib/campaign-title.svelte.ts";
  import { auth, login, forge } from "$lib/auth.svelte.ts";
  import type { ForgeClient } from "$lib/forge/types.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import type {
    CommandContext,
    CommentAnchorInput,
    FacsimileTaskData,
    Result,
  } from "$lib/commands.ts";
  import { readingOrderRows, nextLabel } from "$lib/mei-facsimile.ts";
  import { taskDescription } from "$lib/campaign-graph.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import { readSidePanel } from "$lib/side-panels.ts";
  import type { PageModel, MeasureBox } from "$lib/mei-facsimile.ts";
  import {
    buildSpreads,
    defaultSpreadView,
    pagesLabelCh,
    shownPagesLabel,
  } from "$lib/page-spreads.ts";
  import {
    applyAnchor,
    readAnchor,
    rowView,
    scrollToRow,
  } from "$lib/page-scroll.ts";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import RunnerBanner from "$lib/components/RunnerBanner.svelte";
  import TaskPageSidePanel from "$lib/components/TaskPageSidePanel.svelte";
  import { zoomGestures } from "$lib/zoom-gestures.ts";
  import TaskRunState from "$lib/components/TaskRunState.svelte";
  import PreTaskBox from "$lib/components/PreTaskBox.svelte";
  import PreTaskStatus from "$lib/components/PreTaskStatus.svelte";
  import { PreTaskSession } from "$lib/pre-task-session.svelte.ts";
  import FitIcon from "$lib/components/FitIcon.svelte";
  import { createOmrClient } from "$lib/omr-client.ts";
  import {
    layoutBoxes,
    layoutRecord,
    LAYOUT_PARAMETERS,
    type CocoLayout,
  } from "$lib/omr-layout.ts";
  import { provider, omr as omrModels } from "$lib/forge/config.ts";
  import {
    clearCachedLayouts,
    readCachedLayouts,
    writeCachedLayout,
  } from "$lib/omr-layout-cache.ts";
  import { resolveRepoRelativeTarget } from "$lib/facsimile-images.ts";
  import {
    arrowShift,
    drawnBox,
    drawStarted,
    movedBox,
    nudgedEdges,
    pagePoint,
    resizedBox,
  } from "$lib/box-geometry.ts";

  // The URL carries the campaign name and task; the repo is resolved from the
  // name (name → stable repo id → current owner/name) — see resolveCampaign.
  const campaign = $derived(page.params.campaign!);
  const taskId = $derived(page.params.task!);

  // Editor-side zone: the box, the label override (null = automatic), the
  // computed label, and the break flags. The page break is derived from
  // position (each page's first measure), not stored per-zone. `sb` follows
  // the reading-order rows (a row's first box starts a system) unless
  // `sbOverride` holds a value set by hand.
  type EditZone = {
    box: MeasureBox;
    override: string | null;
    label: string;
    sb: boolean;
    sbOverride: boolean | null;
    mdiv: boolean;
  };
  // A staff or grand-staff box of an OMR-prepared piece: geometry only.
  type EditStaff = { box: MeasureBox };
  type EditPage = {
    image: string;
    width: number;
    height: number;
    url: string;
    // The background facsimile failed to load (empty download URL, or the
    // browser refused the request — e.g. a CSP img-src that omits the raw host).
    failed: boolean;
    zones: EditZone[];
    staves: EditStaff[];
    grandstaves: EditStaff[];
  };
  // The box layers. A measure-correction task edits measures with their
  // numbers and breaks; a layout task (OMR) edits the staff boxes first, then
  // the grand-staff boxes, then the measures, one layer at a time.
  type Layer = "measures" | "staves" | "grandstaves";

  const session = new PreTaskSession(
    () => campaign,
    () => taskId,
    {
      loaded(d) {
        selected = null;
        anchor = { page: 0, frac: 0 };
        rawLayouts = {};
        seen = { staves: [], grandstaves: [], measures: [] };
        pages = d.model.pages.map((pg, i) => ({
          image: pg.image,
          width: pg.width,
          height: pg.height,
          url: d.imageUrls[i],
          failed: !d.imageUrls[i],
          zones: pg.zones.map((z) => ({
            box: { ...z.box },
            override: null,
            label: z.label,
            sb: z.sb,
            sbOverride: null,
            mdiv: z.mdiv,
          })),
          staves: (pg.staves ?? []).map((box) => ({ box: { ...box } })),
          grandstaves: (pg.grandstaves ?? []).map((box) => ({
            box: { ...box },
          })),
        }));
        // A score of one or two pages is shown whole: one page, or both side
        // by side. Longer scores keep the two-up view with page 1 as a recto.
        if (pages.length <= 2)
          ({ view, firstOnRight } = defaultSpreadView(pages.length));
        // A label that differs from what automatic numbering would produce is
        // an override (e.g. 10a/10b) — keep it through renumbering.
        let prev: string | undefined;
        for (const pg of pages) {
          for (const zone of pg.zones) {
            if (zone.label !== nextLabel(prev)) zone.override = zone.label;
            prev = zone.label;
          }
        }
        // Likewise a system beginning that differs from what the rows give.
        pages.forEach((pg, p) => {
          const starts = rowStarts(p);
          for (const zone of pg.zones) {
            if (zone.sb !== starts.has(zone.box)) zone.sbOverride = zone.sb;
          }
        });
        resetHistory();
      },
      reset() {
        pages = [];
      },
      // A claim of an OMR layout task whose score carries no zones yet
      // continues into layout detection in the same overlay.
      afterClaim(f, d) {
        if (!needsDetection()) return null;
        detectedFor = taskId;
        return detectSteps(f, d.fragment);
      },
    },
  );
  const runner = session.runner;
  const data = $derived(session.data);
  const tables = $derived(session.tables);
  $effect(() => {
    if (tables) recordCampaignTitle(campaign, tables.title);
  });
  const holds = $derived(session.holds);
  const canEdit = $derived(session.canEdit);
  const busy = $derived(session.busy);
  const owner = $derived(session.campaign.owner);
  const repo = $derived(session.campaign.repo);
  const repoId = $derived(session.campaign.repoId);
  const viewer = $derived(session.viewer);
  // The task's kind: measure correction, which for an OMR-prepared piece
  // (omr-layout) also corrects the staff and grand-staff boxes.
  const taskTitle = $derived(taskDescription(data?.locator ?? "measure-zones"));
  const omr = $derived(data?.locator === "omr-layout");
  // A layout task's three steps: the staff boxes, the grand-staff boxes, the measures.
  let layoutStep = $state<1 | 2 | 3>(1);
  const STEP_LAYERS: Layer[] = ["staves", "grandstaves", "measures"];
  // The layer the pointer edits; in a layout task the others are not drawn.
  const tool = $derived<Layer>(omr ? STEP_LAYERS[layoutStep - 1] : "measures");
  function setLayoutStep(step: 1 | 2 | 3) {
    layoutStep = step;
    selected = null;
    corner = null;
  }
  // A page's boxes in a layer, for the geometry code shared by all.
  const items = (p: number, layer: Layer = tool): { box: MeasureBox }[] =>
    layer === "staves"
      ? pages[p].staves
      : layer === "grandstaves"
        ? pages[p].grandstaves
        : pages[p].zones;
  let pages = $state<EditPage[]>([]);
  // The layout model's raw output per page index, kept from a detection run
  // in this session for the submission; outside the edit history.
  let rawLayouts = $state<Record<number, CocoLayout>>({});
  let selected = $state<{ p: number; z: number } | null>(null);
  /** The selected measure's number, prefilling a change request; '' for none. */
  const selectedLabel = $derived.by(() => {
    const zone =
      selected && tool === "measures"
        ? pages[selected.p]?.zones[selected.z]
        : undefined;
    return zone ? String(zone.override ?? zone.label) : "";
  });

  // On a touch screen a finger drag on the page scrolls it: a tap selects a
  // box, the selected box and its handles drag, and new boxes are drawn only
  // in draw mode.
  const coarseQuery = new MediaQuery("(pointer: coarse)", false);
  const coarse = $derived(coarseQuery.current);
  let drawMode = $state(false);
  // The side panel's tab; selecting a box shows its controls.
  let panelTab = $state<"selection" | "comments">("selection");
  $effect(() => {
    if (selected) untrack(() => (panelTab = "selection"));
  });

  // Page zoom: the fraction of the canvas width one page occupies. 1 = fit the
  // canvas; above 1 the pages overflow and the desk scrolls horizontally.
  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 4;
  let zoom = $state(1);

  // The slider runs on a log scale: equal drags multiply the zoom equally,
  // so the low end moves in fine steps and the high end in coarse ones.
  const ZOOM_STOPS = 100;
  // One press of zoom out or in: a tenth of the slider, about a third larger
  // or smaller.
  const ZOOM_STEP = 10;
  /** Below this tool-column width the toolbar keeps only the page
      navigation, fit width, zoom out and in, undo, redo and help (the narrow
      rule in the styles). */
  const NARROW_TOOL = 560;
  const zoomPos = $derived(
    Math.round(
      (Math.log(zoom / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * ZOOM_STOPS,
    ),
  );
  const setZoomPos = (p: number) =>
    (zoom =
      Math.round(ZOOM_MIN * (ZOOM_MAX / ZOOM_MIN) ** (p / ZOOM_STOPS) * 100) /
      100);

  // The desk's inner size, for the whole-page fit.
  let deskW = $state(0);
  let deskH = $state(0);

  // The zoom at which a whole page fits in the desk: bounded by the height
  // (using the tallest page), capped at 1 (the width fit). 76 covers the
  // desk padding, the page heading above each sheet and the sheet's bottom
  // margin.
  function fitZoom(): number {
    if (!pages.length || !deskW || !deskH) return 1;
    const aspect = Math.max(...pages.map((p) => p.height / p.width));
    const pagesW = deskW - 48;
    const colW = shownView === "double" ? (pagesW - 4) / 2 : pagesW;
    const usableH = deskH - 76;
    if (colW <= 0 || usableH <= 0) return 1;
    const z = usableH / (colW * aspect);
    return Math.min(1, Math.max(ZOOM_MIN, Math.floor(z * 1000) / 1000));
  }

  // The fit in force, if any: it keeps the zoom at the fit as the desk
  // resizes or the view changes, until the slider is moved. Each freshly
  // loaded task opens at the whole-page fit.
  let fit = $state<"width" | "page" | null>("page");
  let zoomInitFor = $state<FacsimileTaskData | null>(null);
  $effect(() => {
    if (!data || zoomInitFor === data) return;
    zoomInitFor = data;
    fit = "page";
  });
  // A narrow tool column has no whole-page fit: it shows the page width.
  $effect(() => {
    if (narrow && fit === "page") fit = "width";
  });
  $effect(() => {
    if (fit === "width") zoom = 1;
    else if (fit === "page") zoom = fitZoom();
  });

  // The pages scroll as rows of one or two pages. `view` is one or two pages
  // per row; `firstOnRight` places page 1 as a right-hand page (recto), so a
  // two-up view pairs 2|3, 4|5, … the way a score opens — the printed page
  // number's side can't be read without OCR, so this convention (with the
  // toggle) stands in for it.
  let view = $state<"single" | "double">("double");
  let firstOnRight = $state(true);
  // A narrow tool column (a phone) shows one page per row and hides the
  // switch; the chosen view returns when the column widens.
  let mainW = $state(0);
  const narrow = $derived(mainW > 0 && mainW < NARROW_TOOL);
  const shownView = $derived(narrow ? "single" : view);
  const spreads = $derived(buildSpreads(pages.length, shownView, firstOnRight));

  // The desk scrolls through the rows, one per spread.
  let desk = $state<HTMLElement | null>(null);
  let rowEls = $state<HTMLElement[]>([]);
  // What the desk shows, read from the scroll position.
  let rowIndex = $state(0);
  let shownRows = $state<number[]>([]);
  let nearPages = $state<number[]>([]);
  let atTop = $state(true);
  let atEnd = $state(true);
  // The position the desk returns to when the rows change size, kept by page
  // so it survives the rows being re-sliced.
  let anchor: { page: number; frac: number; x?: number } = {
    page: 0,
    frac: 0,
  };
  const shownPages = $derived(
    shownRows.flatMap((r) => spreads[r]?.pages ?? []),
  );
  const spreadLabel = $derived(
    shownPagesLabel(
      spreads,
      shownRows.length ? shownRows : [rowIndex],
      pages.length,
    ),
  );

  function deskScrolled() {
    if (!desk) return;
    const rows = rowEls.slice(0, spreads.length);
    const v = rowView(desk, rows);
    rowIndex = v.current;
    shownRows = v.shown;
    atTop = v.atTop;
    atEnd = v.atEnd;
    const near = v.near.flatMap((r) => spreads[r]?.pages ?? []);
    if (near.join() !== nearPages.join()) nearPages = near;
    const a = readAnchor(desk, rows);
    if (a)
      anchor = { page: spreads[a.row]?.pages[0] ?? 0, frac: a.frac, x: a.x };
  }
  // Zoom, the view, the desk size and a newly loaded task move every row; once
  // the rows are laid out anew, the desk returns to the remembered position.
  $effect(() => {
    void [zoom, spreads, deskW, deskH, pages];
    tick().then(() => {
      const row = spreads.findIndex((s) => s.pages.includes(anchor.page));
      if (!desk || row < 0) return;
      applyAnchor(desk, rowEls.slice(0, spreads.length), { ...anchor, row });
      deskScrolled();
    });
  });
  /** Scroll a page's row (0-based page) to the top of the desk. */
  function showPage(p: number) {
    const row = spreads.findIndex((s) => s.pages.includes(p));
    if (!desk || row < 0) return;
    anchor = { page: spreads[row].pages[0], frac: 0 };
    scrollToRow(desk, rowEls.slice(0, spreads.length), row);
    deskScrolled();
  }
  // The whole-page fit also scrolls the row being read to the top, so its
  // pages are in view from top to bottom.
  function fitWholePage() {
    const p = spreads[rowIndex]?.pages[0] ?? 0;
    fit = "page";
    tick().then(() => showPage(p));
  }

  // The pages a layout task has shown in each step. Submission waits until
  // every page has been on screen in both steps.
  let seen = $state<Record<Layer, number[]>>({
    staves: [],
    grandstaves: [],
    measures: [],
  });
  $effect(() => {
    if (!omr) return;
    const shown = shownPages;
    const layer = tool;
    untrack(() => {
      const added = shown.filter((p) => !seen[layer].includes(p));
      if (added.length) seen[layer] = [...seen[layer], ...added];
    });
  });
  const pageList = (ps: number[]) => ps.map((p) => p + 1).join(", ");
  // Why a layout task cannot be submitted yet, or null when it can.
  const submitBlock = $derived.by(() => {
    if (!omr) return null;
    const unseen = (layer: Layer) =>
      pages.flatMap((_, p) => (seen[layer].includes(p) ? [] : [p]));
    for (const [i, layer] of STEP_LAYERS.entries()) {
      const pending = unseen(layer);
      if (pending.length) {
        return `Show every page in step ${i + 1} before submitting. Not yet shown: page ${pageList(pending)}.`;
      }
    }
    const noMeasures = pages.flatMap((pg, p) =>
      pg.staves.length && !pg.zones.length ? [p] : [],
    );
    if (noMeasures.length) {
      return `Page ${pageList(noMeasures)} has staff boxes but no measures. Add its measures, or remove its staff boxes if the page has no music.`;
    }
    return null;
  });

  // One row on. Back from partway down a row returns to that row's top first.
  function go(delta: number) {
    if (!desk) return;
    const a = readAnchor(desk, rowEls.slice(0, spreads.length));
    let row = rowIndex + delta;
    if (delta < 0 && a && a.row === rowIndex && a.frac > 0.02) row = rowIndex;
    const next = spreads[Math.max(0, Math.min(spreads.length - 1, row))];
    if (!next) return;
    showPage(next.pages[0]);
    selected = null;
  }

  // Recompute every label from reading order + overrides ("10a" continues as 11).
  function renumber() {
    let prev: string | undefined;
    for (const pg of pages) {
      for (const zone of pg.zones) {
        zone.label = zone.override ?? nextLabel(prev);
        prev = zone.label;
      }
    }
  }

  // The first box of every reading-order row of a page but its first row,
  // whose first box carries the page break.
  function rowStarts(p: number): Set<MeasureBox> {
    const rows = readingOrderRows(pages[p].zones.map((z) => z.box));
    return new Set(rows.slice(1).map((row) => row[0]));
  }

  // Re-sort a page's zones into reading order (after geometry changed), set
  // its system beginnings from the rows where none was set by hand, then
  // renumber everything.
  function resort(p: number) {
    const zones = pages[p].zones;
    const byBox = new Map(zones.map((z) => [z.box, z]));
    const rows = readingOrderRows(zones.map((z) => z.box));
    pages[p].zones = rows.flat().map((box) => byBox.get(box)!);
    const starts = new Set(rows.slice(1).map((row) => row[0]));
    for (const zone of pages[p].zones) {
      zone.sb = zone.sbOverride ?? starts.has(zone.box);
    }
    renumber();
  }

  // Staff and grand-staff boxes are kept top to bottom, then left to right.
  function resortStaves(p: number, layer: "staves" | "grandstaves" = "staves") {
    pages[p][layer].sort(
      (a, b) => a.box.uly - b.box.uly || a.box.ulx - b.box.ulx,
    );
  }

  const run = (
    command: (c: CommandContext) => Promise<Result>,
    opts?: { overviewOnSuccess?: boolean },
  ) => session.run(command, opts);

  // ------------------------------------------------------------- comments
  // The side panel beside the tool. Posting and resolving refresh the tables
  // only: a full reload would discard unsubmitted zone edits.
  let sidePanel = $state(readSidePanel());
  // A comment anchor scrolls the desk to its page and selects the measure with
  // the anchored number where the page has one.
  function showAnchorFor(c: CommentRow) {
    const p = Number(c.page) - 1;
    if (!Number.isInteger(p) || p < 0 || p >= pages.length) return;
    showPage(p);
    const z = pages[p].zones.findIndex(
      (zone) => (zone.override ?? zone.label) === c.measure_start,
    );
    selected = z >= 0 ? { p, z } : null;
  }
  // A new comment carries the selected measure as its anchor.
  const commentAnchor = (): CommentAnchorInput | undefined =>
    selected && selectedLabel
      ? {
          page: String(selected.p + 1),
          measure_start: selectedLabel,
          measure_end: selectedLabel,
        }
      : undefined;

  // On a touch screen a selected box narrower than TOUCH_BOX_PX is zoomed
  // to that width so its handles can be dragged.
  const TOUCH_BOX_PX = 96;
  /** Scroll a box into view, centred when it was outside it; with `zoomIn`
      also zoom a small box up to TOUCH_BOX_PX. */
  async function revealBox(p: number, z: number, zoomIn = false) {
    const box = items(p)[z]?.box;
    if (!box) return;
    const pg = pages[p];
    if (zoomIn && canvasW[p]) {
      const shown = ((box.lrx - box.ulx) / pg.width) * canvasW[p];
      if (shown > 0 && shown < TOUCH_BOX_PX) {
        zoom = Math.min(ZOOM_MAX, (zoom * TOUCH_BOX_PX) / shown);
        fit = null;
      }
    }
    await tick();
    const svg = svgEls[p];
    if (!desk || !svg) return;
    const r = svg.getBoundingClientRect();
    const d = desk.getBoundingClientRect();
    const left = r.left + (box.ulx / pg.width) * r.width;
    const right = r.left + (box.lrx / pg.width) * r.width;
    const top = r.top + (box.uly / pg.height) * r.height;
    const bottom = r.top + (box.lry / pg.height) * r.height;
    if (
      left >= d.left &&
      right <= d.right &&
      top >= d.top &&
      bottom <= d.bottom
    )
      return;
    desk.scrollLeft += (left + right) / 2 - (d.left + d.width / 2);
    desk.scrollTop += (top + bottom) / 2 - (d.top + d.height / 2);
    deskScrolled();
  }
  // Select a box on a touch screen: a tap, after which it can be dragged.
  function tapSelect(p: number, z: number) {
    if (!coarse) return;
    selected = { p, z };
    corner = null;
    revealBox(p, z, true);
  }
  /** Select the box before (-1) or after (1) the selected one in reading
      order, across pages. */
  function stepSelection(delta: 1 | -1) {
    let p = selected?.p ?? spreads[rowIndex]?.pages[0] ?? 0;
    let z = selected ? selected.z + delta : delta > 0 ? 0 : -1;
    if (!selected && delta < 0) z = items(p).length - 1;
    while (p >= 0 && p < pages.length && (z < 0 || z >= items(p).length)) {
      p += delta;
      if (p < 0 || p >= pages.length) return;
      z = delta > 0 ? 0 : items(p).length - 1;
    }
    if (p < 0 || p >= pages.length) return;
    selected = { p, z };
    revealBox(p, z, coarse);
  }
  const hasPrev = $derived(
    !!selected &&
      (selected.z > 0 ||
        pages.slice(0, selected.p).some((_, q) => items(q).length > 0)),
  );
  const hasNext = $derived(
    !!selected &&
      (selected.z < items(selected.p).length - 1 ||
        pages
          .slice(selected.p + 1)
          .some((_, q) => items(selected!.p + 1 + q).length > 0)),
  );

  function toPageModels(): PageModel[] {
    return pages.map((pg) => ({
      image: pg.image,
      width: pg.width,
      height: pg.height,
      // The page break sits on each page's first measure; a page break implies
      // the system break, so its explicit sb flag is not carried.
      zones: pg.zones.map((z, i) => ({
        box: { ...z.box },
        label: z.label,
        pb: i === 0,
        sb: z.sb,
        mdiv: z.mdiv,
      })),
      ...(omr
        ? {
            staves: pg.staves.map((s) => ({ ...s.box })),
            grandstaves: pg.grandstaves.map((g) => ({ ...g.box })),
          }
        : {}),
    }));
  }

  // The raw layouts go with the submission when this session detected every page.
  const rawLayoutRecord = () =>
    pages.every((_, p) => rawLayouts[p])
      ? layoutRecord(
          omrModels.layoutModel,
          pages.map((pg, p) => ({ image: pg.image, layout: rawLayouts[p] })),
        )
      : undefined;

  // While the task is held, its boxes are saved as a draft after each pause
  // in editing.
  $effect(() => {
    if (!session.canEdit || pages.length === 0) return;
    session.draft(
      omr
        ? { pages: toPageModels(), layout: true, rawLayout: rawLayoutRecord() }
        : { pages: toPageModels() },
    );
  });

  const submit = () =>
    run(
      (c) =>
        omr
          ? invoke(
              commands.submitOmrLayout,
              {
                task_id: taskId,
                pages: toPageModels(),
                layout: rawLayoutRecord(),
              },
              c,
            )
          : invoke(
              commands.submitZones,
              { task_id: taskId, pages: toPageModels() },
              c,
            ),
      { overviewOnSuccess: true },
    );

  // ------------------------------------------------------------------------
  // Layout detection (OMR-prepared pieces)
  //
  // A layout task's boxes come from the Musibot layout model, run through
  // the broker's relay when the claim holder opens a task whose score carries
  // no boxes yet. Page bytes are read through the
  // forge API; the result is seeded like measure detection's: reading order,
  // continuous numbering, a system start on every row but the page's first.
  // Each page's model output is stored in the browser as it arrives and read
  // back by the next detection, until the loaded score carries boxes.
  let detectedFor = $state<string | null>(null);
  const needsDetection = () =>
    omr &&
    canEdit &&
    pages.length > 0 &&
    pages.every((pg) => pg.zones.length === 0 && pg.staves.length === 0);
  $effect(() => {
    const boxed = data?.model.pages.some(
      (pg) => pg.zones.length > 0 || (pg.staves?.length ?? 0) > 0,
    );
    if (omr && boxed) {
      clearCachedLayouts(repoId, taskId);
    }
  });
  $effect(() => {
    if (data && !runner.busy && detectedFor !== taskId && needsDetection()) {
      detectedFor = taskId;
      detectLayout();
    }
  });
  function seedLayout() {
    pages.forEach((_, p) => resort(p));
  }

  async function detectLayout() {
    const f = forge();
    if (!f || !data) return;
    const fragment = data.fragment;
    await runner.run(() => detectSteps(f, fragment));
  }

  // The detection steps, logged to the running command's overlay.
  async function detectSteps(
    f: ForgeClient,
    fragment: string,
  ): Promise<Result> {
    const client = createOmrClient(provider.brokerUrl);
    const cached = readCachedLayouts(repoId, taskId, omrModels.layoutModel);
    try {
      if (!pages.every((pg) => cached[pg.image])) {
        runner.log.step("Checking the recognition service");
        await client.requirePipelines([omrModels.layoutModel]);
      }
      let measures = 0;
      let staves = 0;
      let grandstaves = 0;
      for (const [p, pg] of pages.entries()) {
        runner.log.step(
          `Detecting the layout of page ${p + 1} of ${pages.length}`,
        );
        let layout = cached[pg.image];
        if (layout) {
          runner.log.detail(
            "Result stored in this browser from an earlier detection",
          );
        } else {
          layout = await detectPage(f, client, fragment, p, pg);
          writeCachedLayout(
            repoId,
            taskId,
            omrModels.layoutModel,
            pg.image,
            layout,
          );
        }
        rawLayouts[p] = layout;
        const boxes = layoutBoxes(layout, pg);
        pages[p].zones = boxes.measures.map((box) => ({
          box,
          override: null,
          label: "",
          sb: false,
          sbOverride: null,
          mdiv: false,
        }));
        pages[p].staves = boxes.staves.map((box) => ({ box }));
        pages[p].grandstaves = boxes.grandstaves.map((box) => ({ box }));
        resortStaves(p);
        resortStaves(p, "grandstaves");
        measures += boxes.measures.length;
        staves += boxes.staves.length;
        grandstaves += boxes.grandstaves.length;
        runner.log.detail(
          `${boxes.staves.length} staves, ${boxes.grandstaves.length} grand staves, ${boxes.measures.length} measures`,
        );
      }
      seedLayout();
      setLayoutStep(1);
      resetHistory();
      return {
        ok: true,
        message: `Layout detected: ${staves} staves, ${grandstaves} grand staves and ${measures} measures on ${pages.length} page(s). Correct the staff boxes, then the grand staves, then the measures, then submit.`,
      };
    } catch (e) {
      return { error: `Layout detection failed: ${(e as Error).message}` };
    }
  }

  // One page's layout from the model.
  async function detectPage(
    f: ForgeClient,
    client: ReturnType<typeof createOmrClient>,
    fragment: string,
    p: number,
    pg: EditPage,
  ): Promise<CocoLayout> {
    const path = resolveRepoRelativeTarget(fragment, pg.image);
    const image = path ? await f.getRepoFileBytes(owner, repo, path) : null;
    if (!image)
      throw new Error(
        `the image of page ${p + 1} (${pg.image}) could not be read.`,
      );
    return client.withPage(async (pageId) => {
      await client.upload(pageId, { "image.jpg": image });
      const execution = await client.run(
        pageId,
        omrModels.layoutModel,
        ["image.jpg"],
        LAYOUT_PARAMETERS,
      );
      if (execution.state !== "completed") {
        throw new Error(
          `the layout model failed on page ${p + 1}: ${execution.error ?? execution.state}.`,
        );
      }
      const files = await client.download(pageId, ["layout.json"]);
      return JSON.parse(await files["layout.json"].text()) as CocoLayout;
    });
  }

  // ------------------------------------------------------------------------
  // Undo / redo
  //
  // History holds full snapshots of the page zones. Each committed edit pushes
  // a snapshot; undo/redo move within the stack and restore one. `selected` is
  // a transient pointer, not part of a snapshot, so it is cleared on restore.
  let history = $state<EditPage[][]>([]);
  let historyIndex = $state(-1);

  function clonePages(src: EditPage[]): EditPage[] {
    return src.map((pg) => ({
      ...pg,
      zones: pg.zones.map((z) => ({ ...z, box: { ...z.box } })),
      staves: pg.staves.map((s) => ({ box: { ...s.box } })),
      grandstaves: pg.grandstaves.map((g) => ({ box: { ...g.box } })),
    }));
  }

  // Discard any history and start a fresh baseline (after a load/reload).
  function resetHistory() {
    history = [clonePages(pages)];
    historyIndex = 0;
  }

  // Record the current pages as a new entry, dropping any redo tail. The
  // history holds full snapshots, so it is capped: the oldest entries fall
  // off once the limit is reached.
  const HISTORY_LIMIT = 100;
  function commit() {
    history = history.slice(
      Math.max(0, historyIndex + 2 - HISTORY_LIMIT),
      historyIndex + 1,
    );
    history.push(clonePages(pages));
    historyIndex = history.length - 1;
  }

  // After a geometry change: re-sort the page's layer, keep the same box
  // selected across the re-sort (its index may change) so further edits need
  // no extra click, then record the step.
  function commitGeometry(p: number, z: number) {
    const item = items(p)[z];
    if (tool === "measures") resort(p);
    else resortStaves(p, tool);
    selected = { p, z: items(p).indexOf(item) };
    commit();
  }

  const canUndo = $derived(canEdit && historyIndex > 0);
  const canRedo = $derived(canEdit && historyIndex < history.length - 1);

  function undo() {
    if (!canUndo) return;
    historyIndex--;
    pages = clonePages(history[historyIndex]);
    selected = null;
  }

  function redo() {
    if (!canRedo) return;
    historyIndex++;
    pages = clonePages(history[historyIndex]);
    selected = null;
  }

  // ------------------------------------------------------------------------
  // Break flags
  //
  // The page break is derived from position (each page's first measure). A page
  // break implies a system break, so on a page's first measure the system flag
  // is fixed on and the button is disabled. The score's first measure always
  // opens the first movement, so its section flag is fixed on too.
  const pbAt = (z: number) => z === 0;
  const sbActive = (p: number, z: number) => pbAt(z) || pages[p].zones[z].sb;
  const sectionLocked = (p: number, z: number) => p === 0 && z === 0;

  // A flag set to what the rows give follows the rows again.
  function toggleSb(p: number, z: number) {
    if (!canEdit || pbAt(z)) return;
    const zone = pages[p].zones[z];
    const next = !zone.sb;
    zone.sbOverride = next === rowStarts(p).has(zone.box) ? null : next;
    zone.sb = next;
    commit();
  }
  function toggleSection(p: number, z: number) {
    if (!canEdit || sectionLocked(p, z)) return;
    pages[p].zones[z].mdiv = !pages[p].zones[z].mdiv;
    commit();
  }

  function setLabel(p: number, z: number, value: string) {
    pages[p].zones[z].override = value.trim() === "" ? null : value.trim();
    renumber();
  }

  // ------------------------------------------------------------------------
  // Pointer interactions (box move / resize / draw)

  let svgEls = $state<SVGSVGElement[]>([]);
  // Each visible page's rendered canvas width (px), so the SVG number labels can
  // be sized to a near-constant on-screen size across zoom and 1-/2-page view.
  let canvasW = $state<number[]>([]);
  // Labels and box borders grow a little with zoom (damped) so they do not
  // feel oversized zoomed out or small zoomed in.
  const damp = $derived(Math.min(1.7, Math.max(0.8, 0.7 + 0.3 * zoom)));
  // On-screen height (px) for the number label at 100%.
  const LABEL_PX = 11;
  const labelFont = (p: number, pageW: number) => {
    const target = LABEL_PX * damp;
    return canvasW[p] ? (target * pageW) / canvasW[p] : target;
  };

  type Drag = {
    kind: "move" | "resize" | "draw";
    layer: Layer;
    p: number;
    z: number;
    sx: number;
    sy: number;
    orig: MeasureBox;
    moved: boolean;
    // For a resize: which edges follow the pointer — "n", "s", "e", "w" or a
    // corner's pair ("nw", "se", …).
    edges: string;
    // A draw creates its box only once the pointer has moved a few
    // millimetres on screen, so a plain click leaves nothing behind.
    started: boolean;
    // A background press that cleared a selection only deselects; it never
    // sets a corner.
    deselected: boolean;
  };
  let drag: Drag | null = null;
  // The first corner of a box drawn by two clicks instead of a drag, in page
  // pixels. A second click on the same page and layer completes the box.
  let corner = $state<{ p: number; layer: Layer; x: number; y: number } | null>(
    null,
  );
  // In page pixels: a box is at least MIN_BOX each way, a drawn box under
  // DROP_BELOW was a background click, and an arrow key moves NUDGE
  // (NUDGE_FAR with Shift).
  const MIN_BOX = 5;
  const DROP_BELOW = 8;
  const NUDGE = 2;
  const NUDGE_FAR = 10;

  // The cursor class for a resize handle: a corner gets the diagonal arrows,
  // a side the axis arrows.
  const resizeCursor = (edges: string) =>
    edges === "n" || edges === "s"
      ? "h-ns"
      : edges === "e" || edges === "w"
        ? "h-ew"
        : edges === "nw" || edges === "se"
          ? "h-nwse"
          : "h-nesw";

  // The selected box's handles: the four edges, then the four corners.
  const HANDLES = [
    { edges: "n", side: "top edge" },
    { edges: "s", side: "bottom edge" },
    { edges: "w", side: "left edge" },
    { edges: "e", side: "right edge" },
    { edges: "nw", side: "top-left corner" },
    { edges: "ne", side: "top-right corner" },
    { edges: "sw", side: "bottom-left corner" },
    { edges: "se", side: "bottom-right corner" },
  ];

  const svgXY = (e: PointerEvent, p: number) =>
    pagePoint(e, svgEls[p].getBoundingClientRect(), pages[p]);

  // Start a move (from the zone body) or resize (from an edge or corner
  // handle) drag. A click on the zone body selects it even read-only; the
  // handles only exist in edit mode.
  function startZoneDrag(
    e: PointerEvent,
    p: number,
    z: number,
    kind: "move" | "resize",
    edges = "",
  ) {
    // On a touch screen an unselected box lets the finger scroll the page;
    // a tap selects it (tapSelect).
    if (coarse && !(selected?.p === p && selected.z === z)) return;
    if (kind === "move") selected = { p, z };
    corner = null;
    // The page behind the box must not take the press as a deselect.
    e.stopPropagation();
    if (!canEdit) return;
    selected = { p, z };
    const { x, y } = svgXY(e, p);
    drag = {
      kind,
      layer: tool,
      p,
      z,
      sx: x,
      sy: y,
      orig: { ...items(p)[z].box },
      moved: false,
      edges,
      started: true,
      deselected: false,
    };
  }

  function zoneKeydown(e: KeyboardEvent, p: number, z: number) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      selected = { p, z };
      return;
    }
    if (!canEdit || !e.key.startsWith("Arrow")) return;
    e.preventDefault();
    e.stopPropagation();
    selected = { p, z };
    const box = items(p)[z].box;
    const { dx, dy } = arrowShift(e.key, e.shiftKey ? NUDGE_FAR : NUDGE)!;
    Object.assign(box, movedBox(box, dx, dy, pages[p]));
    commitGeometry(p, z);
  }

  // Arrow keys on a focused resize handle move that handle's edges.
  function resizeKeydown(
    e: KeyboardEvent,
    p: number,
    z: number,
    edges: string,
  ) {
    if (!canEdit || !e.key.startsWith("Arrow")) return;
    e.preventDefault();
    e.stopPropagation();
    const box = items(p)[z].box;
    const { dx, dy } = arrowShift(e.key, e.shiftKey ? NUDGE_FAR : NUDGE)!;
    Object.assign(box, nudgedEdges(box, edges, dx, dy, MIN_BOX, pages[p]));
    commitGeometry(p, z);
  }

  function backgroundPointerDown(e: PointerEvent, p: number) {
    // A touch on a box selects it on the tap (tapSelect), also in draw mode.
    if (coarse && (e.target as Element).closest(".zone, .staff")) return;
    const deselected = selected !== null;
    // On a touch screen outside draw mode the finger scrolls; a tap on the
    // page deselects (backgroundTapEnd).
    if (coarse && !drawMode) {
      bgTap = { x: e.clientX, y: e.clientY };
      return;
    }
    selected = null;
    if (!canEdit) return;
    const { x, y } = svgXY(e, p);
    const box = { ulx: x, uly: y, lrx: x, lry: y };
    drag = {
      kind: "draw",
      layer: tool,
      p,
      z: -1,
      sx: x,
      sy: y,
      orig: box,
      moved: false,
      edges: "",
      started: false,
      deselected,
    };
  }

  // Add a box to a page's layer and select it; returns its index.
  function addBox(p: number, layer: Layer, box: MeasureBox): number {
    if (layer !== "measures") pages[p][layer].push({ box });
    else
      pages[p].zones.push({
        box,
        override: null,
        label: "",
        sb: false,
        sbOverride: null,
        mdiv: false,
      });
    const z = items(p, layer).length - 1;
    selected = { p, z };
    return z;
  }

  // A plain click on the page: the first sets a corner, the second on the same
  // page and layer completes the box spanning the two. A second click on the
  // same spot clears the corner.
  function cornerClick(p: number, layer: Layer, x: number, y: number) {
    const first = corner;
    corner = null;
    if (!first || first.p !== p || first.layer !== layer) {
      corner = { p, layer, x, y };
      return;
    }
    const box = drawnBox(first.x, first.y, x, y, MIN_BOX);
    if (box.lrx - box.ulx < DROP_BELOW || box.lry - box.uly < DROP_BELOW)
      return;
    commitGeometry(p, addBox(p, layer, box));
  }

  // A tap on the page outside a box, on a touch screen outside draw mode,
  // deselects; a scroll ends in pointercancel instead.
  let bgTap: { x: number; y: number } | null = null;
  function backgroundTapEnd(e: PointerEvent) {
    const tap = bgTap;
    bgTap = null;
    if (
      tap &&
      Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 10 &&
      !(e.target as Element).closest(".zone, .staff")
    )
      selected = null;
  }

  // While a finger resizes or draws a box, a magnifier above it shows the
  // point under the finger: page coordinates and the finger's screen point.
  let loupe = $state<{
    p: number;
    x: number;
    y: number;
    cx: number;
    cy: number;
  } | null>(null);
  const LOUPE_PX = 120;
  const LOUPE_ZOOM = 2;
  const loupeAt = (e: PointerEvent, p: number, x: number, y: number) => {
    loupe =
      e.pointerType === "touch"
        ? { p, x, y, cx: e.clientX, cy: e.clientY }
        : null;
  };

  function pointerMove(e: PointerEvent) {
    if (!drag) return;
    const { x, y } = svgXY(e, drag.p);
    if (drag.kind !== "move" && (drag.kind !== "draw" || drag.started))
      loupeAt(e, drag.p, x, y);
    const dx = x - drag.sx;
    const dy = y - drag.sy;
    const pg = pages[drag.p];
    if (!drag.started) {
      if (!drawStarted(dx, dy, pg, canvasW[drag.p] || pg.width)) return;
      corner = null;
      drag.z = addBox(drag.p, drag.layer, { ...drag.orig });
      drag.started = true;
    }
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    const box = items(drag.p, drag.layer)[drag.z].box;
    Object.assign(
      box,
      drag.kind === "move"
        ? movedBox(drag.orig, dx, dy, pg)
        : drag.kind === "draw"
          ? drawnBox(drag.sx, drag.sy, x, y, MIN_BOX)
          : resizedBox(drag.orig, drag.edges, x, y, MIN_BOX),
    );
  }

  // A second finger turns the gesture into a pinch: the drag the first one
  // started is undone.
  function cancelDrag() {
    loupe = null;
    if (!drag) return;
    const { kind, layer, p, z, started, orig } = drag;
    drag = null;
    if (!started) return;
    if (kind === "draw") {
      items(p, layer).splice(z, 1);
      selected = null;
    } else Object.assign(items(p, layer)[z].box, orig);
  }

  function pointerUp() {
    loupe = null;
    if (!drag) return;
    const { kind, layer, p, z, moved, started, deselected, sx, sy } = drag;
    drag = null;
    // A draw that never crossed the threshold was a plain click.
    if (!started) {
      if (kind === "draw" && !deselected) cornerClick(p, layer, sx, sy);
      return;
    }
    if (kind === "draw") {
      const box = items(p, layer)[z].box;
      // A tiny drawn box was just a background click — drop it.
      if (box.lrx - box.ulx < DROP_BELOW || box.lry - box.uly < DROP_BELOW) {
        items(p, layer).splice(z, 1);
        selected = null;
        return;
      }
    }
    if (kind !== "draw" && !moved) return; // plain select / handle click, no move
    commitGeometry(p, z);
  }

  function deleteSelected() {
    if (!selected) return;
    deleteZone(selected.p, selected.z);
  }

  // Remove a box of the active layer.
  function deleteZone(p: number, z: number) {
    if (!canEdit) return;
    items(p).splice(z, 1);
    if (tool === "measures") resort(p);
    else resortStaves(p, tool);
    selected = null;
    commit();
  }

  function keydown(e: KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    // Cmd/Ctrl+Z undoes; add Shift (or Ctrl+Y) to redo.
    if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      redo();
      return;
    }
    if (e.key === "Escape" && (corner || helpOpen)) {
      if (corner) corner = null;
      else helpOpen = false;
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === "ArrowRight") {
      go(1);
    } else if (e.key === "ArrowLeft") {
      go(-1);
    }
  }

  // Paint order for a page's zones: the selected zone is moved to the end so it
  // renders on top. SVG has no z-index, so an earlier zone would otherwise sit
  // under a later overlapping one and steal its pointer events.
  function paintOrder(
    pg: EditPage,
    p: number,
  ): { zone: EditZone; z: number }[] {
    const entries = pg.zones.map((zone, z) => ({ zone, z }));
    if (tool === "measures" && selected?.p === p) {
      const i = entries.findIndex((e) => e.z === selected!.z);
      if (i >= 0) entries.push(entries.splice(i, 1)[0]);
    }
    return entries;
  }

  // Same for the staff and grand-staff layers: the selected box paints last.
  function staffPaintOrder(
    pg: EditPage,
    p: number,
  ): { staff: EditStaff; s: number }[] {
    const entries = (tool === "grandstaves" ? pg.grandstaves : pg.staves).map(
      (staff, s) => ({ staff, s }),
    );
    if (tool !== "measures" && selected?.p === p) {
      const i = entries.findIndex((e) => e.s === selected!.z);
      if (i >= 0) entries.push(entries.splice(i, 1)[0]);
    }
    return entries;
  }

  let showOverlaps = $state(true);

  // Intersections of every pair of boxes on the layer the current tool edits.
  function overlaps(pg: EditPage): MeasureBox[] {
    const boxes = (
      tool === "measures"
        ? pg.zones
        : tool === "grandstaves"
          ? pg.grandstaves
          : pg.staves
    ).map((b) => b.box);
    const out: MeasureBox[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const ulx = Math.max(a.ulx, b.ulx);
        const uly = Math.max(a.uly, b.uly);
        const lrx = Math.min(a.lrx, b.lrx);
        const lry = Math.min(a.lry, b.lry);
        if (lrx > ulx && lry > uly) out.push({ ulx, uly, lrx, lry });
      }
    }
    return out;
  }

  const measureCount = $derived(pages.reduce((n, p) => n + p.zones.length, 0));
  const staffCount = $derived(pages.reduce((n, p) => n + p.staves.length, 0));
  const grandstaffCount = $derived(
    pages.reduce((n, p) => n + p.grandstaves.length, 0),
  );
  const movementCount = $derived(
    1 +
      pages.reduce(
        (n, pg, p) =>
          n + pg.zones.filter((z, i) => z.mdiv && (p > 0 || i > 0)).length,
        0,
      ),
  );
  // Whether a zone starts a movement in the emitted MEI (the very first
  // measure always opens the first one).
  const startsMovement = (p: number, z: number) =>
    sectionLocked(p, z) || (pages[p].zones[z].mdiv && (p > 0 || z > 0));

  // The at-a-glance flag markers drawn on the box label: § section, ⇱ page
  // beginning, ↵ system beginning (the page break already implies a system).
  const markers = (p: number, z: number) =>
    (startsMovement(p, z) ? "§" : "") +
    (pbAt(z) ? "⇱" : "") +
    (!pbAt(z) && pages[p].zones[z].sb ? "↵" : "");
  const labelText = (p: number, z: number) => {
    const m = markers(p, z);
    return (m ? m + " " : "") + pages[p].zones[z].label;
  };

  // Hover tooltip explaining a zone's break marker, if it carries one.
  const zoneTitle = (p: number, z: number) => {
    if (pbAt(z))
      return "⇱ page beginning — automatic: the first measure on each page";
    if (pages[p].zones[z].sb) return "↵ system beginning";
    return "";
  };

  // The selected box's name in the side panel and in its handles' labels.
  const itemName = (p: number, z: number) =>
    tool === "measures"
      ? `Measure ${pages[p].zones[z].label}`
      : `${tool === "grandstaves" ? "Grand staff" : "Staff"} ${z + 1}`;
  const selectedItem = $derived(
    selected && items(selected.p)[selected.z] ? selected : null,
  );

  const boxName = $derived(
    tool === "staves"
      ? "staff"
      : tool === "grandstaves"
        ? "grand staff"
        : "measure",
  );

  // The editing hints and outline legend, shown by the toolbar's help icon.
  // Shortcut names as the viewer's keyboard labels them.
  const mac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.userAgent);
  const MOD = mac ? "⌘" : "Ctrl+";
  const SHIFT = mac ? "⇧" : "Shift+";
  const helpLines = $derived([
    ...(canEdit && coarse
      ? [
          `Tap a box to select it, then drag it or its edges and corners. Turn on Draw box to draw a ${boxName} with your finger; without it a finger drag scrolls the page. Pinch to zoom.`,
        ]
      : canEdit
        ? [
            `Drag on the page, or click two opposite corners, to draw a ${boxName}. Drag a box to move it; its edges and corners resize it. Arrow keys nudge a selected box (${SHIFT}arrow moves 5 times as far). Esc clears a first corner.`,
          ]
        : []),
    ...(coarse
      ? []
      : [
          `${MOD}Z undo · ${MOD}${SHIFT}Z redo · ${mac ? "⌫" : "Delete"} removes the selected box · ← → change pages`,
        ]),
    omr
      ? "Wine red: staff · dark green: grand staff (the staves a brace joins) · teal: measure · thick purple: movement start"
      : "Thick purple: movement start",
  ]);
  let helpOpen = $state(false);
</script>

<svelte:head>
  <title>{taskTitle} · {session.pieceName || campaign} · Let's Encode!</title>
</svelte:head>

<svelte:window
  onpointermove={pointerMove}
  onpointerup={pointerUp}
  onpointercancel={cancelDrag}
  onkeydown={keydown}
/>

{#if runner.busy && runner.overlay}
  <LoadingOverlay
    log={runner.log}
    finished={runner.held}
    error={runner.result?.error}
    onContinue={() => runner.dismiss()}
  />
{/if}

<div class="corrector sidehost">
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
    <div class="deskwrap"><p class="muted">Loading the facsimile…</p></div>
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
    <div class="main" bind:clientWidth={mainW}>
      <div class="tbar" style={`--desk-h:${deskH}px`}>
        <div class="ctoolbar">
          <div class="seg" title="How many pages the desk shows side by side">
            <button
              type="button"
              class:on={view === "single"}
              aria-pressed={view === "single"}
              onclick={() => (view = "single")}>1 page</button
            >
            <button
              type="button"
              class:on={view === "double"}
              aria-pressed={view === "double"}
              onclick={() => (view = "double")}>2 pages</button
            >
          </div>
          {#if view === "double"}
            <label
              class="checkline"
              title="Whether page 1 is a right-hand page, so a spread pairs 2–3, 4–5, … the way the score opens"
            >
              <input type="checkbox" bind:checked={firstOnRight} /> Page 1 right
            </label>
          {/if}
          <span class="tspacer"></span>
          <span class="zoomset">
            <input
              class="zoomslider"
              type="range"
              aria-label="Zoom"
              aria-valuetext={`${Math.round(zoom * 100)}%`}
              min={0}
              max={ZOOM_STOPS}
              step={1}
              value={zoomPos}
              oninput={(e) => {
                setZoomPos(Number((e.target as HTMLInputElement).value));
                fit = null;
              }}
            />
            <span class="zval">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              class="tbtn tbtn-icon zoomstep"
              onclick={() => {
                setZoomPos(Math.max(0, zoomPos - ZOOM_STEP));
                fit = null;
              }}
              disabled={zoomPos <= 0}
              aria-label="Zoom out"
              title="Zoom out"><Icon name="zoom-out" /></button
            >
            <button
              type="button"
              class="tbtn tbtn-icon zoomstep"
              onclick={() => {
                setZoomPos(Math.min(ZOOM_STOPS, zoomPos + ZOOM_STEP));
                fit = null;
              }}
              disabled={zoomPos >= ZOOM_STOPS}
              aria-label="Zoom in"
              title="Zoom in"><Icon name="zoom-in" /></button
            >
            <button
              type="button"
              class="tbtn tbtn-icon"
              class:on={fit === "width"}
              aria-pressed={fit === "width"}
              onclick={() => (fit = "width")}
              aria-label="Fit the page width"
              title="Fit the page width to the view"
              ><FitIcon kind="width" /></button
            >
            <button
              type="button"
              class="tbtn tbtn-icon fitpage"
              class:on={fit === "page"}
              aria-pressed={fit === "page"}
              onclick={fitWholePage}
              aria-label="Fit the whole page"
              title="Fit the whole page in the view, top to bottom"
              ><FitIcon kind="page" /></button
            >
          </span>
          <span class="vline"></span>
          {#if canEdit}
            <button
              type="button"
              class="btn btn-icon"
              onclick={() => undo()}
              disabled={!canUndo}
              aria-label="Undo"
              title="Undo the last change (Ctrl/Cmd+Z)"
              ><Icon name="undo" /></button
            >
            <button
              type="button"
              class="btn btn-icon"
              onclick={() => redo()}
              disabled={!canRedo}
              aria-label="Redo"
              title="Redo (Ctrl/Cmd+Shift+Z)"><Icon name="redo" /></button
            >
          {/if}
          <button
            type="button"
            class="btn btn-icon helpbtn"
            class:on={helpOpen}
            aria-label="Editor help"
            aria-expanded={helpOpen}
            aria-controls="zone-help"
            onclick={() => (helpOpen = !helpOpen)}
            ><Icon name="help" size={18} /></button
          >
          <span class="vh" role="status"
            >{corner
              ? `First corner set on page ${corner.p + 1}. Click the opposite corner to draw the ${boxName}.`
              : ""}</span
          >
          <!-- Last in the toolbar, next to the side panel on the right. -->
          <div class="pgnav">
            <span class="vline"></span>
            <button
              type="button"
              class="btn btn-icon pgbtn"
              onclick={() => go(-1)}
              disabled={atTop}
              aria-label="Previous page"
              title="Previous page"><Icon name="chevron-left" /></button
            >
            <span
              class="pglabel"
              style={`min-width:${pagesLabelCh(pages.length)}ch`}
              >{spreadLabel}</span
            >
            <button
              type="button"
              class="btn btn-icon pgbtn"
              onclick={() => go(1)}
              disabled={atEnd}
              aria-label="Next page"
              title="Next page"><Icon name="chevron-right" /></button
            >
          </div>
        </div>
        {#if helpOpen}
          <div
            id="zone-help"
            class="helppanel"
            role="region"
            aria-label="Editor help"
          >
            <ul>
              {#each helpLines as line (line)}
                <li>{line}</li>
              {/each}
            </ul>
            <button
              type="button"
              class="btn btn-icon"
              aria-label="Close the editor help"
              onclick={() => (helpOpen = false)}><Icon name="close" /></button
            >
          </div>
        {/if}
      </div>
      <RunnerBanner {runner} bar />
      <TaskRunState task={taskId} bar />

      <div
        class="desk"
        bind:this={desk}
        bind:clientWidth={deskW}
        bind:clientHeight={deskH}
        onscroll={deskScrolled}
        {@attach zoomGestures({
          get: () => zoom,
          set: (z) => {
            zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
            fit = null;
          },
          onpinchstart: cancelDrag,
        })}
      >
        <div
          class="pages"
          class:double={shownView === "double"}
          style={`--zoom:${zoom}; --stroke-scale:${damp}`}
        >
          {#each spreads as sp, r (r)}
            <div class="row" bind:this={rowEls[r]}>
              {#if sp.lonelySide === "right"}<div
                  class="page-spacer"
                ></div>{/if}
              {#each sp.pages as p (p)}
                {@const pg = pages[p]}
                <div class="page">
                  <p class="page-label pagehead">Page {p + 1} · Facsimile</p>
                  {#if pg.failed}
                    <div class="banner err">
                      The page facsimile for page {p + 1} could not be loaded. The
                      zones are shown without their reference image.
                    </div>
                  {/if}
                  <div class="canvas" bind:clientWidth={canvasW[p]}>
                    <svg
                      bind:this={svgEls[p]}
                      viewBox={`0 0 ${pg.width} ${pg.height}`}
                      class:staves={tool === "staves"}
                      class:grandstaves={tool === "grandstaves"}
                      class:pan={coarse && !drawMode}
                      role="application"
                      aria-label={`Page ${p + 1} ${tool}`}
                      onpointerdown={(e) => backgroundPointerDown(e, p)}
                      onpointerup={backgroundTapEnd}
                    >
                      <!-- Pages far from the view keep their size but draw nothing. -->
                      {#if nearPages.includes(p)}
                        {#if pg.url}
                          <image
                            href={pg.url}
                            width={pg.width}
                            height={pg.height}
                            onerror={() => (pages[p].failed = true)}
                          />
                        {/if}
                        {#each tool !== "measures" ? staffPaintOrder(pg, p) : [] as { staff, s } (`${tool}-${s}`)}
                          <rect
                            class="staff"
                            class:grand={tool === "grandstaves"}
                            class:selected={selected?.p === p &&
                              selected?.z === s}
                            vector-effect="non-scaling-stroke"
                            role="button"
                            tabindex={0}
                            aria-label={`${tool === "grandstaves" ? "Grand staff" : "Staff"} ${s + 1}${canEdit ? ": select, drag or resize" : ""}`}
                            x={staff.box.ulx}
                            y={staff.box.uly}
                            width={staff.box.lrx - staff.box.ulx}
                            height={staff.box.lry - staff.box.uly}
                            onpointerdown={(e) =>
                              startZoneDrag(e, p, s, "move")}
                            onclick={() => tapSelect(p, s)}
                            onkeydown={(e) => zoneKeydown(e, p, s)}
                          />
                        {/each}
                        {#each tool === "measures" ? paintOrder(pg, p) : [] as { zone, z } (z)}
                          <rect
                            class="zone"
                            class:selected={selected?.p === p &&
                              selected?.z === z}
                            class:mdivstart={startsMovement(p, z)}
                            vector-effect="non-scaling-stroke"
                            role="button"
                            tabindex={0}
                            aria-label={`Measure ${zone.label}${canEdit ? ": select, drag, or edit its number and breaks" : ""}`}
                            x={zone.box.ulx}
                            y={zone.box.uly}
                            width={zone.box.lrx - zone.box.ulx}
                            height={zone.box.lry - zone.box.uly}
                            onpointerdown={(e) =>
                              startZoneDrag(e, p, z, "move")}
                            onclick={() => tapSelect(p, z)}
                            onkeydown={(e) => zoneKeydown(e, p, z)}
                          >
                            {#if zoneTitle(p, z)}
                              <title>{zoneTitle(p, z)}</title>
                            {/if}
                          </rect>
                          {@const lbl = labelText(p, z)}
                          {@const fs = labelFont(p, pg.width)}
                          {@const inset = fs * 0.6}
                          {@const lblW = lbl.length * fs * 0.62 + fs * 0.9}
                          {@const on = selected?.p === p && selected?.z === z}
                          <rect
                            class="labelbg"
                            class:on
                            x={zone.box.ulx + inset}
                            y={zone.box.uly + inset}
                            width={lblW}
                            height={fs * 1.55}
                            rx={fs * 0.28}
                          />
                          <text
                            class="zonelabel"
                            class:on
                            x={zone.box.ulx + inset + lblW / 2}
                            y={zone.box.uly + inset + fs * 1.12}
                            text-anchor="middle"
                            font-size={fs}>{lbl}</text
                          >
                        {/each}
                        {#each showOverlaps ? overlaps(pg) : [] as o, i (i)}
                          <rect
                            class="overlap"
                            x={o.ulx}
                            y={o.uly}
                            width={o.lrx - o.ulx}
                            height={o.lry - o.uly}
                          />
                        {/each}
                        {#if corner?.p === p && corner.layer === tool}
                          {@const r = labelFont(p, pg.width) * 0.9}
                          <path
                            class="corner"
                            vector-effect="non-scaling-stroke"
                            d={`M${corner.x - r} ${corner.y}H${corner.x + r}M${corner.x} ${corner.y - r}V${corner.y + r}`}
                          />
                        {/if}
                      {/if}
                    </svg>

                    {#if canEdit && selectedItem?.p === p}
                      {@render handles(p, selectedItem.z)}
                    {/if}
                  </div>
                </div>
              {/each}
              {#if sp.lonelySide === "left"}<div class="page-spacer"></div>{/if}
            </div>
          {/each}
        </div>
      </div>
    </div>

    <!-- The selected box's body and its resize handles, over the page in
         screen pixels: a body that drags the box, round corner handles and
         edge strips, at touch size on a touch screen. Their percentages
         place them on the box at any zoom. -->
    {#snippet handles(p: number, z: number)}
      {@const pg = pages[p]}
      {@const b = items(p)[z].box}
      {@const name = itemName(p, z)}
      <div
        class="sel"
        class:touch={coarse}
        class:staves={tool === "staves"}
        class:grandstaves={tool === "grandstaves"}
        style:left={`${(b.ulx / pg.width) * 100}%`}
        style:top={`${(b.uly / pg.height) * 100}%`}
        style:width={`${((b.lrx - b.ulx) / pg.width) * 100}%`}
        style:height={`${((b.lry - b.uly) / pg.height) * 100}%`}
      >
        <div
          class="selbody"
          aria-hidden="true"
          onpointerdown={(ev) => startZoneDrag(ev, p, z, "move")}
        ></div>
        {#each HANDLES as h (h.edges)}
          <div
            class="hd hd-{h.edges} {resizeCursor(h.edges)}"
            role="button"
            tabindex={0}
            aria-label={`${name}: resize (${h.side})`}
            onpointerdown={(ev) => startZoneDrag(ev, p, z, "resize", h.edges)}
            onkeydown={(ev) => resizeKeydown(ev, p, z, h.edges)}
          ></div>
        {/each}
      </div>
    {/snippet}

    <!-- The task tools in the side panel: the layout steps (an OMR-prepared
         piece) or the counts, draw mode on a touch screen, and the overlap
         colouring. -->
    {#snippet tools()}
      <div class="wtools">
        {#if omr}
          <div
            class="steplist"
            role="group"
            aria-label="Steps"
            title="The three steps of the measure correction. Each step shows only its own boxes."
          >
            {#each [{ step: 1, swatch: "staff", long: "Staff boxes", short: "Staves", count: `${staffCount}` }, { step: 2, swatch: "grand", long: "Grand staves", short: "Grand", count: `${grandstaffCount}` }, { step: 3, swatch: "measure", long: "Measures", short: "Measures", count: `${measureCount} · ${movementCount} movement${movementCount === 1 ? "" : "s"}` }] as s (s.step)}
              <button
                type="button"
                class:on={layoutStep === s.step}
                aria-pressed={layoutStep === s.step}
                onclick={() => setLayoutStep(s.step as 1 | 2 | 3)}
                ><span class="swatch {s.swatch}" aria-hidden="true"></span><span
                  class="steplong">{s.step} · {s.long}</span
                ><span class="stepshort">{s.short}</span><span class="stepcount"
                  >{s.count}</span
                ></button
              >
            {/each}
          </div>
        {:else}
          <span class="abcount"
            >{measureCount} measure{measureCount === 1 ? "" : "s"} · {movementCount}
            movement{movementCount === 1 ? "" : "s"}</span
          >
        {/if}
        <div class="toolrow">
          {#if canEdit && coarse}
            <button
              type="button"
              class="chip-switch"
              class:on={drawMode}
              aria-pressed={drawMode}
              onclick={() => {
                drawMode = !drawMode;
                corner = null;
              }}
              title={`Draw a new ${boxName} with your finger. Off, a finger drag scrolls the page.`}
              ><span class="sw"></span>Draw box</button
            >
          {/if}
          <button
            type="button"
            class="chip-switch"
            class:on={showOverlaps}
            aria-pressed={showOverlaps}
            onclick={() => (showOverlaps = !showOverlaps)}
            title="Show or hide the colour on areas where two boxes overlap"
            ><span class="sw"></span>Show overlaps</button
          >
        </div>
      </div>
    {/snippet}

    <!-- The selected box's controls: its name, previous and next box, and
         for a measure its number and breaks. -->
    {#snippet selection()}
      {#if selectedItem}
        {@const { p, z } = selectedItem}
        <div class="selpanel">
          <div class="selhead">
            <span
              class="swatch {tool === 'staves'
                ? 'staff'
                : tool === 'grandstaves'
                  ? 'grand'
                  : 'measure'}"
              aria-hidden="true"
            ></span>
            <span class="selname">{itemName(p, z)}</span>
            <span class="selwhere">page {p + 1}</span>
            <button
              type="button"
              class="btn btn-icon"
              onclick={() => stepSelection(-1)}
              disabled={!hasPrev}
              aria-label={`Previous ${boxName}`}
              title={`Previous ${boxName}`}><Icon name="chevron-left" /></button
            >
            <button
              type="button"
              class="btn btn-icon"
              onclick={() => stepSelection(1)}
              disabled={!hasNext}
              aria-label={`Next ${boxName}`}
              title={`Next ${boxName}`}><Icon name="chevron-right" /></button
            >
            {#if coarse}
              <button
                type="button"
                class="btn btn-icon"
                onclick={() => (selected = null)}
                aria-label={`Deselect the ${boxName}`}
                title={`Deselect the ${boxName}`}><Icon name="close" /></button
              >
            {/if}
          </div>
          {#if tool === "measures"}
            {@const zone = pages[p].zones[z]}
            {#if canEdit}
              <label class="selfield"
                >Number
                <input
                  value={zone.override ?? zone.label}
                  oninput={(e) =>
                    setLabel(p, z, (e.target as HTMLInputElement).value)}
                  onchange={() => commit()}
                  title="Type to override the automatic number, e.g. 10a. The following measures count on from it."
                />
              </label>
            {/if}
            <div class="selflags">
              <button
                type="button"
                class="chip-switch"
                class:on={sbActive(p, z)}
                aria-pressed={sbActive(p, z)}
                onclick={() => toggleSb(p, z)}
                disabled={!canEdit || pbAt(z)}
                title={pbAt(z)
                  ? "The first measure on a page always starts a system"
                  : "This measure starts a new system (line) of the score"}
                ><span class="sw"></span>Starts a system</button
              >
              <button
                type="button"
                class="chip-switch"
                class:on={startsMovement(p, z)}
                aria-pressed={startsMovement(p, z)}
                onclick={() => toggleSection(p, z)}
                disabled={!canEdit || sectionLocked(p, z)}
                title={sectionLocked(p, z)
                  ? "The first measure always starts the first section"
                  : "This measure starts a new movement or section"}
                ><span class="sw"></span>Starts a section</button
              >
            </div>
          {/if}
          <div class="selactions">
            {#if canEdit}
              <button
                type="button"
                class="btn btn-danger"
                onclick={() => deleteZone(p, z)}
                ><Icon name="trash" /> Delete {boxName}</button
              >
            {/if}
            {#if selectedLabel && auth.user}
              <button
                type="button"
                class="btn"
                onclick={() => (panelTab = "comments")}
                ><Icon name="comment" /> Comment on measure {selectedLabel}</button
              >
            {/if}
          </div>
        </div>
      {:else}
        <p class="selnone">
          {coarse ? "Tap" : "Click"} a box on the page to {canEdit
            ? "edit it"
            : "select it"}.
        </p>
      {/if}
    {/snippet}

    <!-- The task's action at the panel's bottom: the claim or the draft
         state and give back, then the next step or the submission. -->
    {#snippet footer()}
      <div class="wfoot">
        <span class="wstatus"><PreTaskStatus {session} /></span>
        {#if omr && layoutStep === 1}
          <button
            type="button"
            class="btn btn-secondary"
            onclick={() => setLayoutStep(2)}
            title="Go on to step 2: the grand staves, one box around the staves each brace joins. Submission is in step 3."
          >
            Next: grand staves
          </button>
        {:else if omr && layoutStep === 2}
          <button
            type="button"
            class="btn btn-secondary"
            onclick={() => setLayoutStep(3)}
            title="Go on to step 3: the measures, their numbers and breaks. Submission is in step 3."
          >
            Next: measures
          </button>
        {:else}
          <button
            type="button"
            class="btn btn-primary"
            onclick={() => submit()}
            disabled={busy || !canEdit || submitBlock !== null}
            title={submitBlock ??
              (omr
                ? "Submit the corrected staves, grand staves, measures, breaks and movements for review"
                : "Submit the corrected measures, breaks and movements for review")}
          >
            Submit corrections
          </button>
        {/if}
      </div>
    {/snippet}

    {#snippet taskBox()}
      {#if session.card}
        <PreTaskBox
          {session}
          {campaign}
          card={session.card}
          prefill={() => ({
            page: String((selected?.p ?? spreads[rowIndex]?.pages[0] ?? 0) + 1),
            m1: selectedLabel,
            m2: selectedLabel,
          })}
        />
      {/if}
    {/snippet}

    {#if tables}
      <TaskPageSidePanel
        {tables}
        {taskId}
        done={data?.status === "completed"}
        {viewer}
        {runner}
        bind:panel={sidePanel}
        {taskBox}
        {tools}
        {selection}
        selectionLabel="Selection"
        selectionActive={!!selectedItem}
        bind:tab={panelTab}
        footer={data.status === "encoding_required" ? footer : undefined}
        composerHint={selectedLabel
          ? `Comment on measure ${selectedLabel}…`
          : ""}
        onanchor={showAnchorFor}
        oncomment={(task, kind, body, parent_id) =>
          session.postComment(
            task,
            kind,
            body,
            parent_id,
            kind === "comment" ? commentAnchor() : undefined,
          )}
        onresolve={(id) => session.resolveComment(id)}
      />
    {/if}

    {#if loupe && pages[loupe.p]}
      {@const pg = pages[loupe.p]}
      {@const scale = canvasW[loupe.p] ? canvasW[loupe.p] / pg.width : 1}
      {@const span = LOUPE_PX / (LOUPE_ZOOM * scale)}
      {@const lx =
        loupe.cx - LOUPE_PX - 24 < 8 ? loupe.cx + 24 : loupe.cx - LOUPE_PX - 24}
      {@const ly = Math.max(8, loupe.cy - LOUPE_PX - 48)}
      <div
        class="loupe"
        aria-hidden="true"
        style:left={`${lx}px`}
        style:top={`${ly}px`}
        style:width={`${LOUPE_PX}px`}
        style:height={`${LOUPE_PX}px`}
      >
        <svg
          viewBox={`${loupe.x - span / 2} ${loupe.y - span / 2} ${span} ${span}`}
          class:staves={tool === "staves"}
          class:grandstaves={tool === "grandstaves"}
        >
          {#if pg.url}
            <image href={pg.url} width={pg.width} height={pg.height} />
          {/if}
          {#each items(loupe.p) as it, i (i)}
            <rect
              class={tool === "measures" ? "zone" : "staff"}
              class:grand={tool === "grandstaves"}
              vector-effect="non-scaling-stroke"
              x={it.box.ulx}
              y={it.box.uly}
              width={it.box.lrx - it.box.ulx}
              height={it.box.lry - it.box.uly}
            />
          {/each}
          <path
            class="cross"
            vector-effect="non-scaling-stroke"
            d={`M${loupe.x - span / 6} ${loupe.y}H${loupe.x + span / 6}M${loupe.x} ${loupe.y - span / 6}V${loupe.y + span / 6}`}
          />
        </svg>
      </div>
    {/if}
  {/if}
</div>

<style>
  .muted {
    color: var(--ink-faint);
    font-size: 0.9rem;
  }
  .linkish {
    font: inherit;
    font-weight: 600;
    color: var(--link);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  @media (hover: hover) {
    .linkish:hover {
      text-decoration: underline;
    }
  }

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
    margin: 12px 16px 12px 0;
  }

  /* ------------------------------------------------------------ side panel
     The task tools, the selected box's controls and the footer action, in
     the side panel's sections (SidePanel.svelte). */
  .wtools {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .abcount {
    font-size: 12.5px;
    color: var(--ink-soft);
    font-variant-numeric: tabular-nums;
  }
  .toolrow {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  /* The layout steps: a list with counts beside the content, three equal
     cells in a docked sheet (DOCKED_QUERY in side-panels.ts). */
  .steplist {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .steplist > button {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 0 12px;
    font: 400 13px var(--font);
    color: var(--ink);
    text-align: left;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 8px;
    cursor: pointer;
  }
  .steplist > button.on {
    font-weight: 600;
    background: var(--accent-tint-strong);
    border: 1.5px solid var(--accent);
  }
  .steplong {
    flex: 1;
  }
  .stepshort {
    display: none;
  }
  .stepcount {
    color: var(--ink-faint);
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }
  @media (orientation: portrait) and (max-width: 860px) {
    .steplist {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 2px;
      padding: 3px;
      background: var(--bg-tint);
      border-radius: 999px;
    }
    .steplist > button {
      justify-content: center;
      min-height: 40px;
      padding: 0 6px;
      font-size: 12px;
      font-weight: 600;
      color: var(--ink-soft);
      background: transparent;
      border: 0;
      border-radius: 999px;
    }
    .steplist > button.on {
      color: var(--ink);
      background: var(--card);
      border: 0;
      box-shadow: 0 1px 2px rgba(31, 36, 51, 0.1);
    }
    .steplong,
    .stepcount {
      display: none;
    }
    .stepshort {
      display: inline;
    }
    .toolrow .chip-switch {
      min-height: 40px;
    }
  }
  .selfield {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 120px;
    font-size: 12.5px;
    font-weight: 600;
  }
  .selfield input {
    font:
      400 14px ui-monospace,
      monospace;
    padding: 6px 10px;
    min-height: 34px;
    box-sizing: border-box;
    color: var(--ink);
    background: var(--card);
    border: 1px solid var(--line-input);
    border-radius: 8px;
  }
  .selflags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .selflags .chip-switch:disabled {
    opacity: 0.55;
    cursor: default;
  }
  /* In a docked sheet every control is a 44px touch target. */
  @media (orientation: portrait) and (max-width: 860px) {
    .selfield {
      flex-direction: row;
      align-items: center;
      gap: 8px;
      width: auto;
    }
    .selfield input {
      width: 72px;
    }
    .selflags .chip-switch,
    .selfield input {
      min-height: 44px;
      min-width: 44px;
    }
  }
  .wfoot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .wstatus {
    flex: 1;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    min-width: 0;
  }
  @media (orientation: portrait) and (max-width: 860px) {
    .wfoot :global(.btn) {
      min-height: 44px;
    }
  }

  .checkline {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 24px;
    font-size: 12px;
    color: var(--ink-soft);
    white-space: nowrap;
    cursor: pointer;
  }
  .checkline input {
    width: 16px;
    height: 16px;
    margin: 0;
    cursor: pointer;
  }
  /* The toolbar's help icon; its title carries the hints and colour legend. */
  .helpbtn.on {
    color: var(--accent);
    border-color: var(--accent);
  }
  /* The toolbar and the editor help below it. */
  .tbar {
    flex: none;
    position: relative;
  }
  /* The editor help, opened from the toolbar, between it and the pages. */
  .helppanel {
    flex: none;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-top: 8px;
    padding: 10px 14px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-soft);
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    box-shadow: var(--shadow-sm);
  }
  .helppanel ul {
    flex: 1;
    margin: 0;
    padding-left: 18px;
  }

  /* Banner styles are shared app-wide in ui.css. */
  /* Pre-editor states (loading, errors, login) on the desk. */
  .deskwrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 1.25rem 2rem;
    box-sizing: border-box;
  }
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
  .ctoolbar {
    flex: none;
    min-height: 44px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--card);
    box-shadow: var(--shadow-sm);
    overflow-x: auto;
  }
  /* The zoom controls, which wrap onto a new toolbar line together. */
  .zoomset {
    flex: 0 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  /* Zoom out and in by one step, in place of the slider where it is hidden. */
  .zoomstep {
    display: none;
  }
  /* A medium tool column (a tablet, or a laptop beside the side panel): the
     zoom slider and its readout give way to zoom out/in buttons, and what
     remains wraps onto a second line rather than scrolling out of view. */
  @container (max-width: 959px) {
    .ctoolbar {
      flex-wrap: wrap;
      row-gap: 4px;
      padding-block: 4px;
    }
    .zoomset > .zoomslider,
    .zoomset > .zval {
      display: none;
    }
    .zoomset > .zoomstep {
      display: inline-flex;
    }
  }
  /* Narrow tool column (NARROW_TOOL, a phone): the toolbar moves below the
     pages, within thumb reach, as one row at touch size: undo and redo, the
     page navigation, fit width and help. Zoom is a pinch. The page-count
     switch, "Page 1 right", the zoom buttons and fit page are hidden. The
     help opens above the toolbar, over the pages, so the desk keeps its
     height. */
  @container (max-width: 559px) {
    .tbar {
      order: 2;
      padding: 6px 0 max(6px, env(safe-area-inset-bottom));
    }
    .ctoolbar {
      gap: 2px;
      padding: 0 4px;
      flex-wrap: nowrap;
    }
    .ctoolbar > .seg,
    .ctoolbar > .checkline,
    .ctoolbar > .tspacer,
    .ctoolbar > .vline,
    .zoomset > .zoomslider,
    .zoomset > .zval,
    .zoomset > .zoomstep,
    .zoomset > .fitpage,
    .pgnav > .vline {
      display: none;
    }
    .zoomset {
      order: 2;
      flex: none;
      gap: 2px;
    }
    .helpbtn {
      order: 3;
    }
    .pgnav {
      order: 1;
      flex: 1;
      min-width: 0;
      justify-content: space-between;
    }
    /* The label gives up its reserved width so the row fits a phone. */
    .pglabel {
      flex: 1;
      min-width: 0 !important;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: center;
    }
    .helppanel {
      position: absolute;
      bottom: 100%;
      left: 0;
      right: 0;
      z-index: 5;
      margin: 0 0 8px;
      max-height: calc(var(--desk-h) - 16px);
      box-sizing: border-box;
      overflow: auto;
    }
    .ctoolbar :global(.btn),
    .ctoolbar :global(.tbtn) {
      min-width: 44px;
      min-height: 44px;
    }
  }
  .tspacer {
    flex: 1;
  }
  /* The scroll position is kept by page (see `anchor`), not by the browser. */
  .desk {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overflow-anchor: none;
    /* A pinch zooms the pages (zoomGestures), not the window. */
    touch-action: pan-x pan-y;
    padding: 16px 24px;
    box-sizing: border-box;
  }
  /* A narrow tool column gives the page most of its width. */
  @container (max-width: 559px) {
    .desk {
      padding-inline: 8px;
    }
  }
  .pages {
    min-width: 0;
  }
  /* A row's width is the zoom level: above 100% every row overflows the desk
     by the same amount, so the one desk scrollbar moves all pages together.
     Centred, so zoomed out the pages stay in the middle of the desk. */
  .row {
    width: calc(100% * var(--zoom, 1));
    margin-inline: auto;
  }
  /* Two-up view: the spread's pages (and any empty-half spacer) share the
     row, a few pixels apart at the spine, so they meet in the middle. */
  .pages.double .row {
    display: flex;
    align-items: flex-start;
    gap: 4px;
  }
  .pages.double .page,
  .page-spacer {
    flex: 1 1 0;
    min-width: 0;
  }

  .page {
    margin-bottom: 1.5rem;
  }
  .pagehead {
    margin-bottom: 4px;
  }
  /* Positioning context for the per-zone controls overlay: its width is the
     svg's, so percentage-placed controls line up with the boxes. */
  .canvas {
    position: relative;
  }
  /* Each page renders as a sheet floating on the desk. */
  svg {
    display: block;
    /* border-box so the 1px border stays within 100% and the page doesn't
       overflow its container by a couple of pixels at 100% zoom. */
    box-sizing: border-box;
    width: 100%;
    max-width: none;
    height: auto;
    background: var(--facsimile-paper);
    border: 1px solid var(--line-input);
    box-shadow: 0 10px 30px rgba(31, 36, 51, 0.16);
    touch-action: none;
    user-select: none;
  }
  /* Teal for measures, purple for movement starts: both hues sit outside the
     piece-region palette (--zone-1…8), so a colour never carries two meanings. */
  /* Strokes are screen pixels — the markup sets
     vector-effect="non-scaling-stroke" — scaled by the damped zoom factor
     --stroke-scale. */
  .zone {
    fill: rgba(14, 129, 149, 0.2);
    stroke: rgba(14, 129, 149, 0.85);
    stroke-width: calc(2px * var(--stroke-scale, 1));
    cursor: pointer;
  }
  .zone.selected {
    fill-opacity: 1;
    stroke-width: calc(3px * var(--stroke-scale, 1));
  }
  .zone.mdivstart {
    stroke: rgba(139, 95, 191, 0.9);
    fill: rgba(139, 95, 191, 0.22);
    stroke-width: calc(4px * var(--stroke-scale, 1));
  }
  /* Wine red for staff boxes, dark green for grand staves, teal for measures:
     hues outside the region palette, darker than the red and green that mean
     fail and done. Only one layer is shown at a time. */
  .staff {
    fill: rgba(128, 34, 64, 0.16);
    stroke: rgba(128, 34, 64, 0.9);
    stroke-width: calc(2px * var(--stroke-scale, 1));
    cursor: pointer;
  }
  .staff.selected {
    fill: rgba(128, 34, 64, 0.26);
    stroke-width: calc(3px * var(--stroke-scale, 1));
  }
  /* The first corner of a box drawn by two clicks, in its layer's colour. */
  .corner {
    stroke: rgba(14, 129, 149, 0.95);
    stroke-width: calc(2px * var(--stroke-scale, 1));
    pointer-events: none;
  }
  .staves .corner {
    stroke: rgba(128, 34, 64, 0.95);
  }
  .grandstaves .corner {
    stroke: rgba(38, 100, 60, 0.95);
  }
  /* The intersection of two boxes takes the inverse of the box colour. */
  .overlap {
    fill: rgba(255, 100, 70, 0.6);
    pointer-events: none;
  }
  .staves .overlap,
  .grandstaves .overlap {
    fill: rgba(240, 180, 40, 0.6);
  }
  .labelbg {
    fill: rgba(255, 255, 255, 0.88);
    pointer-events: none;
  }
  .zonelabel {
    font-family: ui-monospace, monospace;
    font-weight: 600;
    fill: #1a1a1a;
    pointer-events: none;
  }
  .staff.grand {
    fill: rgba(38, 100, 60, 0.16);
    stroke: rgba(38, 100, 60, 0.9);
  }
  .staff.grand.selected {
    fill: rgba(38, 100, 60, 0.26);
  }
  /* Each step carries the colour its boxes are drawn in. */
  .swatch {
    display: inline-block;
    width: 10px;
    height: 10px;
    margin-right: 5px;
    border-radius: 2px;
    vertical-align: -1px;
    border: 2px solid;
    box-sizing: border-box;
  }
  .swatch.staff {
    border-color: rgb(128, 34, 64);
    background: rgba(128, 34, 64, 0.2);
  }
  .swatch.grand {
    border-color: rgb(38, 100, 60);
    background: rgba(38, 100, 60, 0.2);
  }
  .swatch.measure {
    border-color: rgb(14, 129, 149);
    background: rgba(14, 129, 149, 0.2);
  }
  .h-ns {
    cursor: ns-resize;
  }
  .h-ew {
    cursor: ew-resize;
  }
  .h-nwse {
    cursor: nwse-resize;
  }
  .h-nesw {
    cursor: nesw-resize;
  }

  /* The selected box's body and handles (the handles snippet), in screen
     pixels over the page: --hit is a corner's target, --dot its visible
     dot, --edge an edge strip's thickness. A touch screen gets 44px targets
     and visible edge bars. */
  .sel {
    position: absolute;
    --hit: 20px;
    --dot: 10px;
    --edge: 12px;
    --c: rgb(14, 129, 149);
    pointer-events: none;
    z-index: 4;
  }
  .sel.staves {
    --c: rgb(128, 34, 64);
  }
  .sel.grandstaves {
    --c: rgb(38, 100, 60);
  }
  .sel.touch {
    --hit: 44px;
    --dot: 18px;
    --edge: 32px;
  }
  .selbody,
  .hd {
    position: absolute;
    pointer-events: auto;
    touch-action: none;
  }
  .selbody {
    inset: 0;
    cursor: move;
  }
  .hd {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .hd:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .hd-nw,
  .hd-ne,
  .hd-sw,
  .hd-se {
    width: var(--hit);
    height: var(--hit);
    z-index: 1;
  }
  .hd-nw,
  .hd-sw {
    left: calc(var(--hit) / -2);
  }
  .hd-ne,
  .hd-se {
    right: calc(var(--hit) / -2);
  }
  .hd-nw,
  .hd-ne {
    top: calc(var(--hit) / -2);
  }
  .hd-sw,
  .hd-se {
    bottom: calc(var(--hit) / -2);
  }
  .hd-nw::before,
  .hd-ne::before,
  .hd-sw::before,
  .hd-se::before {
    content: "";
    width: var(--dot);
    height: var(--dot);
    box-sizing: border-box;
    border-radius: 50%;
    background: #fff;
    border: 2px solid var(--c);
    box-shadow: 0 1px 3px rgba(31, 36, 51, 0.35);
  }
  .hd-n,
  .hd-s {
    left: calc(var(--hit) / 2);
    right: calc(var(--hit) / 2);
    height: var(--edge);
  }
  .hd-n {
    top: calc(var(--edge) / -2);
  }
  .hd-s {
    bottom: calc(var(--edge) / -2);
  }
  .hd-w,
  .hd-e {
    top: calc(var(--hit) / 2);
    bottom: calc(var(--hit) / 2);
    width: var(--edge);
  }
  .hd-w {
    left: calc(var(--edge) / -2);
  }
  .hd-e {
    right: calc(var(--edge) / -2);
  }
  .touch .hd-n::before,
  .touch .hd-s::before,
  .touch .hd-w::before,
  .touch .hd-e::before {
    content: "";
    border-radius: 999px;
    background: #fff;
    border: 2px solid var(--c);
    box-shadow: 0 1px 3px rgba(31, 36, 51, 0.35);
  }
  .touch .hd-n::before,
  .touch .hd-s::before {
    width: 26px;
    height: 10px;
  }
  .touch .hd-w::before,
  .touch .hd-e::before {
    width: 10px;
    height: 26px;
  }
  /* The selected measure's number label in the measure colour. */
  .labelbg.on {
    fill: rgb(14, 129, 149);
  }
  .zonelabel.on {
    fill: #fff;
  }
  /* On a touch screen outside draw mode a finger drag scrolls the page. */
  svg.pan {
    touch-action: pan-x pan-y;
  }
  /* The magnifier above a finger resizing or drawing a box. */
  .loupe {
    position: fixed;
    z-index: 60;
    border-radius: 50%;
    overflow: hidden;
    pointer-events: none;
    background: var(--facsimile-paper);
    border: 3px solid var(--card);
    box-shadow:
      0 0 0 1px var(--line-strong),
      0 6px 18px rgba(31, 36, 51, 0.3);
  }
  .loupe svg {
    width: 100%;
    height: 100%;
    border: 0;
    box-shadow: none;
  }
  .loupe .cross {
    stroke: var(--accent);
    stroke-width: 2px;
    fill: none;
  }
</style>
