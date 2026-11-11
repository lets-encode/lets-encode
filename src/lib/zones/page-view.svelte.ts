// How the measure correction shows its pages: the zoom and the fit in
// force, one or two pages per row, the part of each page shown, whether the
// boxes and their overlaps are drawn, the rows the desk scrolls through and
// the position it keeps, and the tool column's width classes.

import { tick, untrack } from "svelte";
import { MediaQuery } from "svelte/reactivity";
import type { FacsimileTaskData } from "../commands.ts";
import type { MeasureBox } from "../mei-facsimile.ts";
import { DOCKED_QUERY } from "../side-panels.ts";
import { buildSpreads, shownPagesLabel } from "../page-spreads.ts";
import {
  applyAnchor,
  pagingRow,
  readAnchor,
  rowView,
  scrollToRow,
} from "../page-scroll.ts";
import { regionsView } from "../box-geometry.ts";
import {
  ZOOM_MAX as ZOOM_MAX_PERCENT,
  ZOOM_MIN as ZOOM_MIN_PERCENT,
} from "../components/ZoomLevel.svelte";
import type { EditPage } from "./edit-pages.ts";

// Page zoom: the fraction of the canvas width one page occupies. 1 = fit the
// canvas; above 1 the pages overflow and the desk scrolls horizontally.
export const ZOOM_MIN = ZOOM_MIN_PERCENT / 100;
export const ZOOM_MAX = ZOOM_MAX_PERCENT / 100;
/** Below this tool-column width (a phone) the desk shows one page per row
    and the toolbar keeps only undo, redo, the page navigation, fit width
    and the ⋯ menu (the 559px container rule in the styles). */
export const NARROW_TOOL = 560;
/** Below this tool-column width (a tablet) the page-count switch and
    "Page 1 right" move into the ⋯ menu and zoom steps by buttons, so the
    toolbar stays one row (the 959px container rule in the styles). */
export const MEDIUM_TOOL = 960;
// Below VIEW_COMPACT pixels of tool column the boxes, overlaps and
// whole-page buttons move from the toolbar into the ⋯ menu.
const VIEW_COMPACT = 720;
// Where the piece covers only part of a page, the page shows that part:
// its regions widened by REGION_MARGIN of the page width, unless the whole
// page is asked for.
const REGION_MARGIN = 0.02;

export interface PageViewHost {
  pages(): EditPage[];
  /** The loaded task; each new one opens at the initial view. */
  data(): FacsimileTaskData | null;
  /** A touch screen. */
  coarse(): boolean;
  /** The instruments step is in view: its pages show no boxes. */
  step4(): boolean;
  /** Paging clears the selection. */
  deselect(): void;
  /** Hiding or showing the boxes clears the editor's state. */
  boxesToggled(): void;
}

export class PageView {
  zoom = $state(1);
  // The fit in force, if any: it keeps the zoom at the fit as the desk
  // resizes or the view changes, until the slider is moved. Each freshly
  // loaded task opens at one page per row and the whole-page fit; on a
  // touch screen (a tablet) at the page width.
  fit = $state<"width" | "page" | null>("page");
  #zoomInitFor = $state<FacsimileTaskData | null>(null);

  // The pages scroll as rows of one or two pages. `view` is one or two pages
  // per row; `firstOnRight` places page 1 as a right-hand page (recto), so a
  // two-up view pairs 2|3, 4|5, … the way a score opens — the printed page
  // number's side can't be read without OCR, so this convention (with the
  // toggle) stands in for it.
  view = $state<"single" | "double">("single");
  firstOnRight = $state(true);
  wholePage = $state(false);

  showOverlaps = $state(true);
  // Hidden, the layer's boxes are not drawn, cannot be selected and no new
  // box is drawn; a finger on the page scrolls it. The instruments step's
  // pages show no boxes.
  boxesOn = $state(true);

  // A narrow tool column (a phone) shows one page per row and hides the
  // switch; the chosen view returns when the column widens. The width is the
  // toolbar's, the content box the container rules in the styles measure.
  toolW = $state(0);
  // The desk's inner size, for the whole-page fit.
  deskW = $state(0);
  deskH = $state(0);

  // The desk scrolls through the rows, one per spread.
  desk = $state<HTMLElement | null>(null);
  rowEls = $state<HTMLElement[]>([]);
  svgEls = $state<SVGSVGElement[]>([]);
  // Each visible page's rendered canvas width (px), so the SVG number labels can
  // be sized to a near-constant on-screen size across zoom and 1-/2-page view.
  canvasW = $state<number[]>([]);
  // What the desk shows, read from the scroll position.
  rowIndex = $state(0);
  shownRows = $state<number[]>([]);
  nearPages = $state<number[]>([]);
  atTop = $state(true);
  atEnd = $state(true);
  // The position the desk returns to when the rows change size, kept by page
  // so it survives the rows being re-sliced.
  anchor: { page: number; frac: number; x?: number } = {
    page: 0,
    frac: 0,
  };
  // Scroll events are read once per frame.
  #scrollFrame = 0;

  // The instruments step shows the name fields beside each system's
  // opening or beside the whole pages (InstrumentNaming's `whole`), not the
  // page view of the other steps; its controls (pages, zoom, page count)
  // stay out of the toolbar. Each view keeps its scroll position.
  step4Pages = $state(false);
  step4Top = { names: 0, pages: 0 };

  // A phone in portrait: the side panel is a sheet below the pages, and the
  // page toolbar sits at its top.
  #dockedQuery = new MediaQuery(DOCKED_QUERY, false);
  #host: PageViewHost;

  constructor(host: PageViewHost) {
    this.#host = host;
    $effect(() => {
      const data = this.#host.data();
      if (!data || this.#zoomInitFor === data) return;
      this.#zoomInitFor = data;
      const touch = untrack(() => this.#host.coarse());
      this.fit = touch ? "width" : "page";
      this.view = "single";
    });
    // A narrow tool column has no whole-page fit: it shows the page width.
    $effect(() => {
      if (this.narrow && this.fit === "page") this.fit = "width";
    });
    $effect(() => {
      if (this.fit === "width") this.zoom = 1;
      else if (this.fit === "page") this.zoom = this.fitZoom();
    });
    // Zoom, the view, the desk size and a newly loaded task move every row; once
    // the rows are laid out anew, the desk returns to the remembered position.
    $effect(() => {
      void [
        this.zoom,
        this.spreads,
        this.deskW,
        this.deskH,
        this.#host.pages(),
      ];
      tick().then(() => {
        const row = this.spreads.findIndex((s) =>
          s.pages.includes(this.anchor.page),
        );
        if (!this.desk || row < 0) return;
        applyAnchor(this.desk, this.rowEls.slice(0, this.spreads.length), {
          ...this.anchor,
          row,
        });
        this.deskScrolled();
      });
    });
    // The pending scroll frame ends with the page.
    $effect(() => () => cancelAnimationFrame(this.#scrollFrame));
  }

  narrow = $derived(this.toolW > 0 && this.toolW < NARROW_TOOL);
  medium = $derived(this.toolW > 0 && this.toolW < MEDIUM_TOOL);
  viewCompact = $derived(this.toolW > 0 && this.toolW < VIEW_COMPACT);
  docked = $derived.by(() => this.#dockedQuery.current);
  inSheet = $derived(this.narrow && this.docked);
  // The View options behind the toolbar's ⋯ button: the page-count switch
  // below MEDIUM_TOOL, and on a phone sheet (inSheet) the help.
  viewMenu = $derived(this.inSheet || this.medium);
  shownView = $derived(this.narrow ? "single" : this.view);
  spreads = $derived.by(() =>
    buildSpreads(this.#host.pages().length, this.shownView, this.firstOnRight),
  );
  shownPages = $derived(
    this.shownRows.flatMap((r) => this.spreads[r]?.pages ?? []),
  );
  spreadLabel = $derived.by(() =>
    shownPagesLabel(
      this.spreads,
      this.shownRows.length ? this.shownRows : [this.rowIndex],
      this.#host.pages().length,
    ),
  );
  hasPartPages = $derived.by(() =>
    this.#host.pages().some((pg) => !this.isWhole(this.partOf(pg), pg)),
  );
  showBoxes = $derived.by(() => this.boxesOn && !this.#host.step4());
  // Labels and box borders grow a little with zoom (damped) so they do not
  // feel oversized zoomed out or small zoomed in.
  damp = $derived(Math.min(1.7, Math.max(0.8, 0.7 + 0.3 * this.zoom)));

  partOf = (pg: EditPage): MeasureBox =>
    regionsView(pg.regions, pg, REGION_MARGIN);
  isWhole = (v: MeasureBox, pg: EditPage) =>
    v.ulx <= 0 && v.uly <= 0 && v.lrx >= pg.width && v.lry >= pg.height;
  shownArea = (pg: EditPage): MeasureBox =>
    this.wholePage
      ? { ulx: 0, uly: 0, lrx: pg.width, lry: pg.height }
      : this.partOf(pg);

  // The zoom at which a whole page fits in the desk: bounded by the height
  // (using the tallest page), capped at 1 (the width fit). 76 covers the
  // desk padding, the page heading above each sheet and the sheet's bottom
  // margin. A page cropped to the piece fits its shown part.
  fitZoom(): number {
    const pages = this.#host.pages();
    if (!pages.length || !this.deskW || !this.deskH) return 1;
    const aspect = Math.max(
      ...pages.map((pg) => {
        const v = this.shownArea(pg);
        return (v.lry - v.uly) / (v.lrx - v.ulx);
      }),
    );
    const pagesW = this.deskW - 48;
    const colW = this.shownView === "double" ? (pagesW - 4) / 2 : pagesW;
    const usableH = this.deskH - 76;
    if (colW <= 0 || usableH <= 0) return 1;
    const z = usableH / (colW * aspect);
    return Math.min(1, Math.max(ZOOM_MIN, Math.floor(z * 1000) / 1000));
  }

  deskScrollEvent = () => {
    if (!this.#scrollFrame)
      this.#scrollFrame = requestAnimationFrame(() => {
        this.#scrollFrame = 0;
        this.deskScrolled();
      });
  };
  deskScrolled() {
    if (!this.desk) return;
    const rows = this.rowEls.slice(0, this.spreads.length);
    const v = rowView(this.desk, rows);
    this.rowIndex = v.current;
    if (v.shown.join() !== this.shownRows.join()) this.shownRows = v.shown;
    this.atTop = v.atTop;
    this.atEnd = v.atEnd;
    const near = v.near.flatMap((r) => this.spreads[r]?.pages ?? []);
    if (near.join() !== this.nearPages.join()) this.nearPages = near;
    const a = readAnchor(this.desk, rows);
    if (a)
      this.anchor = {
        page: this.spreads[a.row]?.pages[0] ?? 0,
        frac: a.frac,
        x: a.x,
      };
  }

  /** Scroll a page's row (0-based page) to the top of the desk. */
  showPage(p: number) {
    const row = this.spreads.findIndex((s) => s.pages.includes(p));
    if (!this.desk || row < 0) return;
    this.anchor = { page: this.spreads[row].pages[0], frac: 0 };
    scrollToRow(this.desk, this.rowEls.slice(0, this.spreads.length), row);
    this.deskScrolled();
  }
  // The whole-page fit also scrolls the row being read to the top, so its
  // pages are in view from top to bottom.
  fitWholePage = () => {
    const p = this.spreads[this.rowIndex]?.pages[0] ?? 0;
    this.fit = "page";
    tick().then(() => this.showPage(p));
  };

  // One row on. Back from partway down a row returns to that row's top first.
  go = (delta: number) => {
    if (!this.desk) return;
    const rows = this.rowEls.slice(0, this.spreads.length);
    const next = this.spreads[pagingRow(this.desk, rows, this.rowIndex, delta)];
    if (!next) return;
    this.showPage(next.pages[0]);
    this.#host.deselect();
  };

  /** Scroll a box into view, centred, when it is outside the view. */
  async revealBox(p: number, box: MeasureBox | undefined) {
    if (!box) return;
    const pg = this.#host.pages()[p];
    await tick();
    const svg = this.svgEls[p];
    if (!this.desk || !svg) return;
    const r = svg.getBoundingClientRect();
    const d = this.desk.getBoundingClientRect();
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
    this.desk.scrollLeft += (left + right) / 2 - (d.left + d.width / 2);
    this.desk.scrollTop += (top + bottom) / 2 - (d.top + d.height / 2);
    this.deskScrolled();
  }

  async showStep4Pages(on: boolean) {
    if (on === this.step4Pages || !this.desk) return;
    this.step4Top[this.step4Pages ? "pages" : "names"] = this.desk.scrollTop;
    this.step4Pages = on;
    await tick();
    this.desk.scrollTo({ top: this.step4Top[on ? "pages" : "names"] });
  }

  toggleBoxes = () => {
    this.boxesOn = !this.boxesOn;
    this.#host.boxesToggled();
  };
}
