// The selected box of the active layer as the measure correction uses it:
// its number, the boxes selected with it, stepping from box to box with the
// keyboard focus following, a new box beside it, and the selected measure as
// a comment's or a change request's anchor.

import { tick } from "svelte";
import type { CommentAnchorInput } from "../commands.ts";
import type { CommentRow } from "../campaign-tables.ts";
import { anchorCell } from "../campaign-submit.ts";
import type { MeasureBox } from "../mei-facsimile.ts";
import { movedBox } from "../box-geometry.ts";
import type { Layer } from "./edit-pages.ts";
import type { ZoneEditor, ZonePages } from "./zone-pages.svelte.ts";
import type { PageView } from "./page-view.svelte.ts";

export interface BoxSelectionHost {
  editor: ZoneEditor;
  model: ZonePages;
  view: PageView;
  /** The layer the pointer edits. */
  tool(): Layer;
  canEdit(): boolean;
  /** Page p's boxes changed: re-sort them and record the step. */
  settle(p: number): void;
}

export class BoxSelection {
  #host: BoxSelectionHost;

  constructor(host: BoxSelectionHost) {
    this.#host = host;
  }

  #items = (p: number) => this.#host.model.items(p, this.#host.tool());

  selected = $derived.by(() => this.#host.editor.selected);
  /** The selected measure's number, prefilling a change request; '' for none. */
  selectedLabel = $derived.by(() => {
    const zone =
      this.selected && this.#host.tool() === "measures"
        ? this.#host.model.pages[this.selected.p]?.zones[this.selected.z]
        : undefined;
    return zone ? String(zone.override ?? zone.label) : "";
  });
  // Several boxes of one page and the active layer selected together (by
  // Shift+click, Shift+drag or Select several), as their indices on the
  // selected box's page; empty while one box or none is selected.
  groupZs = $derived.by(() =>
    this.selected
      ? this.#host.editor.group.map((i) =>
          this.#items(this.selected!.p).indexOf(i),
        )
      : [],
  );
  selectedItem = $derived.by(() =>
    this.selected && this.#items(this.selected.p)[this.selected.z]
      ? this.selected
      : null,
  );
  hasPrev = $derived.by(
    () =>
      !!this.selected &&
      (this.selected.z > 0 ||
        this.#host.model.pages
          .slice(0, this.selected.p)
          .some((_, q) => this.#items(q).length > 0)),
  );
  hasNext = $derived.by(
    () =>
      !!this.selected &&
      (this.selected.z < this.#items(this.selected.p).length - 1 ||
        this.#host.model.pages
          .slice(this.selected.p + 1)
          .some((_, q) => this.#items(this.selected!.p + 1 + q).length > 0)),
  );

  inSelection = (p: number, z: number) =>
    this.#host.editor.inSelection(this.#items(p)[z]);

  // Each page is one tab stop: its selected box, else its first box. A and
  // D move from box to box (stepSelection).
  tabStop = (p: number, z: number) =>
    z === (this.selected?.p === p ? this.selected.z : 0) ? 0 : -1;

  // The anchor a change request opens with: the selected box's page and
  // measure, else the page in view.
  reviewPrefill = () => ({
    page: String(
      (this.selected?.p ??
        this.#host.view.spreads[this.#host.view.rowIndex]?.pages[0] ??
        0) + 1,
    ),
    m1: anchorCell(this.selectedLabel),
    m2: anchorCell(this.selectedLabel),
  });

  // A comment anchor scrolls the desk to its page and selects the measure with
  // the anchored number where the page has one.
  showAnchorFor = (c: CommentRow) => {
    const pages = this.#host.model.pages;
    const p = Number(c.page) - 1;
    if (!Number.isInteger(p) || p < 0 || p >= pages.length) return;
    this.#host.view.showPage(p);
    const z = pages[p].zones.findIndex(
      (zone) => (zone.override ?? zone.label) === c.measure_start,
    );
    this.#host.editor.select(p, z >= 0 ? pages[p].zones[z] : null);
  };
  // A new comment carries the selected measure as its anchor.
  commentAnchor = (): CommentAnchorInput | undefined =>
    this.selected && this.selectedLabel
      ? {
          page: String(this.selected.p + 1),
          measure_start: this.selectedLabel,
          measure_end: this.selectedLabel,
        }
      : undefined;

  /** Select the box before (-1) or after (1) the selected one in reading
      order, across pages; `reveal` scrolls it into view. Keyboard focus on
      a box moves with the selection. */
  async stepSelection(delta: 1 | -1, reveal = true) {
    const pages = this.#host.model.pages;
    if (!pages.length) return;
    const selected = this.selected;
    let p =
      selected?.p ??
      this.#host.view.spreads[this.#host.view.rowIndex]?.pages[0] ??
      0;
    let z = selected ? selected.z + delta : delta > 0 ? 0 : -1;
    if (!selected && delta < 0) z = this.#items(p).length - 1;
    while (
      p >= 0 &&
      p < pages.length &&
      (z < 0 || z >= this.#items(p).length)
    ) {
      p += delta;
      if (p < 0 || p >= pages.length) return;
      z = delta > 0 ? 0 : this.#items(p).length - 1;
    }
    if (p < 0 || p >= pages.length) return;
    const focused = (document.activeElement as Element | null)?.closest(
      ".zone, .staff",
    );
    this.#host.editor.selectItems(p, [this.#items(p)[z]]);
    if (reveal) this.#host.view.revealBox(p, this.#items(p)[z]?.box);
    if (focused) this.focusBox(p, z);
  }

  /** Focus a page's box once the DOM has caught up. Selecting a box moves
      it to the end of its page's paint order, and the move drops the
      keyboard focus it had. */
  async focusBox(p: number, z: number) {
    await tick();
    this.#host.view.svgEls[p]
      ?.querySelector<SVGElement>(`[data-box="${z}"]`)
      ?.focus({ preventScroll: true });
  }

  // A new box of the active layer without drawing it: the selected box's
  // size beside it (a staff below it, a measure to its right), or without a
  // selection a box in the middle of the first page in view. It is selected
  // and keeps the keyboard focus, for the arrow keys and handles to adjust.
  newBox = () => {
    const pages = this.#host.model.pages;
    const tool = this.#host.tool();
    if (!this.#host.canEdit() || !pages.length) return;
    const p =
      this.selectedItem?.p ??
      this.#host.view.spreads[this.#host.view.rowIndex]?.pages[0] ??
      0;
    const pg = pages[p];
    let box: MeasureBox;
    if (this.selectedItem) {
      const b = this.#items(p)[this.selectedItem.z].box;
      box =
        tool === "measures"
          ? movedBox(b, b.lrx - b.ulx, 0, pg)
          : movedBox(b, 0, (b.lry - b.uly) * 1.5, pg);
    } else {
      // Centred in the page's shown part, no taller than it.
      const v = this.#host.view.shownArea(pg);
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
    this.#host.editor.select(
      p,
      this.#items(p)[this.#host.model.addBox(p, tool, box)],
    );
    this.#host.settle(p);
    if (hadFocus && this.selected)
      this.focusBox(this.selected.p, this.selected.z);
  };

  // A key on a focused box (ed.boxKeydown). A move can re-sort the page's
  // boxes; the keyboard focus stays on the box.
  zoneKeydown = (e: KeyboardEvent, p: number, z: number) => {
    const item = this.#items(p)[z];
    if (!this.#host.editor.boxKeydown(e, p, item)) return;
    e.stopPropagation();
    const at = this.#items(p).indexOf(item);
    if (at >= 0) this.focusBox(p, at);
  };
}
