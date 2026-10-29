// Aligning an uploaded encoding with a piece's corrected layout: which measure
// of the file belongs in which measure of the layout skeleton, which layout
// measures the file lacks, and which file measures have no place on the page.
// The layout defines the structure; the file supplies content.
//
// Both sides are read as measure sequences with the same reader. They are
// aligned globally (Needleman–Wunsch), with a gap allowed on either side, on
// structural features only: system and page starts, repeat barlines, endings,
// pickups, and measure labels where the file's numbering has jumps. Where
// several alignments score the same, the stretch is reported as ambiguous.
//
// Pure functions: MEI text in, plain data out. No DOM, forge or network access.

import { parseScoreDef } from "./mei-facsimile.ts";
import { elementsNamed, startTags, tagsIn, xmlUnescape } from "./mei-xml.ts";

/** One measure of an MEI document, with the features the alignment compares. */
export interface MeasureInfo {
  /** The measure's xml:id; '' when it carries none. */
  id: string;
  /** Its `@n`; '' when it carries none. */
  label: string;
  /** Offsets of the `<measure>` element in the document. */
  start: number;
  end: number;
  /** Whether a `<sb>` or `<pb>` precedes it; true for the first measure. */
  systemStart: boolean;
  /** Whether a `<pb>` precedes it; true for the first measure. */
  pageStart: boolean;
  /** A repeat start at its left barline, or a double repeat at the previous measure's right. */
  rptStart: boolean;
  /** A repeat end at its right barline (`rptend` or `rptboth`). */
  rptEnd: boolean;
  /** The `@n` of the `<ending>` it stands in; null outside endings. */
  ending: string | null;
  /** `@metcon="false"`: a pickup. */
  pickup: boolean;
  /** How many measures it stands for: a `<multiRest>`'s `@num`, else 1. */
  span: number;
  /** Per staff `@n`, how many events (notes, chords, rests …) it holds. */
  events: Map<number, number>;
  /**
   * Score-definition changes between the previous measure and this one, as
   * written: `<scoreDef>` and stand-alone `<staffDef>` elements.
   */
  leading: string[];
}

/** The tags counted as a staff's events. `<space>` is not one. */
const EVENTS = new Set([
  "note",
  "chord",
  "rest",
  "mRest",
  "multiRest",
  "mRpt",
  "mRpt2",
  "beatRpt",
  "halfmRpt",
  "multiRpt",
]);

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name.replace(".", "\\.")}="([^"]*)"`).exec(tag);
  return m ? xmlUnescape(m[1]) : null;
};

/** The end offset of the element whose start tag ends at `tagEnd`. */
function elementEnd(xml: string, name: string, tagEnd: number): number {
  const close = `</${name}>`;
  const at = xml.indexOf(close, tagEnd);
  return at < 0 ? tagEnd : at + close.length;
}

/** How many events each staff of a measure's content holds, by staff `@n`. */
function staffEvents(inner: string): Map<number, number> {
  const events = new Map<number, number>();
  let position = 0;
  for (const staff of elementsNamed(inner, "staff", true)) {
    position++;
    const n = Number(attr(staff.tag, "n") ?? position);
    let count = 0;
    for (const tag of tagsIn(staff.inner))
      if (tag.kind !== "end" && EVENTS.has(tag.name)) count++;
    events.set(n, (events.get(n) ?? 0) + count);
  }
  return events;
}

/**
 * The measures of an MEI document's `<body>` in document order, with the
 * breaks, endings and score-definition changes around them.
 */
export function readMeasures(mei: string): MeasureInfo[] {
  const bodyAt = mei.indexOf("<body");
  const measures: MeasureInfo[] = [];
  if (bodyAt < 0) return measures;
  let systemStart = true;
  let pageStart = true;
  let ending: string | null = null;
  let leading: string[] = [];
  let previousRight = "";
  let at = bodyAt;
  scan: for (;;) {
    for (const tag of tagsIn(mei, at)) {
      if (tag.name === "body" && tag.kind === "end") break scan;
      if (tag.kind === "end") {
        if (tag.name === "ending") ending = null;
        continue;
      }
      const text = mei.slice(tag.start, tag.end);
      if (tag.name === "pb") pageStart = systemStart = true;
      else if (tag.name === "sb") systemStart = true;
      else if (tag.name === "ending")
        ending = attr(text, "n") ?? attr(text, "label") ?? "";
      else if (tag.name === "scoreDef" || tag.name === "staffDef") {
        const end =
          tag.kind === "empty" ? tag.end : elementEnd(mei, tag.name, tag.end);
        leading.push(mei.slice(tag.start, end));
        at = end;
        continue scan;
      } else if (tag.name === "measure") {
        const end =
          tag.kind === "empty" ? tag.end : elementEnd(mei, "measure", tag.end);
        const inner = tag.kind === "empty" ? "" : mei.slice(tag.end, end - 10);
        const multiRest = [...startTags(inner, "multiRest")][0]?.tag;
        const right = attr(text, "right") ?? "";
        measures.push({
          id: attr(text, "xml:id") ?? "",
          label: attr(text, "n") ?? "",
          start: tag.start,
          end,
          systemStart,
          pageStart,
          rptStart:
            attr(text, "left") === "rptstart" || previousRight === "rptboth",
          rptEnd: right === "rptend" || right === "rptboth",
          ending,
          pickup: attr(text, "metcon") === "false",
          span: Math.max(1, Number(multiRest && attr(multiRest, "num")) || 1),
          events: staffEvents(inner),
          leading,
        });
        previousRight = right;
        systemStart = pageStart = false;
        leading = [];
        at = end;
        continue scan;
      }
    }
    break;
  }
  return measures;
}

/**
 * How many measures an encoding has (a multi-measure rest counted as the
 * measures it stands for), how many staves its score definition gives, and
 * how many of the measures leave one of those staves without events.
 */
export function encodingSize(mei: string): {
  measures: number;
  staves: number;
  withEmptyStaff: number;
} {
  const measures = readMeasures(mei);
  const staves = parseScoreDef(mei).staves.length;
  const gap = (m: MeasureInfo) =>
    Array.from({ length: staves }, (_, s) => m.events.get(s + 1) ?? 0).some(
      (count) => count === 0,
    );
  const count = (list: MeasureInfo[]) =>
    list.reduce((sum, m) => sum + m.span, 0);
  return {
    measures: count(measures),
    staves,
    withEmptyStaff: count(measures.filter(gap)),
  };
}

/** Whether a measure holds no events on any staff. */
export const isEmpty = (measure: MeasureInfo): boolean =>
  [...measure.events.values()].every((count) => count === 0);

/** One measure's worth of a file measure: `part` counts within a multi-measure rest. */
export interface FileSlot {
  measure: number;
  part: number;
}

export interface Alignment {
  /** Per layout measure, the file slot placed in it, or null. */
  matches: (FileSlot | null)[];
  /** File slots placed in no layout measure. */
  unplaced: FileSlot[];
  /**
   * Layout measures whose file slot differs between alignments of equal
   * score: the structure alone does not decide them.
   */
  ambiguous: number[];
  /** Per layout measure, whether its match contradicts a structural feature. */
  conflicts: boolean[];
}

/** Score of a match before features; a gap on either side costs GAP. */
const MATCH = 1;
const GAP = -1;

/** The file measures expanded to one slot per measure they stand for. */
function slotsOf(file: MeasureInfo[]): FileSlot[] {
  return file.flatMap((measure, m) =>
    Array.from({ length: measure.span }, (_, part) => ({ measure: m, part })),
  );
}

/**
 * Whether the file's numbering carries information about gaps: a label
 * further than one from the previous. A plain 1, 2, 3 … run says nothing
 * about where missing measures were.
 */
function labelsHaveJumps(file: MeasureInfo[]): boolean {
  return file.some((measure, i) => {
    if (i === 0) return false;
    const previous = parseInt(file[i - 1].label, 10);
    const current = parseInt(measure.label, 10);
    return (
      !Number.isNaN(previous) &&
      !Number.isNaN(current) &&
      current - previous - (file[i - 1].span - 1) > 1
    );
  });
}

interface Features {
  breaks: boolean;
  pages: boolean;
  labels: boolean;
}

/**
 * The structural score of placing `slot` in `box`, and whether any feature
 * contradicts the placement.
 */
function matchScore(
  box: MeasureInfo,
  file: MeasureInfo[],
  slot: FileSlot,
  features: Features,
): { score: number; conflict: boolean } {
  const measure = file[slot.measure];
  const first = slot.part === 0;
  const last = slot.part === measure.span - 1;
  let score = MATCH;
  let conflict = false;
  const compare = (a: boolean, b: boolean, weight: number) => {
    if (a && b) score += weight;
    else if (a !== b) {
      score -= weight;
      conflict = true;
    }
  };
  if (features.labels && first && box.label === measure.label) score += 1;
  if (features.breaks)
    compare(box.systemStart, first && measure.systemStart, 1);
  if (features.pages) compare(box.pageStart, first && measure.pageStart, 0.5);
  compare(box.rptStart, first && measure.rptStart, 1);
  compare(box.rptEnd, last && measure.rptEnd, 1);
  if (box.ending !== measure.ending) {
    score -= 0.5;
    conflict = true;
  } else if (box.ending !== null) score += 0.5;
  if (box.pickup !== (first && measure.pickup)) {
    score -= 0.5;
    conflict = true;
  }
  return { score, conflict };
}

/**
 * A link the volunteer fixed: the layout measure `box` holds the file slot
 * `slot`, or stays empty (null).
 */
export interface Pin {
  box: number;
  slot: FileSlot | null;
}

/**
 * The optimal alignment of `boxes` (layout measure indices) with `slots`
 * (slot indices), both in order, under `score`: per box the slot index it
 * holds, traced twice, with gaps placed as late (`late`) and as early
 * (`early`) as the optimum allows. A box in `empty` takes no slot.
 */
function alignStretch(
  boxes: number[],
  slots: number[],
  score: (box: number, slot: number) => number,
  empty: Set<number>,
): { late: (number | null)[]; early: (number | null)[] } {
  const n = boxes.length;
  const m = slots.length;
  const width = m + 1;
  const best = new Float64Array((n + 1) * width);
  const pair = new Float64Array(n * Math.max(1, m));
  for (let i = 1; i <= n; i++) best[i * width] = i * GAP;
  for (let j = 1; j <= m; j++) best[j] = j * GAP;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const s = empty.has(boxes[i - 1])
        ? -Infinity
        : score(boxes[i - 1], slots[j - 1]);
      pair[(i - 1) * m + (j - 1)] = s;
      best[i * width + j] = Math.max(
        best[(i - 1) * width + (j - 1)] + s,
        best[(i - 1) * width + j] + GAP,
        best[i * width + (j - 1)] + GAP,
      );
    }
  const trace = (gapsFirst: boolean): (number | null)[] => {
    const matches: (number | null)[] = new Array(n).fill(null);
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      const here = best[i * width + j];
      const diagonal =
        i > 0 &&
        j > 0 &&
        here === best[(i - 1) * width + (j - 1)] + pair[(i - 1) * m + (j - 1)];
      const up = i > 0 && here === best[(i - 1) * width + j] + GAP;
      const left = j > 0 && here === best[i * width + (j - 1)] + GAP;
      if (diagonal && (!gapsFirst || (!up && !left))) {
        i--;
        j--;
        matches[i] = slots[j];
      } else if (up) i--;
      else j--;
    }
    return matches;
  };
  return { late: trace(true), early: trace(false) };
}

/**
 * Align the file's measures with the layout's. Every layout measure gets at
 * most one file slot and every slot at most one layout measure, in order.
 * `pins` fix links: a pinned pair is kept and the stretches between pinned
 * pairs are aligned on their own; a box pinned empty takes no slot. A pin
 * out of order with an earlier one is ignored.
 */
export function alignMeasures(
  layout: MeasureInfo[],
  file: MeasureInfo[],
  pins: Pin[] = [],
): Alignment {
  const slots = slotsOf(file);
  const features: Features = {
    // The first measure always starts a system and a page; a file with no
    // break after it carries no layout information.
    breaks: file.slice(1).some((measure) => measure.systemStart),
    pages: file.slice(1).some((measure) => measure.pageStart),
    labels: labelsHaveJumps(file),
  };
  const n = layout.length;
  const m = slots.length;
  const slotIndex = (slot: FileSlot) =>
    slots.findIndex((s) => s.measure === slot.measure && s.part === slot.part);
  const anchors: [number, number][] = [];
  for (const pin of [...pins].sort((a, b) => a.box - b.box)) {
    const j = pin.slot ? slotIndex(pin.slot) : -1;
    const last = anchors.at(-1);
    if (j >= 0 && pin.box < n && (!last || (pin.box > last[0] && j > last[1])))
      anchors.push([pin.box, j]);
  }
  const empty = new Set(
    pins.filter((pin) => pin.slot === null).map((pin) => pin.box),
  );
  const score = (i: number, j: number) =>
    matchScore(layout[i], file, slots[j], features).score;

  // The result places gaps late: a partly encoded file more often stops early
  // than starts late.
  const late: (number | null)[] = new Array(n).fill(null);
  const early: (number | null)[] = new Array(n).fill(null);
  const bounds: [number, number][] = [[-1, -1], ...anchors, [n, m]];
  for (let k = 1; k < bounds.length; k++) {
    const [i0, j0] = bounds[k - 1];
    const [i1, j1] = bounds[k];
    if (k < bounds.length - 1) late[i1] = early[i1] = j1;
    const boxes = Array.from({ length: i1 - i0 - 1 }, (_, d) => i0 + 1 + d);
    const stretch = alignStretch(
      boxes,
      Array.from({ length: j1 - j0 - 1 }, (_, d) => j0 + 1 + d),
      score,
      empty,
    );
    boxes.forEach((i, d) => {
      late[i] = stretch.late[d];
      early[i] = stretch.early[d];
    });
  }

  const placed = new Set(late.filter((j): j is number => j !== null));
  return {
    matches: late.map((j) => (j === null ? null : slots[j])),
    unplaced: slots.filter((_, j) => !placed.has(j)),
    ambiguous: late.flatMap((j, i) => (j === early[i] ? [] : [i])),
    conflicts: late.map(
      (j, i) =>
        j !== null && matchScore(layout[i], file, slots[j], features).conflict,
    ),
  };
}

/** The alignment record's path for a score: `alignment.json` in the score's directory. */
export const alignmentPath = (fragment: string): string =>
  `${fragment.slice(0, fragment.lastIndexOf("/") + 1)}alignment.json`;

export const ALIGNMENT_RECORD_NOTE =
  "Where the uploaded encoding's measures were placed. Indices are 0-based: layout measures in score order, file measures in the uploaded file's order, part within a multi-measure rest. pins are the links fixed by hand; matches the resulting placement per layout measure; staves the layout staff per file staff.";

/** The alignment record as `alignment.json` is written. */
export function alignmentRecord(
  pins: Pin[],
  alignment: Alignment,
  staffMap: (number | null)[],
): string {
  const slot = (s: FileSlot | null) => (s ? [s.measure, s.part] : null);
  return (
    JSON.stringify(
      {
        note: ALIGNMENT_RECORD_NOTE,
        pins: pins.map((pin) => [pin.box, slot(pin.slot)]),
        matches: alignment.matches.map(slot),
        staves: staffMap,
      },
      null,
      "\t",
    ) + "\n"
  );
}

/** The pins of an alignment record; none when it is absent or unreadable. */
export function pinsOf(record: string | null): Pin[] {
  try {
    const pins = JSON.parse(record ?? "null")?.pins;
    if (!Array.isArray(pins)) return [];
    return pins.flatMap((pin): Pin[] => {
      if (!Array.isArray(pin) || !Number.isInteger(pin[0])) return [];
      const slot = pin[1];
      if (slot === null) return [{ box: pin[0], slot: null }];
      return Array.isArray(slot) &&
        Number.isInteger(slot[0]) &&
        Number.isInteger(slot[1])
        ? [{ box: pin[0], slot: { measure: slot[0], part: slot[1] } }]
        : [];
    });
  } catch {
    return [];
  }
}

/**
 * Why an alignment of kind "different" cannot be submitted, for the editor
 * and the submission alike.
 */
export function differentReason(summary: AlignmentSummary): string {
  return (
    `The uploaded encoding does not fit this piece's measures: ` +
    `${summary.unplaced} of its measures have no place and ` +
    `${summary.conflicts} placements contradict repeats, endings or breaks. ` +
    `The campaign organiser decides how to go on.`
  );
}

/** What the alignment says about the file as a whole. */
export type AlignmentKind = "complete" | "partial" | "different";

/**
 * More unplaced file measures than this share of the layout's measures marks
 * the file as a different version.
 */
export const DIFFERENT_UNPLACED_SHARE = 0.1;
/**
 * More matches contradicting a structural feature than this share of the
 * matches marks the file as a different version.
 */
export const DIFFERENT_CONFLICT_SHARE = 0.25;

export interface AlignmentSummary {
  kind: AlignmentKind;
  /** Layout measures with a file measure that holds events. */
  filled: number;
  /** Layout measures with no file measure, or an empty one. */
  empty: number;
  /** File measures (slots) with no layout measure. */
  unplaced: number;
  /** Matches contradicting a structural feature. */
  conflicts: number;
}

/**
 * Complete: every layout measure has a file measure with events and every
 * file measure has a place. Different: too many file measures without a place
 * or too many contradicting matches. Partial otherwise.
 */
export function summariseAlignment(
  file: MeasureInfo[],
  alignment: Alignment,
): AlignmentSummary {
  const filled = alignment.matches.filter(
    (slot) => slot !== null && !isEmpty(file[slot.measure]),
  ).length;
  const matched = alignment.matches.filter((slot) => slot !== null).length;
  const unplaced = alignment.unplaced.length;
  const conflicts = alignment.conflicts.filter(Boolean).length;
  const boxes = alignment.matches.length;
  const kind: AlignmentKind =
    unplaced > boxes * DIFFERENT_UNPLACED_SHARE ||
    conflicts > matched * DIFFERENT_CONFLICT_SHARE
      ? "different"
      : filled === boxes && unplaced === 0
        ? "complete"
        : "partial";
  return { kind, filled, empty: boxes - filled, unplaced, conflicts };
}

/**
 * Which layout staff each file staff goes to (by position, 0-based in, 1-based
 * out), or null for a file staff with no place. With the layout's clefs, staves
 * with equal clefs are paired in order (longest common subsequence) and the
 * staves between two pairs are paired in order as far as both sides have
 * them; without, staff k goes to staff k.
 */
export function mapStaves(
  fileClefs: string[],
  layoutCount: number,
  layoutClefs?: string[],
): (number | null)[] {
  if (!layoutClefs || layoutClefs.length !== layoutCount)
    return fileClefs.map((_, s) => (s < layoutCount ? s + 1 : null));
  const a = fileClefs.length;
  const b = layoutCount;
  const lcs = Array.from({ length: a + 1 }, () => new Array(b + 1).fill(0));
  for (let s = a - 1; s >= 0; s--)
    for (let t = b - 1; t >= 0; t--)
      lcs[s][t] =
        fileClefs[s] === layoutClefs[t]
          ? lcs[s + 1][t + 1] + 1
          : Math.max(lcs[s + 1][t], lcs[s][t + 1]);
  const anchors: [number, number][] = [];
  for (let s = 0, t = 0; s < a && t < b; ) {
    if (fileClefs[s] === layoutClefs[t] && lcs[s][t] === lcs[s + 1][t + 1] + 1)
      anchors.push([s++, t++]);
    else if (lcs[s + 1][t] >= lcs[s][t + 1]) s++;
    else t++;
  }
  const map: (number | null)[] = new Array(a).fill(null);
  let s0 = 0;
  let t0 = 0;
  for (const [s, t] of [...anchors, [a, b] as [number, number]]) {
    for (let k = 0; s0 + k < s && t0 + k < t; k++) map[s0 + k] = t0 + k + 1;
    if (s < a) map[s] = t + 1;
    s0 = s + 1;
    t0 = t + 1;
  }
  return map;
}

/**
 * Layout measure indices written as ranges of their labels: "1–40, 45–64".
 * Indices next to each other form one range.
 */
export function labelRanges(layout: MeasureInfo[], indices: number[]): string {
  const runs: [number, number][] = [];
  for (const i of [...indices].sort((x, y) => x - y)) {
    const last = runs.at(-1);
    if (last && i === last[1] + 1) last[1] = i;
    else runs.push([i, i]);
  }
  const label = (i: number) => layout[i].label || String(i + 1);
  return runs
    .map(([from, to]) =>
      from === to ? label(from) : `${label(from)}–${label(to)}`,
    )
    .join(", ");
}
