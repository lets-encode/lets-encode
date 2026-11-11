// Aligning an uploaded encoding with a piece's corrected layout: which measure
// of the file belongs in which measure of the layout skeleton, which layout
// measures the file lacks, and which file measures have no place on the page.
// The layout defines the structure; the file supplies content.
//
// Both sides are read as measure sequences with the same reader. They are
// aligned globally (Needleman–Wunsch), with a gap allowed on either side, on
// structural features only: system and page starts, repeat barlines, endings,
// pickups, and measure labels where the file's numbering has jumps. System and
// page starts only decide between alignments the other features score the
// same. Where several alignments score the same, the stretch is reported as
// ambiguous.
//
// Pure functions: MEI text in, plain data (or, for the file measure edits, MEI
// text) out. No DOM, forge or network access.

import { parseScoreDef } from "./mei-facsimile.ts";
import {
  elementsNamed,
  startTags,
  tagAttribute,
  tagsIn,
  xmlEscape,
} from "./mei-xml.ts";

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
    const n = Number(tagAttribute(staff.tag, "n") ?? position);
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
        ending = tagAttribute(text, "n") ?? tagAttribute(text, "label") ?? "";
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
        const right = tagAttribute(text, "right") ?? "";
        measures.push({
          id: tagAttribute(text, "xml:id") ?? "",
          label: tagAttribute(text, "n") ?? "",
          start: tag.start,
          end,
          systemStart,
          pageStart,
          rptStart:
            tagAttribute(text, "left") === "rptstart" ||
            previousRight === "rptboth",
          rptEnd: right === "rptend" || right === "rptboth",
          ending,
          pickup: tagAttribute(text, "metcon") === "false",
          span: Math.max(
            1,
            Number(multiRest && tagAttribute(multiRest, "num")) || 1,
          ),
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
 * contradicts the placement. System and page starts are scored and
 * contradicted apart (`breaks`, `breakConflict`), since a file's breaks may be
 * an engraver's rather than the source's.
 */
function matchScore(
  box: MeasureInfo,
  file: MeasureInfo[],
  slot: FileSlot,
  features: Features,
): {
  score: number;
  breaks: number;
  conflict: boolean;
  breakConflict: boolean;
} {
  const measure = file[slot.measure];
  const first = slot.part === 0;
  const last = slot.part === measure.span - 1;
  let score = MATCH;
  let conflict = false;
  let breaks = 0;
  let breakConflict = false;
  const compare = (a: boolean, b: boolean, weight: number) => {
    if (a && b) score += weight;
    else if (a !== b) {
      score -= weight;
      conflict = true;
    }
  };
  const compareBreak = (a: boolean, b: boolean, weight: number) => {
    if (a && b) breaks += weight;
    else if (a !== b) {
      breaks -= weight;
      breakConflict = true;
    }
  };
  if (features.labels && first && box.label === measure.label) score += 1;
  if (features.breaks)
    compareBreak(box.systemStart, first && measure.systemStart, 1);
  if (features.pages)
    compareBreak(box.pageStart, first && measure.pageStart, 0.5);
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
  return { score, breaks, conflict, breakConflict };
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
 * Changes to the uploaded file's measure sequence before alignment, keyed by
 * the xml:ids the file's measures carry once every element has one
 * (addXmlIds with prefix "u-"): `removed` file measures are taken out; each
 * `added` entry is an empty measure `id` inserted directly after the measure
 * `after` (a file measure or another added one; null: before the first).
 * Several additions after the same measure stand in list order.
 */
export interface FileEdits {
  removed: string[];
  added: { after: string | null; id: string }[];
}

/** An xml:id for a new added file measure, unused by the additions in `edits`. */
export function addedFileMeasureId(edits: FileEdits): string {
  const taken = new Set(edits.added.map((a) => a.id));
  let k = 1;
  while (taken.has(`added-measure-${k}`)) k++;
  return `added-measure-${k}`;
}

/**
 * The measures added after each file measure of `ids` (null: before the
 * first), in order, each followed by those added after it. Additions naming
 * no measure are left out.
 */
function addedRuns(
  ids: string[],
  edits: FileEdits,
): Map<string | null, string[]> {
  const written = new Set<string>();
  const addedAfter = (id: string | null): string[] =>
    edits.added.flatMap((a) => {
      if (a.after !== id || written.has(a.id)) return [];
      written.add(a.id);
      return [a.id, ...addedAfter(a.id)];
    });
  return new Map([null, ...ids].map((id) => [id, addedAfter(id)]));
}

/**
 * The file's measure xml:ids after `edits`, from `ids`, the measures' xml:ids
 * before any edit. Edits naming no measure are left out.
 */
export function editedFileIds(ids: string[], edits: FileEdits): string[] {
  const removed = new Set(edits.removed);
  const runs = addedRuns(ids, edits);
  return [
    ...runs.get(null)!,
    ...ids.flatMap((id) => [
      ...(removed.has(id) ? [] : [id]),
      ...runs.get(id)!,
    ]),
  ];
}

/**
 * The uploaded file (with an xml:id on every element) after `edits`: each
 * removed `<measure>` taken out, each added one written in its place as an
 * empty measure without a label, holding one empty staff per staff of the
 * file's score definition. Edits naming no measure are ignored.
 */
export function applyFileEdits(upload: string, edits: FileEdits): string {
  if (!edits.removed.length && !edits.added.length) return upload;
  const measures = readMeasures(upload);
  const removed = new Set(edits.removed);
  const runs = addedRuns(
    measures.map((m) => m.id),
    edits,
  );
  const staves = Array.from(
    { length: Math.max(1, parseScoreDef(upload).staves.length) },
    (_, k) => `<staff n="${k + 1}"><layer n="1"/></staff>`,
  ).join("");
  const empty = (ids: string[]) =>
    ids
      .map((id) => `<measure xml:id="${xmlEscape(id)}">${staves}</measure>`)
      .join("");
  let out = "";
  let last = 0;
  measures.forEach((measure, i) => {
    out +=
      upload.slice(last, measure.start) +
      (i === 0 ? empty(runs.get(null)!) : "") +
      (removed.has(measure.id)
        ? ""
        : upload.slice(measure.start, measure.end)) +
      empty(runs.get(measure.id)!);
    last = measure.end;
  });
  return out + upload.slice(last);
}

/**
 * The pins with their file measures moved from the file edits `from` to
 * `to`, `ids` being the file's measure xml:ids before any edit. A pin whose
 * file measure is gone under `to` is dropped.
 */
export function shiftPins(
  pins: Pin[],
  ids: string[],
  from: FileEdits,
  to: FileEdits,
): Pin[] {
  const before = editedFileIds(ids, from);
  const after = editedFileIds(ids, to);
  return pins.flatMap((pin) => {
    if (!pin.slot) return [pin];
    const measure = after.indexOf(before[pin.slot.measure]);
    return measure < 0
      ? []
      : [{ box: pin.box, slot: { ...pin.slot, measure } }];
  });
}

/**
 * The file edits with an empty measure added directly before or after the
 * measure `index` of the edited file, `ids` being the edited file's measure
 * xml:ids (editedFileIds).
 */
export function addFileMeasure(
  edits: FileEdits,
  ids: string[],
  index: number,
  side: "before" | "after",
): FileEdits {
  const after =
    side === "after" ? ids[index] : index > 0 ? ids[index - 1] : null;
  // The additions after `after` follow it directly; the new one goes first.
  const added = [...edits.added];
  const at = added.findIndex((a) => a.after === after);
  added.splice(at < 0 ? added.length : at, 0, {
    after,
    id: addedFileMeasureId(edits),
  });
  return { removed: edits.removed, added };
}

/**
 * The file edits without the added measure `id`; the measures added after
 * it take its place.
 */
export function withoutAddedMeasure(edits: FileEdits, id: string): FileEdits {
  const gone = edits.added.find((a) => a.id === id);
  if (!gone) return edits;
  return {
    removed: edits.removed,
    added: edits.added.flatMap((a) =>
      a.id === id
        ? edits.added
            .filter((c) => c.after === id)
            .map((c) => ({ after: gone.after, id: c.id }))
        : a.after === id
          ? []
          : [a],
    ),
  };
}

/**
 * The score staves (file staff per score staff, null for an empty staff)
 * with file staff `staff`, or none, at score staff `row`; where that file
 * staff stood at another score staff, the two swap their file staves.
 */
export function chooseScoreStaff(
  list: (number | null)[],
  row: number,
  staff: number | null,
): (number | null)[] {
  const next = [...list];
  const other = staff === null ? -1 : next.indexOf(staff);
  if (other >= 0) next[other] = next[row];
  next[row] = staff;
  return next;
}

/** The file staves (1-based, of `count`) the score staves leave out. */
export const unusedFileStaves = (
  list: (number | null)[],
  count: number,
): number[] =>
  Array.from({ length: count }, (_, s) => s + 1).filter(
    (s) => !list.includes(s),
  );

/**
 * The score staves with file staff `staff` in the first empty score staff,
 * else, with `append`, as a new last one; null when it has no place.
 */
export function placeFileStaff(
  list: (number | null)[],
  staff: number,
  append: boolean,
): (number | null)[] | null {
  const empty = list.indexOf(null);
  if (empty >= 0) return chooseScoreStaff(list, empty, staff);
  return append ? [...list, staff] : null;
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
  // System and page starts decide only between placements the other features
  // score the same: their weight keeps their sum over every box below half the
  // smallest step of the other scores (0.5). A power of two keeps the sums
  // exact, so equal placements stay equal.
  const breakWeight = 2 ** -Math.ceil(Math.log2(8 * (Math.min(n, m) + 1)));
  const score = (i: number, j: number) => {
    const s = matchScore(layout[i], file, slots[j], features);
    return s.score + breakWeight * s.breaks;
  };

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

  // A break contradicts a placement only when most of the file's placed system
  // starts fall on the layout's; otherwise the file's breaks are an engraver's.
  let starts = 0;
  let agreeing = 0;
  late.forEach((j, i) => {
    if (j === null) return;
    const slot = slots[j];
    if (slot.part !== 0 || slot.measure === 0) return;
    if (!file[slot.measure].systemStart) return;
    starts++;
    if (layout[i].systemStart) agreeing++;
  });
  const sourceBreaks = agreeing * 2 > starts;

  const placed = new Set(late.filter((j): j is number => j !== null));
  return {
    matches: late.map((j) => (j === null ? null : slots[j])),
    unplaced: slots.filter((_, j) => !placed.has(j)),
    ambiguous: late.flatMap((j, i) => (j === early[i] ? [] : [i])),
    conflicts: late.map((j, i) => {
      if (j === null) return false;
      const s = matchScore(layout[i], file, slots[j], features);
      return s.conflict || (sourceBreaks && s.breakConflict);
    }),
  };
}

/** The alignment record's path for a score: `alignment.json` in the score's directory. */
export const alignmentPath = (fragment: string): string =>
  `${fragment.slice(0, fragment.lastIndexOf("/") + 1)}alignment.json`;

export const ALIGNMENT_RECORD_NOTE =
  "Where the uploaded encoding's measures were placed. Indices are 0-based: layout measures in score order, file measures in the uploaded file's order after the file measure edits, part within a multi-measure rest. pins are the links fixed by hand; matches the resulting placement per layout measure; staves the score staff (1-based) per file staff. scoreStaves, where chosen by hand, is the file staff (1-based) per score staff, null for an empty staff. fileMeasures, where edited, lists by xml:id the file measures removed before alignment and the empty measures added, each after the file measure with that xml:id (null: before the first).";

/** What the volunteer chose besides the pins, as the alignment record keeps it. */
export interface AlignmentChoices {
  /** The file staff per score staff, where chosen by hand. */
  scoreStaves?: (number | null)[];
  fileEdits?: FileEdits;
}

/** The alignment record as `alignment.json` is written. */
export function alignmentRecord(
  pins: Pin[],
  alignment: Alignment,
  staffMap: (number | null)[],
  { scoreStaves, fileEdits }: AlignmentChoices = {},
): string {
  const slot = (s: FileSlot | null) => (s ? [s.measure, s.part] : null);
  return (
    JSON.stringify(
      {
        note: ALIGNMENT_RECORD_NOTE,
        pins: pins.map((pin) => [pin.box, slot(pin.slot)]),
        matches: alignment.matches.map(slot),
        staves: staffMap,
        ...(scoreStaves ? { scoreStaves } : {}),
        ...(fileEdits && (fileEdits.removed.length || fileEdits.added.length)
          ? {
              fileMeasures: {
                removed: fileEdits.removed,
                added: fileEdits.added,
              },
            }
          : {}),
      },
      null,
      "\t",
    ) + "\n"
  );
}

/** An alignment record's fields, none unless it is an object; throws when it cannot be read. */
function recordFields(record: string): Record<string, unknown> {
  let fields: unknown;
  try {
    fields = JSON.parse(record);
  } catch (e) {
    throw new Error(
      `the alignment record could not be read (${(e as Error).message})`,
    );
  }
  return typeof fields === "object" && fields !== null
    ? (fields as Record<string, unknown>)
    : {};
}

/**
 * The pins of an alignment record; none when it is absent. Throws when it is
 * there but cannot be read, so its pins are not taken for none and saved over.
 */
export function pinsOf(record: string | null): Pin[] {
  if (record === null) return [];
  const pins = recordFields(record).pins;
  if (!Array.isArray(pins))
    throw new Error("the alignment record holds no list of fixed links");
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
}

/**
 * The score staves an alignment record keeps as chosen by hand; undefined
 * when the record is absent or holds none. Throws when the record is there
 * but it or its list cannot be read.
 */
export function scoreStavesOf(
  record: string | null,
): (number | null)[] | undefined {
  if (record === null) return undefined;
  const list = recordFields(record).scoreStaves;
  if (list === undefined) return undefined;
  if (
    !Array.isArray(list) ||
    !list.every((s) => s === null || Number.isInteger(s))
  )
    throw new Error("the alignment record's score staves cannot be read");
  return list as (number | null)[];
}

/**
 * The file measure edits an alignment record keeps; none when the record is
 * absent or holds none. Throws when the record is there but it or its edits
 * cannot be read.
 */
export function fileEditsOf(record: string | null): FileEdits {
  const none: FileEdits = { removed: [], added: [] };
  if (record === null) return none;
  const edits = recordFields(record).fileMeasures as
    | { removed?: unknown; added?: unknown }
    | undefined;
  if (edits === undefined) return none;
  const removed = edits?.removed;
  const added = edits?.added;
  if (
    !Array.isArray(removed) ||
    !removed.every((id) => typeof id === "string") ||
    !Array.isArray(added) ||
    !added.every(
      (a) =>
        typeof a?.id === "string" &&
        (a.after === null || typeof a.after === "string"),
    )
  )
    throw new Error("the alignment record's file measure edits cannot be read");
  return {
    removed,
    added: added.map((a) => ({ after: a.after, id: a.id })),
  };
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
 * More unplaced file measures than this share of the layout's measures, and
 * more than DIFFERENT_UNPLACED_MIN, marks the file as a different version.
 */
export const DIFFERENT_UNPLACED_SHARE = 0.1;
/** The unplaced file measures a short piece's file may have and still fit. */
export const DIFFERENT_UNPLACED_MIN = 2;
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
    unplaced >
      Math.max(DIFFERENT_UNPLACED_MIN, boxes * DIFFERENT_UNPLACED_SHARE) ||
    conflicts > matched * DIFFERENT_CONFLICT_SHARE
      ? "different"
      : filled === boxes && unplaced === 0
        ? "complete"
        : "partial";
  return { kind, filled, empty: boxes - filled, unplaced, conflicts };
}

/**
 * A staff's key for mapStaves: its clef (`G2`), followed for a staff in a
 * brace by its place there (`G2|1/2`: the first of two braced staves).
 */
export function staffKey(
  staff: { clefShape: string; clefLine: number },
  n: number,
  groups: { start: number; end: number; symbol: string }[],
): string {
  const brace = groups.find(
    (g) => g.symbol === "brace" && g.start <= n && n <= g.end,
  );
  const clef = `${staff.clefShape}${staff.clefLine}`;
  return brace
    ? `${clef}|${n - brace.start + 1}/${brace.end - brace.start + 1}`
    : clef;
}

/**
 * Which layout staff each file staff goes to (by position, 0-based in, 1-based
 * out), or null for a file staff with no place. With the layout's staff keys
 * (staffKey), staves with equal clefs are paired in order, as many as
 * possible with the same place in a brace too, and the staves between two
 * pairs are paired in order as far as both sides have them; without, staff k
 * goes to staff k.
 */
export function mapStaves(
  fileKeys: string[],
  layoutCount: number,
  layoutKeys?: string[],
): (number | null)[] {
  if (!layoutKeys || layoutKeys.length !== layoutCount)
    return fileKeys.map((_, s) => (s < layoutCount ? s + 1 : null));
  const a = fileKeys.length;
  const b = layoutCount;
  const clefOf = (key: string) => key.split("|")[0];
  // A pair of equal keys weighs 2, of equal clefs only 1; others do not pair.
  const weight = (s: number, t: number) =>
    fileKeys[s] === layoutKeys[t]
      ? 2
      : clefOf(fileKeys[s]) === clefOf(layoutKeys[t])
        ? 1
        : 0;
  const best = Array.from({ length: a + 1 }, () => new Array(b + 1).fill(0));
  for (let s = a - 1; s >= 0; s--)
    for (let t = b - 1; t >= 0; t--) {
      const w = weight(s, t);
      best[s][t] = Math.max(
        best[s + 1][t],
        best[s][t + 1],
        w > 0 ? w + best[s + 1][t + 1] : 0,
      );
    }
  const anchors: [number, number][] = [];
  for (let s = 0, t = 0; s < a && t < b; ) {
    const w = weight(s, t);
    if (w > 0 && best[s][t] === w + best[s + 1][t + 1])
      anchors.push([s++, t++]);
    else if (best[s + 1][t] >= best[s][t + 1]) s++;
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
