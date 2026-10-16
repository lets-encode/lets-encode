<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import { tick, untrack, type Snippet } from "svelte";
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
  import { readingOrderRows, measureLabels } from "$lib/mei-facsimile.ts";
  import { taskDescription } from "$lib/campaign-graph.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import { DOCKED_QUERY, readSidePanel } from "$lib/side-panels.ts";
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
  import DraftBubble from "$lib/components/DraftBubble.svelte";
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
    centreInRegions,
    drawnBox,
    drawStarted,
    movedBox,
    nudgedEdges,
    pagePoint,
    regionsView,
    resizedBox,
  } from "$lib/box-geometry.ts";

  // The URL carries the campaign name and task; the repo is resolved from the
  // name (name → stable repo id → current owner/name) — see resolveCampaign.
  const campaign = $derived(page.params.campaign!);
  const taskId = $derived(page.params.task!);

  // Editor-side zone: the box, the label override (null = automatic), the
  // computed label, the break flags and the pickup flag. The page break is
  // derived from position (each page's first measure), not stored per-zone.
  // `sb` follows the reading-order rows (a row's first box starts a system)
  // unless `sbOverride` holds a value set by hand.
  type EditZone = {
    box: MeasureBox;
    override: string | null;
    label: string;
    sb: boolean;
    sbOverride: boolean | null;
    mdiv: boolean;
    pickup: boolean;
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
    // The piece's regions on the page; empty when it covers the whole page.
    regions: MeasureBox[];
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
        // Boxes outside the piece's regions on a page are dropped.
        let droppedMeasures = false;
        pages = d.model.pages.map((pg, i) => {
          const regions = d.regions[i] ?? [];
          const inPiece = (box: MeasureBox) => centreInRegions(box, regions);
          const zones = pg.zones.filter((z) => inPiece(z.box));
          if (zones.length < pg.zones.length) droppedMeasures = true;
          return {
            image: pg.image,
            width: pg.width,
            height: pg.height,
            url: d.imageUrls[i],
            failed: !d.imageUrls[i],
            zones: zones.map((z) => ({
              box: { ...z.box },
              override: null,
              label: z.label,
              sb: z.sb,
              sbOverride: null,
              mdiv: z.mdiv,
              pickup: z.pickup ?? false,
            })),
            staves: (pg.staves ?? [])
              .filter(inPiece)
              .map((box) => ({ box: { ...box } })),
            grandstaves: (pg.grandstaves ?? [])
              .filter(inPiece)
              .map((box) => ({ box: { ...box } })),
            regions,
          };
        });
        // A score of one or two pages is shown whole: one page, or both side
        // by side. Longer scores keep the two-up view with page 1 as a recto.
        if (pages.length <= 2)
          ({ view, firstOnRight } = defaultSpreadView(pages.length));
        // A label that differs from what automatic numbering would produce is
        // an override (e.g. 10a/10b) — keep it through renumbering. The
        // measure after each one is included, since a pickup changes the
        // label of the measure before it. With measures dropped, the labels
        // left are numbered automatically.
        if (droppedMeasures) renumber();
        else {
          const measures = numbering();
          measures.forEach((m, i) => {
            const auto = measureLabels(measures.slice(0, i + 2))[i];
            if (m.zone.label !== auto) m.override = m.zone.label;
          });
          for (const m of measures) m.zone.override = m.override;
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
  // A comment button counts up to open the panel's comment field.
  let compose = $state(0);
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
  /** Below this tool-column width (a phone) the desk shows one page per row
      and the toolbar keeps only undo, redo, the page navigation, fit width
      and the ⋯ menu (the 559px container rule in the styles). */
  const NARROW_TOOL = 560;
  /** Below this tool-column width (a tablet) the page-count switch and
      "Page 1 right" move into the ⋯ menu and zoom steps by buttons, so the
      toolbar stays one row (the 959px container rule in the styles). */
  const MEDIUM_TOOL = 960;
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

  // Where the piece covers only part of a page, the page shows that part:
  // its regions widened by REGION_MARGIN of the page width, unless the whole
  // page is asked for.
  const REGION_MARGIN = 0.02;
  let wholePage = $state(false);
  const partOf = (pg: EditPage): MeasureBox =>
    regionsView(pg.regions, pg, REGION_MARGIN);
  const isWhole = (v: MeasureBox, pg: EditPage) =>
    v.ulx <= 0 && v.uly <= 0 && v.lrx >= pg.width && v.lry >= pg.height;
  const hasPartPages = $derived(pages.some((pg) => !isWhole(partOf(pg), pg)));
  const shownArea = (pg: EditPage): MeasureBox =>
    wholePage ? { ulx: 0, uly: 0, lrx: pg.width, lry: pg.height } : partOf(pg);

  // The zoom at which a whole page fits in the desk: bounded by the height
  // (using the tallest page), capped at 1 (the width fit). 76 covers the
  // desk padding, the page heading above each sheet and the sheet's bottom
  // margin. A page cropped to the piece fits its shown part.
  function fitZoom(): number {
    if (!pages.length || !deskW || !deskH) return 1;
    const aspect = Math.max(
      ...pages.map((pg) => {
        const v = shownArea(pg);
        return (v.lry - v.uly) / (v.lrx - v.ulx);
      }),
    );
    const pagesW = deskW - 48;
    const colW = shownView === "double" ? (pagesW - 4) / 2 : pagesW;
    const usableH = deskH - 76;
    if (colW <= 0 || usableH <= 0) return 1;
    const z = usableH / (colW * aspect);
    return Math.min(1, Math.max(ZOOM_MIN, Math.floor(z * 1000) / 1000));
  }

  // The fit in force, if any: it keeps the zoom at the fit as the desk
  // resizes or the view changes, until the slider is moved. Each freshly
  // loaded task opens at two pages per row and the whole-page fit; on a
  // touch screen (a tablet) at one page per row and the page width, and in
  // an upright window (docked), where a two-page row leaves the desk's
  // lower part empty, or with a single page, at one page per row.
  let fit = $state<"width" | "page" | null>("page");
  let zoomInitFor = $state<FacsimileTaskData | null>(null);
  $effect(() => {
    if (!data || zoomInitFor === data) return;
    zoomInitFor = data;
    const touch = untrack(() => coarse);
    fit = touch ? "width" : "page";
    view =
      touch || untrack(() => docked) || data.model.pages.length === 1
        ? "single"
        : "double";
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
  // switch; the chosen view returns when the column widens. The width is the
  // toolbar's, the content box the container rules in the styles measure.
  let toolW = $state(0);
  const narrow = $derived(toolW > 0 && toolW < NARROW_TOOL);
  const medium = $derived(toolW > 0 && toolW < MEDIUM_TOOL);
  // A phone in portrait: the side panel is a sheet below the pages, and the
  // page toolbar sits at its top.
  const dockedQuery = new MediaQuery(DOCKED_QUERY, false);
  const docked = $derived(dockedQuery.current);
  const inSheet = $derived(narrow && docked);
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

  // Scroll events are read once per frame.
  let scrollFrame = 0;
  function deskScrollEvent() {
    if (!scrollFrame)
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        deskScrolled();
      });
  }
  function deskScrolled() {
    if (!desk) return;
    const rows = rowEls.slice(0, spreads.length);
    const v = rowView(desk, rows);
    rowIndex = v.current;
    if (v.shown.join() !== shownRows.join()) shownRows = v.shown;
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

  // The pages shown in each step. Submission waits until every page with
  // boxes in a step has been on screen in that step: a page without any
  // (no music, no braces) is a valid result that needs no look.
  let seen = $state<Record<Layer, number[]>>({
    staves: [],
    grandstaves: [],
    measures: [],
  });
  $effect(() => {
    const shown = shownPages;
    const layer = tool;
    untrack(() => {
      const added = shown.filter((p) => !seen[layer].includes(p));
      if (added.length) seen[layer] = [...seen[layer], ...added];
    });
  });
  const pageList = (ps: number[]) => ps.map((p) => p + 1).join(", ");
  const pagesWord = (ps: number[]) =>
    `${ps.length === 1 ? "page" : "pages"} ${pageList(ps)}`;
  // Why the task cannot be submitted yet, or null when it can.
  const submitBlock = $derived.by(() => {
    const unseen = (layer: Layer) =>
      pages.flatMap((_, p) =>
        seen[layer].includes(p) || !items(p, layer).length ? [] : [p],
      );
    if (!omr) {
      const pending = unseen("measures");
      return pending.length
        ? `Show ${pagesWord(pending)} before submitting.`
        : null;
    }
    for (const [i, layer] of STEP_LAYERS.entries()) {
      const pending = unseen(layer);
      if (pending.length) {
        return `Show ${pagesWord(pending)} in step ${i + 1} before submitting.`;
      }
    }
    const noMeasures = pages.flatMap((pg, p) =>
      pg.staves.length && !pg.zones.length ? [p] : [],
    );
    if (noMeasures.length) {
      return `${noMeasures.length === 1 ? "Page" : "Pages"} ${pageList(noMeasures)} ${noMeasures.length === 1 ? "has" : "have"} staff boxes but no measures.`;
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

  // Every measure in reading order with what its label is computed from.
  const numbering = () =>
    pages.flatMap((pg, p) =>
      pg.zones.map((zone, z) => ({
        zone,
        override: zone.override,
        pickup: zone.pickup,
        sectionStart: startsMovement(p, z),
      })),
    );

  // Recompute every label from reading order, sections, pickups and
  // overrides ("10a" continues as 11).
  function renumber() {
    const measures = numbering();
    const labels = measureLabels(measures);
    measures.forEach((m, i) => (m.zone.label = labels[i]));
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

  /** Scroll a box into view, centred, when it is outside the view. */
  async function revealBox(p: number, z: number) {
    const box = items(p)[z]?.box;
    if (!box) return;
    const pg = pages[p];
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
  // With the hand (Scroll) chosen an editor's tap selects nothing, as in the
  // wizard's pieces step, and marks the Draw button for DRAW_HINT_MS; a
  // second tap on the same box within DOUBLE_TAP_MS chooses Draw and
  // selects the box.
  const DRAW_HINT_MS = 1600;
  const DOUBLE_TAP_MS = 350;
  let drawHint = $state(false);
  let drawHintTimer: ReturnType<typeof setTimeout> | undefined;
  // The pending scroll frame and draw hint end with the page.
  $effect(() => () => {
    cancelAnimationFrame(scrollFrame);
    clearTimeout(drawHintTimer);
  });
  let lastTap: { p: number; z: number; t: number } | null = null;
  // The last tap in draw mode on the page outside a box, in page pixels.
  let lastPageTap: { p: number; x: number; y: number; t: number } | null = null;
  const DOUBLE_TAP_PX = 24;
  function leaveDrawMode() {
    drawMode = false;
    corner = null;
    selected = null;
  }
  function tapSelect(p: number, z: number) {
    // The tap that put down a picked-up corner selects nothing.
    if (justPlaced) {
      justPlaced = false;
      return;
    }
    if (!coarse) return;
    if (canEdit && !drawMode) {
      const t = performance.now();
      const double =
        lastTap?.p === p && lastTap.z === z && t - lastTap.t < DOUBLE_TAP_MS;
      lastTap = double ? null : { p, z, t };
      if (double) {
        drawMode = true;
        drawHint = false;
        selected = { p, z };
        corner = null;
        return;
      }
      drawHint = true;
      clearTimeout(drawHintTimer);
      drawHintTimer = setTimeout(() => (drawHint = false), DRAW_HINT_MS);
      return;
    }
    selected = { p, z };
    corner = null;
  }
  /** Select the box before (-1) or after (1) the selected one in reading
      order, across pages; `reveal` scrolls it into view. Keyboard focus on
      a box moves with the selection. */
  async function stepSelection(delta: 1 | -1, reveal = true) {
    if (!pages.length) return;
    let p = selected?.p ?? spreads[rowIndex]?.pages[0] ?? 0;
    let z = selected ? selected.z + delta : delta > 0 ? 0 : -1;
    if (!selected && delta < 0) z = items(p).length - 1;
    while (p >= 0 && p < pages.length && (z < 0 || z >= items(p).length)) {
      p += delta;
      if (p < 0 || p >= pages.length) return;
      z = delta > 0 ? 0 : items(p).length - 1;
    }
    if (p < 0 || p >= pages.length) return;
    const focused = (document.activeElement as Element | null)?.closest(
      ".zone, .staff",
    );
    selected = { p, z };
    if (reveal) revealBox(p, z);
    if (focused) focusBox(p, z);
  }
  /** Focus a page's box once the DOM has caught up. Selecting a box moves
      it to the end of its page's paint order, and the move drops the
      keyboard focus it had. */
  async function focusBox(p: number, z: number) {
    await tick();
    svgEls[p]
      ?.querySelector<SVGElement>(`[data-box="${z}"]`)
      ?.focus({ preventScroll: true });
  }
  // Each page is one tab stop: its selected box, else its first box. A and
  // D move from box to box (stepSelection).
  const tabStop = (p: number, z: number) =>
    z === (selected?.p === p ? selected.z : 0) ? 0 : -1;
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
        pickup: z.pickup,
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
  // in editing. A drag in progress (dragging) defers it to the drag's end,
  // so the score is not serialised on every pointer move.
  $effect(() => {
    if (dragging || !session.canEdit || pages.length === 0) return;
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
        // The model reads the whole page; the piece keeps the boxes in its
        // regions.
        const all = layoutBoxes(layout, pg);
        const inPiece = (box: MeasureBox) => centreInRegions(box, pg.regions);
        const boxes = {
          measures: all.measures.filter(inPiece),
          staves: all.staves.filter(inPiece),
          grandstaves: all.grandstaves.filter(inPiece),
        };
        pages[p].zones = boxes.measures.map((box) => ({
          box,
          override: null,
          label: "",
          sb: false,
          sbOverride: null,
          mdiv: false,
          pickup: false,
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
        message: `Layout detected: ${staves} staves, ${grandstaves} grand staves and ${measures} measures on ${pages.length} page(s).`,
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
  // Each section counts its measures from 1.
  function toggleSection(p: number, z: number) {
    if (!canEdit || sectionLocked(p, z)) return;
    pages[p].zones[z].mdiv = !pages[p].zones[z].mdiv;
    renumber();
    commit();
  }
  function togglePickup(p: number, z: number) {
    if (!canEdit) return;
    pages[p].zones[z].pickup = !pages[p].zones[z].pickup;
    renumber();
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
  // A measure's label is smaller in a narrow or low box: with its inset it
  // takes at most LABEL_FIT_W of the box's width and LABEL_FIT_H of its
  // height, and no less than LABEL_MIN of the full size. The factors are the
  // label's inset, background and double-bar proportions in the markup.
  const LABEL_FIT_W = 0.75;
  const LABEL_FIT_H = 0.35;
  const LABEL_MIN = 0.5;
  const zoneLabelFont = (
    p: number,
    pageW: number,
    box: MeasureBox,
    chars: number,
    bar: boolean,
  ) => {
    const full = labelFont(p, pageW);
    const byW =
      ((box.lrx - box.ulx) * LABEL_FIT_W) /
      (0.6 + chars * 0.62 + 0.9 + (bar ? 0.7 : 0));
    const byH = ((box.lry - box.uly) * LABEL_FIT_H) / (0.6 + 1.55);
    return Math.max(full * LABEL_MIN, Math.min(full, byW, byH));
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
    // A Cmd/Ctrl move drags a copy: the index of the box it copies.
    copyOf: number | null;
  };
  let drag: Drag | null = null;
  // A drag has moved and not yet ended (the draft effect waits for it).
  let dragging = $state(false);
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
  // The free space above and below a staff or grand-staff box, in page
  // pixels, up to the nearest box of its layer beside it; Infinity where
  // there is none. Its handles reach no further, so they never cover a
  // neighbouring box.
  function staffRoom(p: number, z: number) {
    const b = items(p)[z].box;
    let top = Infinity;
    let bottom = Infinity;
    items(p).forEach(({ box: o }, i) => {
      if (i === z || o.lrx <= b.ulx || o.ulx >= b.lrx) return;
      if (o.lry <= b.uly) top = Math.min(top, b.uly - o.lry);
      else if (o.uly >= b.lry) bottom = Math.min(bottom, o.uly - b.lry);
    });
    return { top, bottom };
  }
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
    const copy = kind === "move" && (mac ? e.metaKey : e.ctrlKey);
    const orig = { ...items(p)[z].box };
    const { x, y } = svgXY(e, p);
    drag = {
      kind,
      layer: tool,
      p,
      z: copy ? addBox(p, tool, { ...orig }) : z,
      sx: x,
      sy: y,
      orig,
      moved: false,
      edges,
      started: true,
      deselected: false,
      copyOf: copy ? z : null,
    };
    if (kind === "resize") loupeAt(e, drag, x, y);
  }

  function zoneKeydown(e: KeyboardEvent, p: number, z: number) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      selected = { p, z };
      focusBox(p, z);
      return;
    }
    if (!canEdit || !e.key.startsWith("Arrow")) return;
    e.stopPropagation();
    selected = { p, z };
    nudge(e, p, z);
    // A move can re-sort the page's boxes; focus follows the selection.
    if (selected) focusBox(selected.p, selected.z);
  }

  // Move a box by an arrow key's step.
  function nudge(e: KeyboardEvent, p: number, z: number) {
    e.preventDefault();
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
    // On a touch screen outside draw mode, or with the boxes hidden, the
    // finger scrolls; a tap on the page deselects (backgroundTapEnd).
    if (coarse && (!drawMode || !showBoxes)) {
      bgTap = { x: e.clientX, y: e.clientY };
      return;
    }
    selected = null;
    if (!canEdit || !showBoxes) return;
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
      copyOf: null,
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
        pickup: false,
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

  // While a finger (or any pointer on a touch screen) holds a resize handle
  // or draws a box, a magnifier above it shows the edge or corner under the
  // finger: its page coordinates and the finger's screen point.
  let loupe = $state<{
    p: number;
    x: number;
    y: number;
    cx: number;
    cy: number;
  } | null>(null);
  const LOUPE_PX = 120;
  const LOUPE_ZOOM = 2;
  const loupeAt = (e: PointerEvent, d: Drag, x: number, y: number) => {
    if (e.pointerType === "mouse" && !coarse) return;
    // A resize centres on the box's dragged edge or corner, which can sit a
    // few pixels from the finger when the press starts.
    if (d.kind === "resize") {
      const b = items(d.p, d.layer)[d.z].box;
      if (d.edges.includes("w")) x = b.ulx;
      else if (d.edges.includes("e")) x = b.lrx;
      if (d.edges.includes("n")) y = b.uly;
      else if (d.edges.includes("s")) y = b.lry;
    }
    loupe = { p: d.p, x, y, cx: e.clientX, cy: e.clientY };
  };

  function pointerMove(e: PointerEvent) {
    if (!drag) return;
    const { x, y } = svgXY(e, drag.p);
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
    if (!dragging) dragging = true;
    const box = items(drag.p, drag.layer)[drag.z].box;
    Object.assign(
      box,
      drag.kind === "move"
        ? movedBox(drag.orig, dx, dy, pg)
        : drag.kind === "draw"
          ? drawnBox(drag.sx, drag.sy, x, y, MIN_BOX)
          : resizedBox(drag.orig, drag.edges, x, y, MIN_BOX),
    );
    if (drag.kind !== "move") loupeAt(e, drag, x, y);
  }

  // A second finger turns the gesture into a pinch: the drag the first one
  // started is undone.
  function cancelDrag() {
    loupe = null;
    dragging = false;
    if (!drag) return;
    const { kind, layer, p, z, started, orig, copyOf } = drag;
    drag = null;
    if (!started) return;
    if (copyOf !== null) {
      items(p, layer).splice(z, 1);
      selected = { p, z: copyOf };
    } else if (kind === "draw") {
      items(p, layer).splice(z, 1);
      selected = null;
    } else Object.assign(items(p, layer)[z].box, orig);
  }

  function pointerUp() {
    loupe = null;
    dragging = false;
    if (!drag) return;
    const {
      kind,
      layer,
      p,
      z,
      moved,
      started,
      deselected,
      sx,
      sy,
      copyOf,
      edges,
    } = drag;
    drag = null;
    // A corner or edge pressed and released without moving is picked up
    // (armed); pressed again it is put down.
    if (kind === "resize" && !moved) {
      armed =
        armed?.p === p && armed.z === z && armed.edges === edges
          ? null
          : { p, z, edges };
      return;
    }
    // A Cmd/Ctrl click that never moved leaves no copy behind.
    if (copyOf !== null && !moved) {
      items(p, layer).splice(z, 1);
      selected = { p, z: copyOf };
      return;
    }
    // A draw that never crossed the threshold was a plain click. On a touch
    // screen a second tap on the page within DOUBLE_TAP_MS and
    // DOUBLE_TAP_PX of the first ends draw mode.
    if (!started) {
      if (kind === "draw" && coarse) {
        const t = performance.now();
        const k = (canvasW[p] || pages[p].width) / pages[p].width;
        if (
          lastPageTap?.p === p &&
          t - lastPageTap.t < DOUBLE_TAP_MS &&
          Math.hypot(sx - lastPageTap.x, sy - lastPageTap.y) * k < DOUBLE_TAP_PX
        ) {
          lastPageTap = null;
          leaveDrawMode();
          return;
        }
        lastPageTap = { p, x: sx, y: sy, t };
      }
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

  // Resizing without dragging: a picked-up corner or edge (armed) goes to
  // the next press on its page, which does nothing else. A new selection, a
  // step change or Esc puts it down.
  let armed = $state<{ p: number; z: number; edges: string } | null>(null);
  let justPlaced = false;
  const selKey = $derived(selected ? `${selected.p}-${selected.z}` : "");
  $effect(() => {
    void selKey;
    void tool;
    untrack(() => (armed = null));
  });
  function placeArmed(e: PointerEvent, p: number) {
    const a = armed;
    if (!a) return;
    armed = null;
    if (a.p !== p || !items(p)[a.z]) return;
    e.stopPropagation();
    e.preventDefault();
    justPlaced = true;
    const { x, y } = svgXY(e, p);
    const box = items(p)[a.z].box;
    Object.assign(box, resizedBox({ ...box }, a.edges, x, y, MIN_BOX));
    commitGeometry(p, a.z);
  }

  // A new box of the active layer without drawing it: the selected box's
  // size beside it (a staff below it, a measure to its right), or without a
  // selection a box in the middle of the first page in view. It is selected
  // and keeps the keyboard focus, for the arrow keys and handles to adjust.
  function newBox() {
    if (!canEdit || !pages.length) return;
    const p = selectedItem?.p ?? spreads[rowIndex]?.pages[0] ?? 0;
    const pg = pages[p];
    let box: MeasureBox;
    if (selectedItem) {
      const b = items(p)[selectedItem.z].box;
      box =
        tool === "measures"
          ? movedBox(b, b.lrx - b.ulx, 0, pg)
          : movedBox(b, 0, (b.lry - b.uly) * 1.5, pg);
    } else {
      // Centred in the page's shown part, no taller than it.
      const v = shownArea(pg);
      const w = (v.lrx - v.ulx) * (tool === "measures" ? 0.1 : 0.8);
      const h = Math.min(
        v.lry - v.uly,
        pg.height * (tool === "measures" ? 0.15 : 0.03),
      );
      box = {
        ulx: (v.ulx + v.lrx - w) / 2,
        uly: (v.uly + v.lry - h) / 2,
        lrx: (v.ulx + v.lrx + w) / 2,
        lry: (v.uly + v.lry + h) / 2,
      };
    }
    const hadFocus = !!document.activeElement?.closest(".zone, .staff");
    commitGeometry(p, addBox(p, tool, box));
    if (hadFocus && selected) focusBox(selected.p, selected.z);
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

  // The page's keys. Text fields keep their own keys; undo, redo and Esc
  // work from any other control; the editing keys (A, D, N, Delete, the
  // arrows) only on the pages or with nothing focused, so a key on a panel
  // control never moves a box or turns a page.
  function keydown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable]")) return;
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
    if (
      e.key === "Escape" &&
      (armed || corner || helpOpen || viewOpen || selected)
    ) {
      if (armed) armed = null;
      else if (corner) corner = null;
      else if (helpOpen) helpOpen = false;
      else if (viewOpen) viewOpen = false;
      else selected = null;
      return;
    }
    if (target !== document.body && !target.closest(".desk")) return;
    if ((e.key === "Delete" || e.key === "Backspace") && selected) {
      e.preventDefault();
      deleteSelected();
    } else if (
      (e.key === "a" || e.key === "A" || e.key === "d" || e.key === "D") &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      // The keys leave the view where it is.
      stepSelection(e.key === "a" || e.key === "A" ? -1 : 1, false);
    } else if (
      (e.key === "n" || e.key === "N") &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      newBox();
    } else if (e.key.startsWith("Arrow") && canEdit && selectedItem) {
      // A selected box takes the arrow keys; without one, ← → turn pages.
      nudge(e, selectedItem.p, selectedItem.z);
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
  // Hidden, the layer's boxes are not drawn, cannot be selected and no new
  // box is drawn; a finger on the page scrolls it.
  let showBoxes = $state(true);
  function toggleBoxes() {
    showBoxes = !showBoxes;
    selected = null;
    corner = null;
    armed = null;
  }

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

  // Hover tooltip naming a measure's breaks and pickup flag, if it has any.
  // On the page a section start shows as a double bar in the label and a
  // system start as the blue left edge.
  const zoneTitle = (p: number, z: number) =>
    [
      startsMovement(p, z) ? "Starts a section" : "",
      pages[p].zones[z].pickup ? "Pickup" : "",
      pbAt(z)
        ? "First measure on the page: starts a system"
        : pages[p].zones[z].sb
          ? "Starts a system"
          : "",
    ]
      .filter(Boolean)
      .join(" · ");

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
  // A help line is text with colour words, each set in the colour it names.
  type HelpPart = string | { text: string; tone: string };
  const helpLines = $derived<HelpPart[][]>([
    ...(canEdit && coarse
      ? [
          [
            `In draw mode (the square) tap a box to select it, then drag it or its edges and corners, or drag on the page to draw a ${boxName}. In scroll mode (the hand) a finger drag scrolls the pages, and a double tap on a box selects it and switches to draw mode; a double tap on the page outside a box switches back to scroll mode. Pinch to zoom.`,
          ],
          [
            "To resize without dragging, tap a corner dot of the selected box, then tap where the corner should go.",
          ],
        ]
      : canEdit
        ? [
            [
              `Drag on the page to draw a ${boxName}. Or click one corner, which leaves a cross, then the opposite corner. Drag a box to move it; its edges and corners resize it, or click a corner and then where it should go. ${MOD}drag a box to copy it.`,
            ],
            [
              `Arrow keys move the selected box (${SHIFT}arrow moves 5 times as far). Esc removes the cross, then deselects the box.`,
            ],
          ]
        : []),
    ...(coarse
      ? []
      : [
          [
            `${canEdit ? `${MOD}Z undo · ${MOD}${SHIFT}Z redo · ${mac ? "⌫" : "Delete"} removes the selected box · N adds a box beside it · ` : ""}Tab reaches a page's boxes, A D the previous and next box · ← → change pages${canEdit ? " when no box is selected" : ""} · ${MOD}scroll or a pinch zooms`,
          ],
        ]),
    [
      ...(omr
        ? [
            { text: "Wine red", tone: "staff" },
            ": staff · ",
            { text: "dark green", tone: "grand" },
            ": grand staff (the staves a brace joins) · ",
          ]
        : []),
      { text: "teal", tone: "measure" },
      ": measure · ",
      { text: "thick purple", tone: "movement" },
      ": section start · ",
      { text: "blue left edge", tone: "system" },
      ": system start",
    ],
    [
      "Measure labels: the measure number, after a double bar where the measure starts a section.",
    ],
  ]);
  let helpOpen = $state(false);
  // The View options behind the toolbar's ⋯ button: the page-count switch
  // below MEDIUM_TOOL, and on a phone sheet (inSheet) the overlap colouring
  // and the help.
  const viewMenu = $derived(inSheet || (medium && !narrow));
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

<svelte:window
  onpointerdown={closeViewOutside}
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
    <div class="main">
      <div
        class="tbar"
        class:bare={inSheet}
        bind:clientWidth={toolW}
        style={`--desk-h:${deskH}px`}
      >
        {#if !inSheet}
          <div class="ctoolbar">{@render toolbarItems()}</div>
        {/if}
        {#if helpOpen}
          <div
            id="zone-help"
            class="helppanel"
            role="region"
            aria-label="Editor help"
          >
            <ul>
              {#each helpLines as line, i (i)}
                <li>
                  {#each line as part, j (j)}{#if typeof part === "string"}{part}{:else}<b
                        class="tone-{part.tone}">{part.text}</b
                      >{/if}{/each}
                </li>
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
        {#if viewOpen && viewMenu}
          <div
            id="zone-view"
            class="viewmenu"
            role="group"
            aria-label={inSheet ? "View options and help" : "View options"}
          >
            {#if !narrow}{@render viewOptions()}{/if}
            {#if inSheet}
              {@render overlapSwitch()}
              <button
                type="button"
                class="btn"
                aria-controls="zone-help"
                onclick={() => {
                  helpOpen = true;
                  viewOpen = false;
                }}><Icon name="help" size={16} /> Help</button
              >
            {/if}
          </div>
        {/if}
      </div>
      <TaskRunState task={taskId} bar />

      <div
        class="desk"
        bind:this={desk}
        bind:clientWidth={deskW}
        bind:clientHeight={deskH}
        onscroll={deskScrollEvent}
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
                <!-- Cropped to the piece's part of the page, the frame shows
                     that part of the full-size canvas, shifted by its
                     offset; percentage margins are of the frame's width. -->
                {@const v = shownArea(pg)}
                {@const vw = v.lrx - v.ulx}
                <div class="page">
                  <p class="page-label pagehead">Page {p + 1} · Facsimile</p>
                  {#if pg.failed}
                    <div class="banner err">
                      The page facsimile for page {p + 1} could not be loaded. The
                      zones are shown without their reference image.
                    </div>
                  {/if}
                  <div
                    class="frame"
                    class:cropped={!isWhole(v, pg)}
                    style:aspect-ratio={isWhole(v, pg)
                      ? undefined
                      : `${vw} / ${v.lry - v.uly}`}
                  >
                    <div
                      class="canvas"
                      bind:clientWidth={canvasW[p]}
                      style:width={isWhole(v, pg)
                        ? undefined
                        : `${(pg.width / vw) * 100}%`}
                      style:margin-left={isWhole(v, pg)
                        ? undefined
                        : `${(-v.ulx / vw) * 100}%`}
                      style:margin-top={isWhole(v, pg)
                        ? undefined
                        : `${(-v.uly / vw) * 100}%`}
                    >
                      <svg
                        bind:this={svgEls[p]}
                        viewBox={`0 0 ${pg.width} ${pg.height}`}
                        class:staves={tool === "staves"}
                        class:grandstaves={tool === "grandstaves"}
                        class:pan={coarse && (!drawMode || !showBoxes)}
                        role="application"
                        aria-label={`Page ${p + 1}, ${tool === "staves" ? "staff boxes" : tool === "grandstaves" ? "grand staves" : "measures"}`}
                        onpointerdowncapture={(e) => placeArmed(e, p)}
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
                          {#each showBoxes && tool !== "measures" ? staffPaintOrder(pg, p) : [] as { staff, s } (`${tool}-${s}`)}
                            <rect
                              class="staff"
                              class:grand={tool === "grandstaves"}
                              class:selected={selected?.p === p &&
                                selected?.z === s}
                              vector-effect="non-scaling-stroke"
                              role="button"
                              tabindex={tabStop(p, s)}
                              data-box={s}
                              aria-current={selected?.p === p &&
                              selected?.z === s
                                ? "true"
                                : undefined}
                              aria-label={`${tool === "grandstaves" ? "Grand staff" : "Staff"} ${s + 1}, page ${p + 1}${canEdit ? ": select, drag or resize" : ""}`}
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
                          {#each showBoxes && tool === "measures" ? paintOrder(pg, p) : [] as { zone, z } (z)}
                            <rect
                              class="zone"
                              class:selected={selected?.p === p &&
                                selected?.z === z}
                              class:mdivstart={startsMovement(p, z)}
                              vector-effect="non-scaling-stroke"
                              role="button"
                              tabindex={tabStop(p, z)}
                              data-box={z}
                              aria-current={selected?.p === p &&
                              selected?.z === z
                                ? "true"
                                : undefined}
                              aria-label={`Measure ${zone.override ?? zone.label}, page ${p + 1}${sbActive(p, z) ? ", starts a system" : ""}${startsMovement(p, z) ? ", starts a section" : ""}${zone.pickup ? ", pickup" : ""}${canEdit ? ": select, drag, or edit its number and breaks" : ""}`}
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
                            {#if sbActive(p, z)}
                              <line
                                class="sysstart"
                                vector-effect="non-scaling-stroke"
                                x1={zone.box.ulx}
                                y1={zone.box.uly}
                                x2={zone.box.ulx}
                                y2={zone.box.lry}
                              />
                            {/if}
                            {@const lbl = zone.label}
                            {@const fs = zoneLabelFont(
                              p,
                              pg.width,
                              zone.box,
                              lbl.length,
                              startsMovement(p, z),
                            )}
                            {@const inset = fs * 0.6}
                            <!-- A section start puts a double bar before the number. -->
                            {@const bar = startsMovement(p, z) ? fs * 0.7 : 0}
                            {@const lblW =
                              lbl.length * fs * 0.62 + fs * 0.9 + bar}
                            {@const on = selected?.p === p && selected?.z === z}
                            <!-- The label repeats the box's name for the eye. -->
                            <rect
                              aria-hidden="true"
                              class="labelbg"
                              class:on
                              x={zone.box.ulx + inset}
                              y={zone.box.uly + inset}
                              width={lblW}
                              height={fs * 1.55}
                              rx={fs * 0.28}
                            />
                            {#if bar}
                              {@const bx = zone.box.ulx + inset + fs * 0.45}
                              {@const by = zone.box.uly + inset + fs * 0.3}
                              <rect
                                aria-hidden="true"
                                class="dbar"
                                class:on
                                x={bx}
                                y={by}
                                width={fs * 0.1}
                                height={fs * 0.95}
                              />
                              <rect
                                aria-hidden="true"
                                class="dbar"
                                class:on
                                x={bx + fs * 0.24}
                                y={by}
                                width={fs * 0.22}
                                height={fs * 0.95}
                              />
                            {/if}
                            <text
                              aria-hidden="true"
                              class="zonelabel"
                              class:on
                              x={zone.box.ulx + inset + bar + (lblW - bar) / 2}
                              y={zone.box.uly + inset + fs * 1.12}
                              text-anchor="middle"
                              font-size={fs}>{lbl}</text
                            >
                          {/each}
                          {#each showBoxes && showOverlaps ? overlaps(pg) : [] as o, i (i)}
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

                      {#if canEdit && showBoxes && selectedItem?.p === p}
                        {@render handles(p, selectedItem.z)}
                      {/if}
                    </div>
                  </div>
                </div>
              {/each}
              {#if sp.lonelySide === "left"}<div class="page-spacer"></div>{/if}
            </div>
          {/each}
        </div>
      </div>
      <!-- On a touch screen what a finger does and the box visibility float
           over the pages' bottom right corner, on an anchor that takes no
           height (as DraftBubble's). -->
      {#if coarse}
        <div class="deskctl">
          <div class="deskctl-group">
            {#if canEdit}{@render modePair()}{/if}
            {@render boxesButton()}
            {@render wholePageButton()}
          </div>
        </div>
      {/if}
      <DraftBubble {session} />
    </div>

    <!-- The page toolbar's controls: above or below the pages, or at the
         top of the side panel docked as a sheet on a phone (inSheet). -->
    <!-- How many pages a row shows: in the toolbar, or in the ⋯ menu below
         MEDIUM_TOOL. -->
    {#snippet viewOptions()}
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
    {/snippet}

    {#snippet toolbarItems()}
      {#if !medium}{@render viewOptions()}{/if}
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
          class="tbtn tbtn-icon zoomstep zoomin"
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
          class="tbtn tbtn-icon fitwidth"
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
      {#if !coarse}{@render boxesButton()}{@render wholePageButton()}{/if}
      {#if canEdit}
        <button
          type="button"
          class="btn btn-icon"
          onclick={() => undo()}
          disabled={!canUndo}
          aria-label="Undo"
          title="Undo the last change (Ctrl/Cmd+Z)"><Icon name="undo" /></button
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
        class:hidden={inSheet}
        class:on={helpOpen}
        aria-label="Editor help"
        aria-expanded={helpOpen}
        aria-controls="zone-help"
        onclick={() => {
          helpOpen = !helpOpen;
          viewOpen = false;
        }}><Icon name="help" size={18} /></button
      >
      {#if viewMenu}
        <button
          type="button"
          class="btn btn-icon viewbtn"
          class:on={viewOpen}
          aria-label={inSheet ? "View options and help" : "View options"}
          aria-expanded={viewOpen}
          aria-controls="zone-view"
          onclick={() => {
            viewOpen = !viewOpen;
            helpOpen = false;
          }}><Icon name="more" size={18} /></button
        >
      {/if}
      <span class="vh" role="status"
        >{armed
          ? `The ${HANDLES.find((h) => h.edges === armed?.edges)?.side} is picked up. ${coarse ? "Tap" : "Click"} where it should go.`
          : corner
            ? `First corner set on page ${corner.p + 1}. Click the opposite corner to draw the ${boxName}.`
            : drawHint
              ? `Choose Draw, or tap the ${boxName} twice, to select it.`
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
        <!-- A phone or tablet row has room for the numbers only ("1–2 of 4"). -->
        <span
          class="pglabel"
          style={`min-width:${pagesLabelCh(pages.length) - (medium ? "Pages ".length : 0)}ch`}
          title={medium ? spreadLabel : undefined}
          >{medium ? spreadLabel.replace(/^Pages? /, "") : spreadLabel}</span
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
    {/snippet}

    {#snippet sheetBar()}
      <div class="ctoolbar insheet">{@render toolbarItems()}</div>
    {/snippet}
    <!-- The selected box's body and its resize handles, over the page in
         screen pixels: a body that drags the box, round corner dots, and
         edge handles without a mark of their own, at touch size on a touch
         screen. Their percentages place them on the box at any zoom; --w
         and --h, the box's size on screen, keep the handles' reach into the
         box to a quarter of it. -->
    {#snippet handles(p: number, z: number)}
      {@const pg = pages[p]}
      {@const b = items(p)[z].box}
      {@const name = itemName(p, z)}
      {@const k = (canvasW[p] || pg.width) / pg.width}
      {@const sw = (b.lrx - b.ulx) * k}
      {@const sh = (b.lry - b.uly) * k}
      {@const room =
        tool === "measures"
          ? { top: Infinity, bottom: Infinity }
          : staffRoom(p, z)}
      <div
        class="sel"
        class:touch={coarse}
        class:staves={tool === "staves"}
        class:grandstaves={tool === "grandstaves"}
        style:left={`${(b.ulx / pg.width) * 100}%`}
        style:top={`${(b.uly / pg.height) * 100}%`}
        style:width={`${((b.lrx - b.ulx) / pg.width) * 100}%`}
        style:height={`${((b.lry - b.uly) / pg.height) * 100}%`}
        style:--w={`${sw}px`}
        style:--h={`${sh}px`}
        style:--room-t={Number.isFinite(room.top)
          ? `${room.top * k}px`
          : undefined}
        style:--room-b={Number.isFinite(room.bottom)
          ? `${room.bottom * k}px`
          : undefined}
      >
        <div
          class="selbody"
          aria-hidden="true"
          onpointerdown={(ev) => startZoneDrag(ev, p, z, "move")}
        ></div>
        {#each HANDLES as h (h.edges)}
          <div
            class="hd hd-{h.edges} {resizeCursor(h.edges)}"
            class:armed={armed?.p === p &&
              armed.z === z &&
              armed.edges === h.edges}
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
         piece) or the counts, and the overlap colouring. -->
    {#snippet tools()}
      <div class="wtools">
        {#if omr}
          <div
            class="steplist"
            role="group"
            aria-label="Steps"
            title="The three steps of the measure correction. Each step shows only its own boxes."
          >
            {#each [{ step: 1, swatch: "staff", long: "Staff boxes", short: "Staves", count: `${staffCount}`, n: staffCount }, { step: 2, swatch: "grand", long: "Grand staves", short: "Grand", count: `${grandstaffCount}`, n: grandstaffCount }, { step: 3, swatch: "measure", long: "Measures", short: "Measures", count: `${measureCount} · ${movementCount} section${movementCount === 1 ? "" : "s"}`, n: measureCount }] as s (s.step)}
              <button
                type="button"
                class:on={layoutStep === s.step}
                aria-pressed={layoutStep === s.step}
                onclick={() => setLayoutStep(s.step as 1 | 2 | 3)}
                aria-label={`${s.step} · ${s.long}, ${s.count}`}
                ><span class="swatch {s.swatch}" aria-hidden="true"></span><span
                  class="steplong">{s.step} · {s.long}</span
                ><span class="stepshort">{s.short}</span><span class="stepn"
                  >{s.n}</span
                ><span class="stepcount">{s.count}</span></button
              >
            {/each}
          </div>
        {:else}
          <span class="abcount"
            >{measureCount} measure{measureCount === 1 ? "" : "s"} · {movementCount}
            section{movementCount === 1 ? "" : "s"}</span
          >
        {/if}
        {#if !inSheet}
          <div class="toolrow">{@render overlapSwitch()}</div>
        {/if}
      </div>
    {/snippet}

    <!-- What a finger does on the pages, as in the wizard's pieces step: the
         hand scrolls and deselects, the square draws and selects. -->
    {#snippet modePair()}
      <span class="tbtn-pair" role="group" aria-label="What a finger does">
        <button
          type="button"
          class="tbtn tbtn-icon"
          class:on={!drawMode}
          aria-pressed={!drawMode}
          aria-label="Scroll"
          title="A finger drag scrolls the pages"
          onclick={leaveDrawMode}
          ><Icon name="hand" size={16} /><span class="mode-label">Scroll</span
          ></button
        >
        <button
          type="button"
          class="tbtn tbtn-icon"
          class:on={drawMode}
          class:drawhint={drawHint && !drawMode}
          aria-pressed={drawMode}
          aria-label={`Draw a ${boxName}`}
          title={`A finger drag draws a new ${boxName}`}
          onclick={() => (drawMode = true)}
          ><Icon name="square" size={16} /><span class="mode-label">Draw</span
          ></button
        >
      </span>
    {/snippet}

    {#snippet boxesButton()}
      <button
        type="button"
        class="tbtn tbtn-icon"
        class:on={!showBoxes}
        aria-pressed={!showBoxes}
        aria-label="Hide the boxes"
        title="Hide the boxes to see the page underneath"
        onclick={toggleBoxes}><Icon name="eye-off" size={16} /></button
      >
    {/snippet}

    <!-- Shown where the piece covers only part of a page. -->
    {#snippet wholePageButton()}
      {#if hasPartPages}
        <button
          type="button"
          class="tbtn tbtn-icon"
          class:on={wholePage}
          aria-pressed={wholePage}
          aria-label="Show the whole page"
          title="Show the whole page, not only the part this piece covers"
          onclick={() => (wholePage = !wholePage)}
          ><Icon name="facsimile" size={16} /></button
        >
      {/if}
    {/snippet}

    {#snippet overlapSwitch()}
      <button
        type="button"
        class="chip-switch"
        class:on={showOverlaps}
        aria-pressed={showOverlaps}
        onclick={() => (showOverlaps = !showOverlaps)}
        title="Show or hide the colour on areas where two boxes overlap"
        ><span class="sw"></span>Show overlaps</button
      >
    {/snippet}

    <!-- A measure's number field: typing overrides the automatic number. -->
    {#snippet numberInput(p: number, z: number)}
      {@const zone = pages[p].zones[z]}
      <input
        value={zone.override ?? zone.label}
        oninput={(e) => setLabel(p, z, (e.target as HTMLInputElement).value)}
        onchange={() => commit()}
        title="Type to override the automatic number, e.g. 10a. The following measures count on from it."
      />
    {/snippet}

    <!-- The selected box's controls in three rows: its name (for a measure
         with the number field), previous and next box with the page, and
         new, delete and comment. An editable measure's switches stand in a
         second column, one beside each row. -->
    {#snippet selection()}
      {#if selectedItem}
        {@const { p, z } = selectedItem}
        {@const switches = tool === "measures" && canEdit}
        <div class="selpanel" class:selgrid={switches}>
          <div class="selmain">
            <div class="selhead">
              <span
                class="swatch {tool === 'staves'
                  ? 'staff'
                  : tool === 'grandstaves'
                    ? 'grand'
                    : 'measure'}"
                aria-hidden="true"
              ></span>
              {#if switches}
                <label class="selname selnum"
                  >Measure {@render numberInput(p, z)}</label
                >
              {:else}
                <span class="selname">{itemName(p, z)}</span>
              {/if}
            </div>
            <div class="selnav">
              <button
                type="button"
                class="btn btn-icon"
                onclick={() => stepSelection(-1)}
                disabled={!hasPrev}
                aria-label={`Previous ${boxName}`}
                title={`Previous ${boxName} (A)`}
                ><Icon name="chevron-left" /></button
              >
              <button
                type="button"
                class="btn btn-icon"
                onclick={() => stepSelection(1)}
                disabled={!hasNext}
                aria-label={`Next ${boxName}`}
                title={`Next ${boxName} (D)`}
                ><Icon name="chevron-right" /></button
              >
              <span class="selwhere">page {p + 1}</span>
            </div>
            {#if canEdit || (selectedLabel && auth.user) || coarse}
              <div class="selactions">
                {#if canEdit}
                  <button
                    type="button"
                    class="btn btn-icon"
                    onclick={newBox}
                    aria-label={`New ${boxName} beside this one`}
                    title={`New ${boxName} beside this one (N)`}
                    ><Icon name="plus" /></button
                  >
                  <button
                    type="button"
                    class="btn btn-icon btn-danger"
                    onclick={() => deleteZone(p, z)}
                    aria-label={`Delete the ${boxName}`}
                    title={`Delete the ${boxName}`}
                    ><Icon name="trash" /></button
                  >
                {/if}
                {#if selectedLabel && auth.user}
                  <button
                    type="button"
                    class="btn btn-icon"
                    onclick={() => compose++}
                    aria-label={`Comment on measure ${selectedLabel}`}
                    title={`Comment on measure ${selectedLabel}`}
                    ><Icon name="comment" /></button
                  >
                {/if}
                {#if coarse && !(docked && canEdit)}
                  <button
                    type="button"
                    class="btn btn-icon"
                    onclick={() => (selected = null)}
                    aria-label={`Deselect the ${boxName}`}
                    title={`Deselect the ${boxName}`}
                    ><Icon name="close" /></button
                  >
                {/if}
              </div>
            {/if}
          </div>
          {#if switches}
            <div class="selflags">
              <button
                type="button"
                class="chip-switch"
                class:on={sbActive(p, z)}
                aria-pressed={sbActive(p, z)}
                onclick={() => toggleSb(p, z)}
                disabled={pbAt(z)}
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
                disabled={sectionLocked(p, z)}
                title={sectionLocked(p, z)
                  ? "The first measure always starts the first section"
                  : "This measure starts a new movement or section"}
                ><span class="sw"></span>Starts a section</button
              >
              <button
                type="button"
                class="chip-switch"
                class:on={pages[p].zones[z].pickup}
                aria-pressed={pages[p].zones[z].pickup}
                onclick={() => togglePickup(p, z)}
                title="An incomplete measure that is not counted: numbered 0 at the start of a section, otherwise it and the measure before it are numbered as halves, e.g. 12a and 12b"
                ><span class="sw"></span>Pickup</button
              >
            </div>
          {:else if tool === "measures"}
            <!-- Read-only, the switches give way to the breaks that apply. -->
            {@const flags = [
              sbActive(p, z) ? "Starts a system" : "",
              startsMovement(p, z) ? "Starts a section" : "",
              pages[p].zones[z].pickup ? "Pickup" : "",
            ].filter(Boolean)}
            {#if flags.length}
              <p class="selflagtext">{flags.join(" · ")}</p>
            {/if}
          {/if}
        </div>
      {:else}
        <p class="selnone">
          {#if coarse && canEdit && !drawMode}
            Tap a box twice, or choose Draw, to edit it.
          {:else}
            {coarse ? "Tap" : "Click"} a box on the page to {canEdit
              ? "edit it"
              : "select it"}.
          {/if}
        </p>
      {/if}
    {/snippet}

    <!-- The task's action at the panel's bottom: the claim or the draft
         state and give back, then the next step or the submission. -->
    {#snippet footer()}
      <div class="wfoot">
        <!-- Why Submit is not available yet, while it is the step's button. -->
        {#if submitBlock && canEdit && !(omr && layoutStep < 3)}
          <p class="blockline">{submitBlock}</p>
        {/if}
        <PreTaskStatus {session} />
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
                ? "Submit the corrected staves, grand staves, measures, breaks and sections for review"
                : "Submit the corrected measures, breaks and sections for review")}
          >
            Submit corrections
          </button>
        {/if}
      </div>
    {/snippet}

    <!-- The last command's result, in the task box. -->
    {#snippet resultNote()}
      <RunnerBanner {runner} bar collapsible />
    {/snippet}

    {#snippet taskBox(headAction: Snippet | undefined)}
      {#if session.card}
        <PreTaskBox
          {session}
          {campaign}
          card={session.card}
          tools={resultNote}
          {headAction}
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
        minWidth={PANEL_MIN_TOOLS}
        {taskBox}
        {tools}
        {selection}
        selectionLabel="Selection"
        selectionActive={!!selectedItem}
        bind:tab={panelTab}
        {compose}
        footer={data.status === "encoding_required" ? footer : undefined}
        bar={inSheet ? sheetBar : undefined}
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
          <!-- Only the boxes inside the magnified square. -->
          {#each items(loupe.p).filter((it) => it.box.lrx > loupe!.x - span / 2 && it.box.ulx < loupe!.x + span / 2 && it.box.lry > loupe!.y - span / 2 && it.box.uly < loupe!.y + span / 2) as it, i (i)}
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
    color: var(--ink-soft);
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
    margin: 12px 16px 4px 0;
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
  /* A step's name and count each keep to one line. */
  .steplong {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .stepshort,
  .stepn {
    display: none;
  }
  /* The Draw button after a tap on a box while Scroll is chosen: its fill
     blinks twice in the accent tint; its border stays, so it does not merge
     with the chosen Scroll button's. */
  .tbtn-pair > .tbtn.drawhint {
    color: var(--accent);
    background: var(--accent-tint-strong);
    animation: drawhint 0.4s ease-out 4 alternate;
  }
  @keyframes drawhint {
    from {
      background: var(--card);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tbtn-pair > .tbtn.drawhint {
      animation: none;
    }
  }
  /* The Scroll / Draw pair's names, beside their icons where there is room. */
  .mode-label {
    margin-left: 5px;
    font: 600 12px var(--font);
    line-height: 1;
  }
  .deskctl {
    flex: none;
    position: relative;
    height: 0;
    z-index: 6;
  }
  .deskctl-group {
    position: absolute;
    right: 12px;
    bottom: 12px;
    display: flex;
    gap: 8px;
  }
  .deskctl-group > * {
    border-radius: 8px;
    box-shadow: var(--shadow-sm);
  }
  /* The buttons stay 32px to the eye but take a 44px press. */
  .deskctl-group .tbtn {
    position: relative;
    box-sizing: border-box;
    min-width: 32px;
    min-height: 32px;
    justify-content: center;
  }
  .deskctl-group .tbtn::after {
    content: "";
    position: absolute;
    inset: -6px;
  }
  .deskctl-group .tbtn-pair > .tbtn::after {
    inset: -6px 0;
  }
  .stepcount {
    color: var(--ink-faint);
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .steplist > button.on .stepcount {
    color: var(--ink-soft);
  }
  @media (orientation: portrait) and (max-width: 860px) {
    .steplist {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 2px;
      padding: 2px;
      background: var(--card);
      box-shadow: inset 0 0 0 1px var(--line);
      border-radius: 999px;
    }
    .steplist > button {
      position: relative;
      justify-content: center;
      min-height: 28px;
      padding: 0 6px;
      font-size: 12px;
      font-weight: 600;
      color: var(--ink-soft);
      background: transparent;
      border: 0;
      border-radius: 999px;
    }
    .steplist > button::after {
      content: "";
      position: absolute;
      inset: -8px 0;
    }
    .steplist > button.on {
      color: var(--ink);
      background: var(--accent-tint-strong);
      border: 0;
    }
    .steplong,
    .stepcount {
      display: none;
    }
    /* On a phone the cells keep the name and count and drop the swatch. */
    @media (max-width: 420px) {
      .steplist .swatch {
        display: none;
      }
    }
    /* In a sheet a step shows its short name and its box count. */
    .stepshort,
    .stepn {
      display: inline;
    }
    .stepn {
      font-weight: 400;
      color: var(--ink-soft);
      font-variant-numeric: tabular-nums;
    }
    /* The steps and the Scroll / Draw pair share one row; the pair shows
       its icons only. */
    .wtools {
      flex-direction: row;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .steplist {
      flex: 1 1 200px;
    }
    .toolrow {
      flex-wrap: nowrap;
    }
    .mode-label {
      display: none;
    }
    .tbtn-pair > .tbtn {
      min-height: 32px;
    }
    .toolrow .chip-switch,
    .viewmenu .chip-switch,
    .viewmenu .btn {
      position: relative;
      min-height: 32px;
    }
    .toolrow .chip-switch::after,
    .viewmenu .chip-switch::after,
    .viewmenu .btn::after {
      content: "";
      position: absolute;
      inset: -6px;
    }
    .tbtn-pair > .tbtn::after {
      content: "";
      position: absolute;
      inset: -6px 0;
    }
  }
  /* The selection card's rows are 32px apart by 8px. An editable measure's
     switches stand in a column beside the rows, one beside each, and wrap
     below them where the card is too narrow for both. */
  .selmain,
  .selflags {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .selgrid {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px 16px;
  }
  .selnav,
  .selactions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .selnav .selwhere {
    margin-left: 4px;
  }
  .selflagtext {
    margin: 0;
    font-size: 12.5px;
    color: var(--ink-soft);
  }
  .selflags {
    align-items: stretch;
  }
  .selflags .chip-switch {
    min-height: 32px;
  }
  .selnum {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .selnum input {
    width: 64px;
    min-height: 32px;
    padding: 4px 8px;
    box-sizing: border-box;
    font:
      400 14px ui-monospace,
      monospace;
    color: var(--ink);
    background: var(--card);
    border: 1px solid var(--line-input);
    border-radius: 8px;
  }
  .selflags .chip-switch:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* In a docked sheet the buttons and switches take a 44px press through an
     invisible ::after. */
  @media (orientation: portrait) and (max-width: 860px) {
    .selnav .btn-icon,
    .selflags .chip-switch {
      position: relative;
    }
    .selnav .btn-icon::after,
    .selflags .chip-switch::after {
      content: "";
      position: absolute;
      inset: -6px;
    }
  }
  /* Give back and the step's button at the two ends of one row; the draft
     state shows over the pages (DraftBubble). */
  .wfoot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .wfoot > .btn {
    margin-left: auto;
  }
  .blockline {
    flex-basis: 100%;
    margin: 0;
    font-size: 12px;
    line-height: 1.4;
    color: var(--ink-soft);
  }
  .wfoot :global(.btn) {
    white-space: nowrap;
  }
  /* Docked as a sheet the buttons take a 44px press. */
  @media (orientation: portrait) and (max-width: 860px) {
    .wfoot :global(.btn) {
      position: relative;
    }
    .wfoot :global(.btn)::after {
      content: "";
      position: absolute;
      inset: -6px;
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
  /* The editor help, opened from the toolbar, over the top of the pages, so
     the desk keeps its size and its fit. */
  .helppanel {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 5;
    max-height: calc(var(--desk-h) - 16px);
    box-sizing: border-box;
    overflow: auto;
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
  /* The layers' hues, as "r, g, b" for rgba(): on the paper they stay the
     same in both themes; the --ink-* colours, for text and swatches beside
     the paper, lighten in the dark theme. */
  .corrector {
    --layer-staff: 128, 34, 64;
    --layer-grand: 38, 100, 60;
    --layer-measure: 14, 129, 149;
    --layer-movement: 139, 95, 191;
    --layer-system: 36, 82, 178;
    --ink-staff: rgb(var(--layer-staff));
    --ink-grand: rgb(var(--layer-grand));
    --ink-measure: rgb(var(--layer-measure));
    --ink-movement: rgb(var(--layer-movement));
    --ink-system: rgb(var(--layer-system));
  }
  :global([data-theme="dark"]) .corrector {
    --ink-staff: rgb(222, 120, 152);
    --ink-grand: rgb(110, 196, 138);
    --ink-measure: rgb(72, 196, 214);
    --ink-movement: rgb(190, 156, 232);
    --ink-system: rgb(128, 164, 240);
  }
  /* Colour words in the help, in the colours they name. */
  .helppanel b {
    font-weight: 600;
  }
  .tone-staff {
    color: var(--ink-staff);
  }
  .tone-grand {
    color: var(--ink-grand);
  }
  .tone-measure {
    color: var(--ink-measure);
  }
  .tone-movement {
    color: var(--ink-movement);
  }
  .tone-system {
    color: var(--ink-system);
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
  /* The zoom and fit buttons match the 32px icon buttons beside them. */
  .ctoolbar :global(.tbtn) {
    min-height: 32px;
  }
  /* The zoom controls. */
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
  /* A medium tool column (MEDIUM_TOOL: a tablet, or a laptop beside the
     side panel) keeps one row: the page-count switch moves into the ⋯ menu,
     the zoom slider gives way to zoom out and in around the readout, and the
     page navigation and the ⋯ button keep the right end. */
  @container (max-width: 959px) {
    .tspacer,
    .zoomset > .zoomslider {
      display: none;
    }
    .zoomset > .zoomstep {
      display: inline-flex;
    }
    .zval {
      order: 1;
      min-width: 4ch;
      text-align: center;
    }
    .zoomin {
      order: 2;
    }
    .fitwidth,
    .fitpage {
      order: 3;
    }
    .pgnav {
      margin-left: auto;
    }
    .pgnav > .vline {
      display: none;
    }
    /* The ⋯ button ends the row, above its menu. */
    .viewbtn {
      order: 1;
    }
  }
  /* On a touch screen the toolbar buttons are 32px and take a 44px press
     through an invisible ::after. */
  @media (pointer: coarse) {
    .ctoolbar :global(.btn),
    .ctoolbar :global(.tbtn) {
      position: relative;
      min-width: 32px;
      min-height: 32px;
    }
    .ctoolbar :global(.btn)::after,
    .ctoolbar :global(.tbtn)::after {
      content: "";
      position: absolute;
      inset: -6px -3px;
    }
  }
  /* Narrow tool column (NARROW_TOOL, a phone): the toolbar moves below the
     pages, within thumb reach, as one row at touch size: undo and redo, the
     page navigation, fit width and help or the ⋯ menu; with a mouse also
     zoom out and in around the readout, on a touch screen a pinch zooms.
     Fit page is hidden. The help and the ⋯ menu open above the toolbar,
     over the pages, so the desk keeps its height. */
  @container (max-width: 559px) {
    .tbar {
      order: 2;
      padding: 6px 0 max(6px, env(safe-area-inset-bottom));
    }
    .ctoolbar {
      gap: 6px;
      padding: 0 6px;
      flex-wrap: nowrap;
    }
    .ctoolbar > .vline,
    .zoomset > .zoomslider,
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
    .viewbtn {
      order: 4;
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
    .tbar .helppanel {
      top: auto;
      bottom: 100%;
      margin: 0 0 8px;
    }
    .tbar .viewmenu {
      top: auto;
      bottom: 100%;
      margin: 0 0 8px;
    }
    /* 32px buttons that take a 44px press through an invisible ::after. */
    .ctoolbar :global(.btn),
    .ctoolbar :global(.tbtn) {
      position: relative;
      min-width: 32px;
      min-height: 32px;
    }
    .ctoolbar :global(.btn)::after,
    .ctoolbar :global(.tbtn)::after {
      content: "";
      position: absolute;
      inset: -6px -3px;
    }
  }
  /* On a narrow touch screen a pinch zooms: no zoom buttons or readout. */
  @media (pointer: coarse) {
    @container (max-width: 559px) {
      .zoomset > .zval,
      .zoomset > .zoomstep {
        display: none;
      }
    }
  }
  /* At the top of the phone sheet (inSheet) the toolbar is a plain row, and
     the page column keeps only the help, which opens over the pages. */
  .tbar.bare {
    padding: 0;
  }
  /* The View options open over the pages, below the ⋯ button, or above it
     where the toolbar sits under the pages (the 559px rule). */
  .viewmenu {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 5;
    margin: 8px 0 0;
    padding: 10px 12px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    box-shadow: var(--shadow-sm);
  }
  .viewmenu {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  .viewbtn.on {
    color: var(--accent);
    border-color: var(--accent);
  }
  .helpbtn.hidden {
    display: none;
  }
  /* Its padding holds the buttons' 44px press areas inside the scrolling
     row; the negative margin keeps the row 32px in the layout. */
  .ctoolbar.insheet {
    min-height: 32px;
    padding: 6px 3px;
    margin: -6px -3px;
    border: 0;
    background: transparent;
    box-shadow: none;
  }
  .insheet .pgnav {
    background: transparent;
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
  /* A page cropped to the piece's part: the frame clips the canvas and
     carries the sheet's outline and shadow. */
  .frame.cropped {
    overflow: hidden;
    background: var(--facsimile-paper);
    box-shadow:
      0 0 0 1px var(--line-input),
      0 10px 30px rgba(31, 36, 51, 0.16);
  }
  .frame.cropped svg {
    border: 0;
    box-shadow: none;
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
    fill: rgba(var(--layer-measure), 0.2);
    stroke: rgba(var(--layer-measure), 0.85);
    stroke-width: calc(2px * var(--stroke-scale, 1));
    cursor: pointer;
  }
  /* A selected box: a fill twice as dark and a solid outline. */
  .zone.selected {
    fill: rgba(var(--layer-measure), 0.4);
    stroke: rgb(var(--layer-measure));
    stroke-width: calc(3px * var(--stroke-scale, 1));
  }
  .zone.mdivstart {
    stroke: rgba(var(--layer-movement), 0.9);
    fill: rgba(var(--layer-movement), 0.22);
    stroke-width: calc(4px * var(--stroke-scale, 1));
  }
  .zone.mdivstart.selected {
    fill: rgba(var(--layer-movement), 0.42);
    stroke: rgb(var(--layer-movement));
  }
  /* A system beginning: a blue bar on the measure's left edge. */
  .sysstart {
    stroke: rgb(var(--layer-system));
    stroke-width: calc(3px * var(--stroke-scale, 1));
    pointer-events: none;
  }
  /* Wine red for staff boxes, dark green for grand staves, teal for measures:
     hues outside the region palette, darker than the red and green that mean
     fail and done. Only one layer is shown at a time. */
  .staff {
    fill: rgba(var(--layer-staff), 0.16);
    stroke: rgba(var(--layer-staff), 0.9);
    stroke-width: calc(2px * var(--stroke-scale, 1));
    cursor: pointer;
  }
  .staff.selected {
    fill: rgba(var(--layer-staff), 0.4);
    stroke: rgb(var(--layer-staff));
    stroke-width: calc(3px * var(--stroke-scale, 1));
  }
  /* A box focused by a tap or click shows no browser outline; keyboard
     focus keeps it. */
  .zone:focus:not(:focus-visible),
  .staff:focus:not(:focus-visible) {
    outline: none;
  }
  /* Keyboard focus: a dashed accent border, drawn as the box's stroke so it
     shows wherever SVG outlines do not. */
  .zone:focus-visible,
  .staff:focus-visible {
    outline: none;
    stroke: var(--accent);
    stroke-width: calc(3px * var(--stroke-scale, 1));
    stroke-dasharray: 6 3;
  }
  /* The first corner of a box drawn by two clicks, in its layer's colour. */
  .corner {
    stroke: rgba(var(--layer-measure), 0.95);
    stroke-width: calc(2px * var(--stroke-scale, 1));
    pointer-events: none;
  }
  .staves .corner {
    stroke: rgba(var(--layer-staff), 0.95);
  }
  .grandstaves .corner {
    stroke: rgba(var(--layer-grand), 0.95);
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
  /* The double bar of a section start, in the label's ink. */
  .dbar {
    fill: #1a1a1a;
    pointer-events: none;
  }
  .dbar.on {
    fill: #fff;
  }
  .staff.grand {
    fill: rgba(var(--layer-grand), 0.16);
    stroke: rgba(var(--layer-grand), 0.9);
  }
  .staff.grand.selected {
    fill: rgba(var(--layer-grand), 0.4);
    stroke: rgb(var(--layer-grand));
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
    border-color: var(--ink-staff);
    background: rgba(var(--layer-staff), 0.2);
  }
  .swatch.grand {
    border-color: var(--ink-grand);
    background: rgba(var(--layer-grand), 0.2);
  }
  .swatch.measure {
    border-color: var(--ink-measure);
    background: rgba(var(--layer-measure), 0.2);
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
     dot (down to --dot-min on a thin box) and --edge an edge handle's
     thickness; edges show no mark, the corners take precedence. A touch
     screen gets 32px corner and 20px edge targets, which keep clear of
     most of a thin staff's neighbours. Handles reach into the box by at
     most a quarter of its size on screen (--w, --h), so its middle stays
     the move target; the rest of each target lies outside the box. */
  .sel {
    position: absolute;
    --hit: 24px;
    --dot: 10px;
    --dot-min: 6px;
    --edge: 16px;
    --c: rgb(var(--layer-measure));
    /* Corner and edge reach into the box. */
    --cx: min(calc(var(--hit) / 2), calc(var(--w) / 4));
    --cy: min(calc(var(--hit) / 2), calc(var(--h) / 4));
    --ex: min(calc(var(--edge) / 2), calc(var(--w) / 4));
    --ey: min(calc(var(--edge) / 2), calc(var(--h) / 4));
    /* Corner and edge reach above and below the box, up to the free space
       beside a staff box (--room-t, --room-b). */
    --cout-t: min(calc(var(--hit) - var(--cy)), var(--room-t, 999px));
    --cout-b: min(calc(var(--hit) - var(--cy)), var(--room-b, 999px));
    --eout-t: min(calc(var(--edge) - var(--ey)), var(--room-t, 999px));
    --eout-b: min(calc(var(--edge) - var(--ey)), var(--room-b, 999px));
    pointer-events: none;
    z-index: 4;
  }
  .sel.staves {
    --c: rgb(var(--layer-staff));
  }
  .sel.grandstaves {
    --c: rgb(var(--layer-grand));
  }
  .sel.touch {
    --hit: 32px;
    --dot: 12px;
    --dot-min: 8px;
    --edge: 20px;
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
  .hd:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  /* The visible dot or bar, drawn by ::before. */
  .hd::before {
    content: "";
    position: absolute;
    box-sizing: border-box;
    background: #fff;
    border: 2px solid var(--c);
    box-shadow: 0 1px 3px rgba(31, 36, 51, 0.35);
  }
  .hd-nw,
  .hd-ne,
  .hd-sw,
  .hd-se {
    width: var(--hit);
    z-index: 1;
  }
  .hd-nw,
  .hd-sw {
    left: calc(var(--cx) - var(--hit));
  }
  .hd-ne,
  .hd-se {
    right: calc(var(--cx) - var(--hit));
  }
  .hd-nw,
  .hd-ne {
    top: calc(-1 * var(--cout-t));
    height: calc(var(--cout-t) + var(--cy));
  }
  .hd-sw,
  .hd-se {
    bottom: calc(-1 * var(--cout-b));
    height: calc(var(--cout-b) + var(--cy));
  }
  /* A picked-up corner (armed) fills with its layer colour. */
  .hd.armed::before {
    background: var(--c);
    box-shadow:
      0 0 0 3px #fff,
      0 1px 4px rgba(31, 36, 51, 0.45);
  }
  /* Each dot sits on its corner of the box. */
  .hd-nw,
  .hd-ne,
  .hd-sw,
  .hd-se {
    --d: max(var(--dot-min), min(var(--dot), var(--w), var(--h)));
  }
  .hd-nw::before,
  .hd-ne::before,
  .hd-sw::before,
  .hd-se::before {
    width: var(--d);
    height: var(--d);
    border-radius: 50%;
  }
  .hd-nw::before,
  .hd-sw::before {
    right: calc(var(--cx) - var(--d) / 2);
  }
  .hd-ne::before,
  .hd-se::before {
    left: calc(var(--cx) - var(--d) / 2);
  }
  .hd-nw::before,
  .hd-ne::before {
    bottom: calc(var(--cy) - var(--d) / 2);
  }
  .hd-sw::before,
  .hd-se::before {
    top: calc(var(--cy) - var(--d) / 2);
  }
  /* The edges run between the corner targets. */
  .hd-n,
  .hd-s {
    left: var(--cx);
    right: var(--cx);
  }
  .hd-n {
    top: calc(-1 * var(--eout-t));
    height: calc(var(--eout-t) + var(--ey));
  }
  .hd-s {
    bottom: calc(-1 * var(--eout-b));
    height: calc(var(--eout-b) + var(--ey));
  }
  .hd-w,
  .hd-e {
    top: var(--cy);
    bottom: var(--cy);
    width: var(--edge);
  }
  .hd-w {
    left: calc(var(--ex) - var(--edge));
  }
  .hd-e {
    right: calc(var(--ex) - var(--edge));
  }
  .hd-n::before,
  .hd-s::before,
  .hd-w::before,
  .hd-e::before {
    display: none;
  }
  /* The selected measure's number label in the measure colour. */
  .labelbg.on {
    fill: rgb(var(--layer-measure));
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
