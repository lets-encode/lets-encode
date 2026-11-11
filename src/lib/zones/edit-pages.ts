// The measure correction's working copy of the pages: each page's measure
// zones, staff boxes and grand-staff boxes as the editor holds them, built
// from a loaded task and turned back into page models for the draft and the
// submission.

import type { FacsimileTaskData } from "../commands.ts";
import { measureLabels, type MeasureSign } from "../mei-facsimile.ts";
import type { MeasureBox, PageModel } from "../mei-facsimile.ts";
import { centreInRegions } from "../box-geometry.ts";
import { numbering, renumber, rowStarts } from "./measures.ts";

// Editor-side zone: the box, the label override (null = automatic), the
// computed label, the break flags and the pickup flag. The page break is
// derived from position (each page's first measure), not stored per-zone.
// `sb` follows the reading-order rows (a row's first box starts a system)
// unless `sbOverride` holds a value set by hand.
export type EditZone = {
  box: MeasureBox;
  override: string | null;
  label: string;
  sb: boolean;
  sbOverride: boolean | null;
  mdiv: boolean;
  pickup: boolean;
  // Repeat barlines, the ending and the navigation signs (ZoneModel).
  rptStart?: boolean;
  rptEnd?: boolean;
  rptBoth?: boolean;
  ending?: string;
  signs?: MeasureSign[];
};
// A staff or grand-staff box of an OMR-prepared piece. A staff box of an
// 'omr-instruments' piece carries the score staff (staffDef xml:id) the
// instruments step named for it.
export type EditStaff = { box: MeasureBox; staff?: string };
export type EditPage = {
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
export type Layer = "measures" | "staves" | "grandstaves";

/** The layer each layout step edits, steps 1 to 3. */
export const STEP_LAYERS: Layer[] = ["staves", "grandstaves", "measures"];
/** The layout steps' names, steps 1 to 4. */
export const STEP_NAMES = [
  "staff boxes",
  "grand staves",
  "measures",
  "instruments",
];

/** A page's boxes in a layer, for the geometry code shared by all. */
export const layerItems = (
  pg: EditPage,
  layer: Layer,
): { box: MeasureBox }[] =>
  layer === "staves"
    ? pg.staves
    : layer === "grandstaves"
      ? pg.grandstaves
      : pg.zones;

/**
 * The working copy of a loaded task's pages. Boxes outside the piece's
 * regions on a page are dropped.
 */
export function editPagesFrom(
  d: Pick<FacsimileTaskData, "model" | "regions" | "imageUrls">,
): EditPage[] {
  let droppedMeasures = false;
  const pages: EditPage[] = d.model.pages.map((pg, i) => {
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
        rptStart: z.rptStart,
        rptEnd: z.rptEnd,
        rptBoth: z.rptBoth,
        ending: z.ending,
        signs: z.signs ? [...z.signs] : undefined,
      })),
      staves: (pg.staves ?? [])
        .filter(inPiece)
        .map(({ staff, ...box }) => (staff ? { box, staff } : { box })),
      grandstaves: (pg.grandstaves ?? [])
        .filter(inPiece)
        .map((box) => ({ box: { ...box } })),
      regions,
    };
  });
  // A label that differs from what automatic numbering would produce is
  // an override (e.g. 10a/10b) — keep it through renumbering. The
  // measure after each one is included, since a pickup changes the
  // label of the measure before it. With measures dropped, the labels
  // left are numbered automatically.
  if (droppedMeasures) renumber(pages);
  else {
    const measures = numbering(pages);
    measures.forEach((m, i) => {
      const auto = measureLabels(measures.slice(0, i + 2))[i];
      if (m.zone.label !== auto) m.override = m.zone.label;
    });
    for (const m of measures) m.zone.override = m.override;
  }
  // Likewise a system beginning that differs from what the rows give.
  pages.forEach((pg, p) => {
    const starts = rowStarts(pages, p);
    for (const zone of pg.zones) {
      if (zone.sb !== starts.has(zone.box)) zone.sbOverride = zone.sb;
    }
  });
  return pages;
}

// The editor's history holds full copies of the pages.
export function clonePages(src: EditPage[]): EditPage[] {
  return src.map((pg) => ({
    ...pg,
    zones: pg.zones.map((z) => ({ ...z, box: { ...z.box } })),
    staves: pg.staves.map((s) => ({ ...s, box: { ...s.box } })),
    grandstaves: pg.grandstaves.map((g) => ({ box: { ...g.box } })),
  }));
}

/** The pages as page models; with `omr`, with their staff and grand-staff boxes. */
export function toPageModels(pages: EditPage[], omr: boolean): PageModel[] {
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
      rptStart: z.rptStart || undefined,
      rptEnd: z.rptEnd || undefined,
      rptBoth: z.rptBoth || undefined,
      ending: z.ending || undefined,
      signs: z.signs?.length ? [...z.signs] : undefined,
    })),
    ...(omr
      ? {
          staves: pg.staves.map((s) =>
            s.staff ? { ...s.box, staff: s.staff } : { ...s.box },
          ),
          grandstaves: pg.grandstaves.map((g) => ({ ...g.box })),
        }
      : {}),
  }));
}

/** Intersections of every pair of a page's boxes on one layer. */
export function overlaps(pg: EditPage, layer: Layer): MeasureBox[] {
  const boxes = (
    layer === "measures"
      ? pg.zones
      : layer === "grandstaves"
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

// The free space above and below box z of a staff or grand-staff layer, in
// page pixels, up to the nearest box of its layer beside it; Infinity where
// there is none. Its handles reach no further, so they never cover a
// neighbouring box.
export function staffRoom(list: { box: MeasureBox }[], z: number) {
  const b = list[z].box;
  let top = Infinity;
  let bottom = Infinity;
  list.forEach(({ box: o }, i) => {
    if (i === z || o.lrx <= b.ulx || o.ulx >= b.lrx) return;
    if (o.lry <= b.uly) top = Math.min(top, b.uly - o.lry);
    else if (o.uly >= b.lry) bottom = Math.min(bottom, o.uly - b.lry);
  });
  return { top, bottom };
}

/** What one box of a layer is called. */
export const boxNameOf = (layer: Layer) =>
  layer === "staves"
    ? "staff"
    : layer === "grandstaves"
      ? "grand staff"
      : "measure";
/** What several boxes of a layer are called. */
export const boxNamesOf = (layer: Layer) =>
  layer === "staves"
    ? "staves"
    : layer === "grandstaves"
      ? "grand staves"
      : "measures";

/** A box's name in the side panel and in its handles' labels. */
export const itemName = (
  pages: EditPage[],
  layer: Layer,
  p: number,
  z: number,
) =>
  layer === "measures"
    ? `Measure ${pages[p].zones[z].label}`
    : `${layer === "grandstaves" ? "Grand staff" : "Staff"} ${z + 1}`;
