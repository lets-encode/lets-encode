// The score setup's preview: the opening of the score with the values on
// screen, rendered as one seed measure so the staves, clefs, key signature
// and meter can be read back before they are submitted. A one-measure blank
// score rather than the full rebuild: a facsimile piece has no measures to
// render before its measure correction runs.
//
// The preview's sheet is measured to size the rendering, to line the
// source up with it and to place the staff numbers beside it; the staves a
// row of the form or the summary points at are coloured in it.

import { tick } from "svelte";
import type { FacsimileTaskData } from "../commands.ts";
import { fitRoom } from "../components/FacsimileFrame.svelte";
import { buildBlankScoreMei } from "../mei-facsimile.ts";
import { getVerovio, loadSnippet, renderPage } from "../verovio-render.ts";
import type { SetupModel } from "./setup-model.svelte.ts";
import {
  staffMatch,
  type FirstMeasure,
  type StaffSpan,
} from "./source-frame.ts";

// The preview's size. The rendering is measured once per render, its
// staves as fractions of its width; it is then drawn at the largest width
// at which a staff is at most STAFF_MAX high, the rendering fits the
// sheet, and, at the scale that lines the source up, the source's frame
// and the preview's staves together fit the source's view: the frame's
// part above the first staff, then the longer of the frame's part below
// it and the preview's staves with a staff's height of room below the
// last. That height is centred in the view, which
// places the first staff on both sides.
// While groups are marked, each staff keeps at least MARK_PITCH of height
// up to the sheet's width, the sheet scrolling.
const STAFF_MAX = 44;
const MARK_PITCH = 32;
// The sheet's content lies inside its padding (.sheet), 9px below the top
// of the facsimile box with the border.
const SHEET_PAD = { top: 9, x: 36, y: 16 };

export interface SetupPreviewHost {
  data: () => FacsimileTaskData | null;
  /** The source's first measure, where the piece has one. */
  firstMeasure: () => FirstMeasure | null;
  /** The page a comment anchor shows whole; null while the first measure is shown. */
  anchorPage: () => number | null;
  /** Whether groups are being marked in the preview. */
  markable: () => boolean;
}

export class SetupPreview {
  #model: SetupModel;
  #host: SetupPreviewHost;
  previewSvg = $state("");
  previewError = $state("");
  sheetEl = $state<HTMLElement | null>(null);
  // The facsimile box and the sheet inside its border, in CSS pixels.
  facsW = $state(0);
  facsH = $state(0);
  sheetW = $state(0);
  sheetH = $state(0);
  // The staves a row of the form or the summary points at: hovered, else
  // focused.
  hoveredStaff = $state<number | null>(null);
  focusedStaff = $state<number | null>(null);
  pointedStaff = $derived(this.hoveredStaff ?? this.focusedStaff);
  rendering = $state<
    (StaffSpan & { aspect: number; staffHeight: number }) | null
  >(null);
  previewStaves = $state<StaffSpan | null>(null);
  // The staff numbers beside the preview, for orientation: each at the
  // middle of its rendered staff, measured in the sheet's scrolled content,
  // again after every render and every change of the sheet's size.
  staffMarks = $state<number[]>([]);

  /** The source's first system lined up with the preview's staves. */
  align = $derived.by(() =>
    this.previewStaves &&
    this.#host.firstMeasure() &&
    this.#host.anchorPage() === null
      ? staffMatch(this.previewStaves, this.#host.firstMeasure()!)
      : null,
  );

  previewSize = $derived.by(() => {
    const r = this.rendering;
    const cw = this.sheetW - SHEET_PAD.x;
    const ch = this.sheetH - SHEET_PAD.y;
    if (!r || cw <= 0 || ch <= 0) return null;
    let width = Math.min(cw, STAFF_MAX / Math.max(r.staffHeight, 1e-6));
    const fm = this.#host.firstMeasure();
    const facs =
      fm &&
      this.#host.anchorPage() === null &&
      this.#host.data()?.imageUrls[fm.page] &&
      this.facsW &&
      this.facsH;
    const m = facs ? staffMatch(r, fm) : null;
    const room = fitRoom(this.facsW, this.facsH);
    // Per unit of the preview's width: the source's scale, and the heights
    // above and below the first staff.
    let kw = 0;
    let above = 0;
    let below = 0;
    if (m && fm) {
      kw = (m.bottom - m.top) / (m.lry - m.uly);
      above = (fm.anchor.uly - fm.frame.uly) * kw;
      below = Math.max(
        (fm.frame.lry - fm.anchor.uly) * kw,
        r.bottom - r.top + r.staffHeight,
      );
      width = Math.min(
        width,
        room.width / ((fm.frame.lrx - fm.frame.ulx) * kw),
        room.height / (above + below),
      );
    } else width = Math.min(width, ch / r.aspect);
    if (this.#host.markable() && r.count > 1)
      width = Math.min(
        cw,
        Math.max(width, (MARK_PITCH * (r.count - 1)) / (r.lastTop - r.top)),
      );
    let offset = 0;
    if (kw) {
      const staffTop =
        room.top +
        Math.max(0, (room.height - (above + below) * width) / 2) +
        above * width;
      offset = Math.max(0, staffTop - SHEET_PAD.top - r.top * width);
    }
    return { width: Math.floor(width), offset: Math.round(offset) };
  });

  constructor(model: SetupModel, host: SetupPreviewHost) {
    this.#model = model;
    this.#host = host;
  }

  // The rendered measure's staves are in staff order.
  staffEls = () => [
    ...(this.sheetEl?.querySelectorAll<SVGGElement>("g.measure > g.staff") ??
      []),
  ];

  // Each rendered staff's lines, in viewport coordinates.
  staffLines = () =>
    this.staffEls().map((g) => {
      let top = Infinity;
      let bottom = -Infinity;
      for (const line of g.children) {
        if (line.tagName !== "path") continue;
        const r = line.getBoundingClientRect();
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
      }
      return { top, bottom };
    });

  previewLines(): StaffSpan | null {
    const lines = this.staffLines();
    const first = lines[0];
    const last = lines[lines.length - 1];
    return first && last && last.bottom > first.top
      ? {
          top: first.top,
          lastTop: last.top,
          bottom: last.bottom,
          count: lines.length,
        }
      : null;
  }

  measurePreviewStaves = () => (this.previewStaves = this.previewLines());

  /** Run inside an `$effect`: measures the rendering after each render. */
  measureRendering() {
    void this.previewSvg;
    void tick().then(() => {
      const svg = this.sheetEl?.querySelector("svg");
      const box = svg?.getBoundingClientRect();
      const vb = svg?.viewBox.baseVal;
      const p = this.previewLines();
      if (!box?.width || !box.height || !vb?.width || !vb.height || !p) return;
      // The drawing is fitted into the element's box and centred in it, so
      // where the box is cut to the sheet's height it is narrower than the
      // box.
      const scale = Math.min(box.width / vb.width, box.height / vb.height);
      const w = vb.width * scale;
      const top = box.top + (box.height - vb.height * scale) / 2;
      this.rendering = {
        top: (p.top - top) / w,
        lastTop: (p.lastTop - top) / w,
        bottom: (p.bottom - top) / w,
        count: p.count,
        aspect: vb.height / vb.width,
        staffHeight:
          Math.max(...this.staffLines().map((l) => l.bottom - l.top)) / w,
      };
    });
  }

  /** Run inside an `$effect`: renders the values on screen while they are
      valid. */
  render() {
    const model = this.#model.scoreDef;
    const data = this.#host.data();
    if (!data || !this.#model.meterValid || !this.#model.groupsValid) return;
    const mei = buildBlankScoreMei(data.model.headXml, 0, model);
    let dropped = false;
    getVerovio()
      .then((tk) => {
        if (dropped) return;
        if (!loadSnippet(tk, mei))
          throw new Error("the score could not be rendered.");
        this.previewSvg = renderPage(tk, 1);
        this.previewError = "";
      })
      .catch((e: Error) => {
        if (!dropped) this.previewError = `No preview: ${e.message}`;
      });
    return () => (dropped = true);
  }

  /** Run inside an `$effect`: colours the staves in `range` (1-based). */
  lightStaves(range: { start: number; end: number } | null) {
    void this.previewSvg;
    this.staffEls().forEach((g, i) =>
      g.classList.toggle(
        "pointed",
        !!range && i + 1 >= range.start && i + 1 <= range.end,
      ),
    );
  }

  placeStaffMarks() {
    const el = this.sheetEl;
    if (!el) return;
    const top = el.getBoundingClientRect().top - el.scrollTop;
    this.staffMarks = this.staffEls().map((g) => {
      const box = g.getBoundingClientRect();
      return (box.top + box.bottom) / 2 - top;
    });
  }

  /** Run inside an `$effect`: places the staff numbers and measures the
      staves after every render, resize and scroll of the sheet. */
  observeSheet() {
    void this.previewSvg;
    void this.previewSize;
    const el = this.sheetEl;
    if (!el) return;
    const place = () => {
      this.placeStaffMarks();
      this.measurePreviewStaves();
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    const svg = el.querySelector("svg");
    if (svg) observer.observe(svg);
    // The source follows the preview scrolled while groups are marked.
    el.addEventListener("scroll", this.measurePreviewStaves, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", this.measurePreviewStaves);
    };
  }

  // Marking: a staff's target is the band of the preview's full width
  // nearest its middle.
  staffAt(y: number): number | null {
    let best: number | null = null;
    let distance = Infinity;
    this.staffEls().forEach((g, i) => {
      const box = g.getBoundingClientRect();
      const d = Math.abs(y - (box.top + box.bottom) / 2);
      if (d < distance) {
        distance = d;
        best = i;
      }
    });
    return best;
  }

  /** The handlers that make a row point at staff `i`. */
  pointAt = (i: number) => ({
    onmouseenter: () => (this.hoveredStaff = i),
    onmouseleave: () => (this.hoveredStaff = null),
    onfocusin: () => (this.focusedStaff = i),
    onfocusout: (e: FocusEvent) => {
      const row = e.currentTarget as HTMLElement;
      if (!row.contains(e.relatedTarget as Node | null))
        this.focusedStaff = null;
    },
  });
}
