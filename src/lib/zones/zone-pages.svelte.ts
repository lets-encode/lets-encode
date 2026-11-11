// The measure correction's working copy: the pages with their measure,
// staff and grand-staff boxes, the instruments the instruments step named,
// the layout model's raw output from this session and the pages shown in
// each step; the measures' flags and numbers, and the copies the editor's
// undo history keeps.

import type { FacsimileTaskData } from "../commands.ts";
import type { BoxEditor } from "../box-editor.svelte.ts";
import type { MeasureBox, MeasureSign } from "../mei-facsimile.ts";
import { MEASURE_SIGNS } from "../mei-facsimile.ts";
import type { CocoLayout, LayoutInstruments } from "../omr-layout.ts";
import { NO_INSTRUMENTS } from "../instrument-naming.ts";
import {
  clonePages,
  editPagesFrom,
  layerItems,
  type EditPage,
  type Layer,
} from "./edit-pages.ts";
import {
  pbAt,
  renumber,
  resort,
  resortStaves,
  rowStarts,
  sectionLocked,
} from "./measures.ts";

/** One step of the undo history. */
export type ZoneSnapshot = { pages: EditPage[]; named: LayoutInstruments };
/** The editor of the active layer's boxes. */
export type ZoneEditor = BoxEditor<{ box: MeasureBox }, ZoneSnapshot>;

export interface ZonePagesHost {
  canEdit(): boolean;
  /** Record the change as one undoable step. */
  commit(): void;
}

export class ZonePages {
  pages = $state<EditPage[]>([]);
  // The instruments the instruments step named, in score order; each staff
  // box names its score staff (EditStaff.staff).
  named = $state<LayoutInstruments>(NO_INSTRUMENTS);
  // The layout model's raw output per page index, kept from a detection run
  // in this session for the submission; outside the edit history.
  rawLayouts = $state<Record<number, CocoLayout>>({});
  // The pages shown in each step.
  seen = $state<Record<Layer, number[]>>({
    staves: [],
    grandstaves: [],
    measures: [],
  });
  #host: ZonePagesHost;

  constructor(host: ZonePagesHost) {
    this.#host = host;
  }

  measureCount = $derived(this.pages.reduce((n, p) => n + p.zones.length, 0));
  staffCount = $derived(this.pages.reduce((n, p) => n + p.staves.length, 0));
  grandstaffCount = $derived(
    this.pages.reduce((n, p) => n + p.grandstaves.length, 0),
  );
  movementCount = $derived(
    1 +
      this.pages.reduce(
        (n, pg, p) =>
          n + pg.zones.filter((z, i) => z.mdiv && (p > 0 || i > 0)).length,
        0,
      ),
  );

  /** A page's boxes in a layer. */
  items(p: number, layer: Layer): { box: MeasureBox }[] {
    return layerItems(this.pages[p], layer);
  }

  /** Fill the working copy from a loaded task. */
  load(d: FacsimileTaskData) {
    this.rawLayouts = {};
    this.seen = { staves: [], grandstaves: [], measures: [] };
    this.named = d.instruments ?? NO_INSTRUMENTS;
    this.pages = editPagesFrom(d);
  }

  /** Add the pages shown in a step to those seen in it. */
  markSeen(layer: Layer, shown: number[]) {
    const added = shown.filter((p) => !this.seen[layer].includes(p));
    if (added.length) this.seen[layer] = [...this.seen[layer], ...added];
  }

  // Add a box to a page's layer; returns its index.
  addBox(p: number, layer: Layer, box: MeasureBox): number {
    if (layer !== "measures") this.pages[p][layer].push({ box });
    else
      this.pages[p].zones.push({
        box,
        override: null,
        label: "",
        sb: false,
        sbOverride: null,
        mdiv: false,
        pickup: false,
      });
    return this.items(p, layer).length - 1;
  }

  /** Re-sort a page's boxes of a layer after their geometry changed. */
  resortLayer(p: number, layer: Layer) {
    if (layer === "measures") resort(this.pages, p);
    else resortStaves(this.pages, p, layer);
  }

  // The instruments' names are undone with the boxes they name.
  snapshot(): ZoneSnapshot {
    return {
      pages: clonePages(this.pages),
      named: $state.snapshot(this.named),
    };
  }
  restore(s: ZoneSnapshot) {
    this.pages = clonePages(s.pages);
    this.named = structuredClone(s.named);
  }

  // A flag set to what the rows give follows the rows again.
  toggleSb(p: number, z: number) {
    if (!this.#host.canEdit() || pbAt(z)) return;
    const zone = this.pages[p].zones[z];
    const next = !zone.sb;
    zone.sbOverride =
      next === rowStarts(this.pages, p).has(zone.box) ? null : next;
    zone.sb = next;
    this.#host.commit();
  }
  // Each section counts its measures from 1.
  toggleSection(p: number, z: number) {
    if (!this.#host.canEdit() || sectionLocked(p, z)) return;
    this.pages[p].zones[z].mdiv = !this.pages[p].zones[z].mdiv;
    renumber(this.pages);
    this.#host.commit();
  }
  togglePickup(p: number, z: number) {
    if (!this.#host.canEdit()) return;
    this.pages[p].zones[z].pickup = !this.pages[p].zones[z].pickup;
    renumber(this.pages);
    this.#host.commit();
  }

  // Repeat barlines at the measure's start or end, the ending it belongs to
  // ('' for none) and its navigation signs.
  toggleRepeat(p: number, z: number, side: "start" | "end" | "both") {
    if (!this.#host.canEdit()) return;
    const zone = this.pages[p].zones[z];
    // The measure's end carries a repeat end or a double repeat, not both.
    if (side === "start") zone.rptStart = !zone.rptStart;
    else if (side === "end") {
      zone.rptEnd = !zone.rptEnd;
      if (zone.rptEnd) zone.rptBoth = false;
    } else {
      zone.rptBoth = !zone.rptBoth;
      if (zone.rptBoth) zone.rptEnd = false;
    }
    this.#host.commit();
  }
  setEnding(p: number, z: number, ending: string) {
    if (!this.#host.canEdit()) return;
    this.pages[p].zones[z].ending = ending || undefined;
    this.#host.commit();
  }
  toggleSign(p: number, z: number, sign: MeasureSign) {
    if (!this.#host.canEdit()) return;
    const zone = this.pages[p].zones[z];
    const on = zone.signs?.includes(sign);
    zone.signs = MEASURE_SIGNS.filter((s) =>
      s === sign ? !on : zone.signs?.includes(s),
    );
    this.#host.commit();
  }

  setLabel(p: number, z: number, value: string) {
    this.pages[p].zones[z].override = value.trim() === "" ? null : value.trim();
    renumber(this.pages);
  }
}
