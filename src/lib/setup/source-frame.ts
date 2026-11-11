// The score setup's source side: the first measure's page, framed on the
// measure and the names in front of its system, and the line-up of the
// source's first system with the preview's staves.

import type { PageModel } from "../mei-facsimile.ts";
import { pageSystems } from "../omr-layout.ts";

/**
 * The first measure is the first zone of the first page with zones. Its
 * staves (`anchor`) run from the system's first staff to its last where the
 * layout has staff boxes (an OMR-prepared piece), else over the measure's
 * zone. The frame takes in the page from its left edge to the measure's end
 * and the staves with room above and below: 0.6 of a staff box's height, or
 * a tenth of the zone's.
 */
export function firstMeasureOf(pages: PageModel[] | undefined) {
  const i = pages?.findIndex((p) => p.zones.length > 0) ?? -1;
  if (!pages || i < 0) return null;
  const pg = pages[i];
  const box = pg.zones[0].box;
  const system = pg.staves?.length ? pageSystems(pg).systems[0] : undefined;
  const staffBoxes = system?.length ? system : null;
  const anchor = staffBoxes
    ? { uly: staffBoxes[0].uly, lry: staffBoxes[staffBoxes.length - 1].lry }
    : { uly: box.uly, lry: box.lry };
  const pad = staffBoxes
    ? (0.6 * staffBoxes.reduce((sum, b) => sum + b.lry - b.uly, 0)) /
      staffBoxes.length
    : 0.1 * (box.lry - box.uly);
  return {
    page: i,
    box,
    staves: staffBoxes,
    anchor,
    frame: {
      ulx: 0,
      uly: Math.max(0, anchor.uly - pad),
      lrx: Math.min(pg.width, box.lrx + pad / 2),
      lry: Math.min(pg.height, anchor.lry + pad),
    },
  };
}

export type FirstMeasure = NonNullable<ReturnType<typeof firstMeasureOf>>;

// Like for like: the source's first system is scaled and placed so its
// staves line up with the preview's. With as many staves on both sides
// the first and last staves meet; otherwise the staff spacing is matched,
// from the first staff down.
export type StaffSpan = {
  top: number;
  lastTop: number;
  bottom: number;
  count: number;
};

/** The source's staves as image heights and the preview heights they
    meet, `top` being the preview's first staff. */
export function staffMatch(p: StaffSpan, fm: FirstMeasure) {
  const boxes = fm.staves;
  if (!boxes || boxes.length === p.count || boxes.length < 2 || p.count < 2)
    return { ...fm.anchor, top: p.top, bottom: p.bottom };
  const scale =
    (p.lastTop - p.top) /
    (p.count - 1) /
    ((boxes[boxes.length - 1].uly - boxes[0].uly) / (boxes.length - 1));
  return {
    ...fm.anchor,
    top: p.top,
    bottom: p.top + (fm.anchor.lry - fm.anchor.uly) * scale,
  };
}
