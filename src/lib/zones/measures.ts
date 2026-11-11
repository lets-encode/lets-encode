// The measures of the edit pages: their labels in reading order, their
// break and section flags, their repeats, endings and signs, and the names
// these take in titles and accessible labels.

import {
  readingOrderRows,
  measureLabels,
  SIGN_TEXT,
  type MeasureBox,
  type MeasureSign,
} from "../mei-facsimile.ts";
import type { EditPage, EditZone } from "./edit-pages.ts";

// The page break is derived from position (each page's first measure). A page
// break implies a system break, so on a page's first measure the system flag
// is fixed on and the button is disabled. The score's first measure always
// opens the first movement, so its section flag is fixed on too.
export const pbAt = (z: number) => z === 0;
export const sbActive = (pages: EditPage[], p: number, z: number) =>
  pbAt(z) || pages[p].zones[z].sb;
export const sectionLocked = (p: number, z: number) => p === 0 && z === 0;

// Whether a zone starts a movement in the emitted MEI (the very first
// measure always opens the first one).
export const startsMovement = (pages: EditPage[], p: number, z: number) =>
  sectionLocked(p, z) || (pages[p].zones[z].mdiv && (p > 0 || z > 0));

// Every measure in reading order with what its label is computed from.
export const numbering = (pages: EditPage[]) =>
  pages.flatMap((pg, p) =>
    pg.zones.map((zone, z) => ({
      zone,
      override: zone.override,
      pickup: zone.pickup,
      sectionStart: startsMovement(pages, p, z),
    })),
  );

// Recompute every label from reading order, sections, pickups and
// overrides ("10a" continues as 11).
export function renumber(pages: EditPage[]) {
  const measures = numbering(pages);
  const labels = measureLabels(measures);
  measures.forEach((m, i) => (m.zone.label = labels[i]));
}

// The first box of every reading-order row of a page but its first row,
// whose first box carries the page break.
export function rowStarts(pages: EditPage[], p: number): Set<MeasureBox> {
  const rows = readingOrderRows(pages[p].zones.map((z) => z.box));
  return new Set(rows.slice(1).map((row) => row[0]));
}

// Re-sort a page's zones into reading order (after geometry changed), set
// its system beginnings from the rows where none was set by hand, then
// renumber everything.
export function resort(pages: EditPage[], p: number) {
  const zones = pages[p].zones;
  const byBox = new Map(zones.map((z) => [z.box, z]));
  const rows = readingOrderRows(zones.map((z) => z.box));
  pages[p].zones = rows.flat().map((box) => byBox.get(box)!);
  const starts = new Set(rows.slice(1).map((row) => row[0]));
  for (const zone of pages[p].zones) {
    zone.sb = zone.sbOverride ?? starts.has(zone.box);
  }
  renumber(pages);
}

// Staff and grand-staff boxes are kept top to bottom, then left to right.
export function resortStaves(
  pages: EditPage[],
  p: number,
  layer: "staves" | "grandstaves" = "staves",
) {
  pages[p][layer].sort(
    (a, b) => a.box.uly - b.box.uly || a.box.ulx - b.box.ulx,
  );
}

export const SIGN_NAME: Record<MeasureSign, string> = {
  segno: "Segno",
  coda: "Coda",
  daCapo: SIGN_TEXT.daCapo,
  dalSegno: SIGN_TEXT.dalSegno,
  fine: SIGN_TEXT.fine,
  toCoda: SIGN_TEXT.toCoda,
};
export const SIGN_TITLE: Record<MeasureSign, string> = {
  segno: "The segno sign at the start of this measure",
  coda: "The coda sign at the start of this measure",
  daCapo: "Da capo at the end of this measure: back to the beginning",
  dalSegno: "Dal segno at the end of this measure: back to the segno",
  fine: "Fine at the end of this measure: the end of the piece after a repeat",
  toCoda: "To Coda at the end of this measure: on to the coda",
};
// The repeats, ending and signs of a measure, for its title and the
// read-only panel.
export const markNames = (zone: EditZone) => {
  return [
    zone.rptStart ? "Repeat start" : "",
    zone.rptEnd ? "Repeat end" : "",
    zone.rptBoth ? "Double repeat" : "",
    zone.ending ? `Ending ${zone.ending}` : "",
    ...(zone.signs ?? []).map((s) => SIGN_NAME[s]),
  ].filter(Boolean);
};

// Hover tooltip naming a measure's breaks and pickup flag, if it has any.
// On the page a system start shows as a blue bracket in the label, a
// section start as a double bar there, repeats as their signs in the
// label or a label at the top right, an ending as a bracket over its
// measures and the signs as tags at the bottom right.
export const zoneTitle = (pages: EditPage[], p: number, z: number) =>
  [
    startsMovement(pages, p, z) ? "Starts a section" : "",
    pages[p].zones[z].pickup ? "Pickup" : "",
    pbAt(z)
      ? "First measure on the page: starts a system"
      : pages[p].zones[z].sb
        ? "Starts a system"
        : "",
    ...markNames(pages[p].zones[z]),
  ]
    .filter(Boolean)
    .join(" · ");

// A page's endings as runs of consecutive measures with the same ending in
// one system: their extent, number, and whether the bracket closes at the
// end (it stays open on an ending no other ending follows).
export function endingRuns(pages: EditPage[], p: number) {
  const zones = pages[p].zones;
  const runs: {
    ulx: number;
    uly: number;
    lrx: number;
    n: string;
    closed: boolean;
  }[] = [];
  zones.forEach((zone, z) => {
    if (!zone.ending) return;
    const prev = runs[runs.length - 1];
    const joins =
      prev &&
      z > 0 &&
      zones[z - 1].ending === zone.ending &&
      !sbActive(pages, p, z);
    if (joins) {
      prev.lrx = zone.box.lrx;
      prev.uly = Math.min(prev.uly, zone.box.uly);
    } else
      runs.push({
        ulx: zone.box.ulx,
        uly: zone.box.uly,
        lrx: zone.box.lrx,
        n: zone.ending,
        closed: true,
      });
    // Another ending after this one closes it; the same ending going on in
    // the next system leaves it open there.
    const next = zones[z + 1] ?? pages[p + 1]?.zones[0];
    runs[runs.length - 1].closed =
      !!next?.ending && next.ending !== zone.ending;
  });
  return runs;
}
