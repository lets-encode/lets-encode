// Merging an uploaded encoding into a piece's layout skeleton along an
// alignment (encoding-align.ts). The skeleton keeps its structure: measure
// zones, page and system breaks, labels, repeats, endings and signs. Each
// layout measure with a file measure takes that measure's staves and control
// events; staves the file leaves empty stay empty for the OMR page draft.
// Every staff filled from the file records the upload in its @resp.
//
// Pure string handling: MEI text in, MEI text out. No DOM, forge or network
// access.

import {
  alignMeasures,
  alignmentRecord,
  labelRanges,
  mapStaves,
  readMeasures,
  summariseAlignment,
  type Alignment,
  type AlignmentSummary,
  type MeasureInfo,
  type Pin,
} from "./encoding-align.ts";
import {
  buildFacsimileMei,
  DEFAULT_SCORE_DEF,
  parseFacsimileMei,
  parseScoreDef,
  replaceScoreDef,
  type ScoreDefModel,
} from "./mei-facsimile.ts";
import { staffCountOf, withCorrectedLayout } from "./omr-layout.ts";
import { addXmlIds } from "./mei-ids.ts";
import { applicationId, recordApplications } from "./mei-provenance.ts";
import { elementsNamed, startTags, tagsIn, xmlEscape } from "./mei-xml.ts";

/** The <appInfo> entry the staves filled from an uploaded file point to. */
export const UPLOAD_APPLICATION = "Uploaded encoding";

export interface MergeResult {
  mei: string;
  /** Layout measures (indices) with at least one staff from the file. */
  filled: number[];
  /** Layout measures with no staff from the file. */
  empty: number[];
  /** File measures placed in no layout measure. */
  droppedMeasures: number;
  /** Control events dropped: their staff has no place, or an end is gone. */
  droppedEvents: number;
  /** Score-definition changes between measures that could not be carried. */
  droppedDefinitions: number;
}

/** A top-level element of an XML fragment. */
interface Child {
  name: string;
  /** Its start tag (or empty-element tag). */
  tag: string;
  /** The whole element. */
  text: string;
}

/** The top-level elements of `xml`, in order. */
function children(xml: string): Child[] {
  const out: Child[] = [];
  let depth = 0;
  let open: { name: string; start: number; tagEnd: number } | null = null;
  for (const tag of tagsIn(xml)) {
    if (depth === 0) {
      if (tag.kind === "empty") {
        const text = xml.slice(tag.start, tag.end);
        out.push({ name: tag.name, tag: text, text });
      } else if (tag.kind === "start") {
        open = { name: tag.name, start: tag.start, tagEnd: tag.end };
        depth = 1;
      }
    } else if (tag.kind === "start") depth++;
    else if (tag.kind === "end" && --depth === 0 && open) {
      out.push({
        name: open.name,
        tag: xml.slice(open.start, open.tagEnd),
        text: xml.slice(open.start, tag.end),
      });
      open = null;
    }
  }
  return out;
}

const attr = (tag: string, name: string): string | null =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** The element with its start tag's attribute `name` set to `value`. */
function withAttr(element: string, name: string, value: string): string {
  const tagEnd = element.indexOf(">");
  const tag = element.slice(0, tagEnd + 1);
  const rest = element.slice(tagEnd + 1);
  const pattern = new RegExp(`(\\s${name}=")[^"]*(")`);
  const written = `${name}="${xmlEscape(value)}"`;
  const updated = pattern.test(tag)
    ? tag.replace(
        pattern,
        (_, a: string, b: string) => `${a}${xmlEscape(value)}${b}`,
      )
    : tag.replace(/\s*(\/?)>$/, (_, slash: string) => ` ${written}${slash}>`);
  return updated + rest;
}

/** The xml:ids an XML fragment declares. */
const idsIn = (xml: string): string[] =>
  [...xml.matchAll(/\bxml:id="([^"]*)"/g)].map((m) => m[1]);

/** The ids a control event refers to through its pointing attributes. */
function referencesOf(tag: string): string[] {
  return ["startid", "endid", "plist"].flatMap((name) =>
    (attr(tag, name) ?? "")
      .split(/\s+/)
      .filter((ref) => ref.startsWith("#"))
      .map((ref) => ref.slice(1)),
  );
}

/**
 * The upload with every xml:id the skeleton already uses renamed, and the
 * references to them inside attribute values with it.
 */
function withoutClashes(upload: string, taken: Set<string>): string {
  const renamed = new Map<string, string>();
  const used = new Set([...taken, ...idsIn(upload)]);
  for (const id of idsIn(upload)) {
    if (!taken.has(id) || renamed.has(id)) continue;
    let fresh = `u-${id}`;
    for (let k = 2; used.has(fresh); k++) fresh = `u${k}-${id}`;
    used.add(fresh);
    renamed.set(id, fresh);
  }
  if (!renamed.size) return upload;
  return upload.replace(/(\s[\w.:-]+=")([^"]*)(")/g, (all, a, value, b) => {
    const name = a.trim();
    if (name === 'xml:id="')
      return renamed.has(value) ? `${a}${renamed.get(value)}${b}` : all;
    if (!value.includes("#")) return all;
    const mapped = value.replace(/#([^\s#]+)/g, (ref: string, id: string) =>
      renamed.has(id) ? `#${renamed.get(id)}` : ref,
    );
    return `${a}${mapped}${b}`;
  });
}

/**
 * The score definition of the merged score: per layout staff, the file staff
 * mapped to it, else the skeleton's own; the skeleton's staff ids are kept.
 * The file's groups are kept where the file's staves map one to one.
 */
function mergedScoreDef(
  skeleton: ScoreDefModel,
  file: ScoreDefModel,
  staffMap: (number | null)[],
  staffCount: number,
): ScoreDefModel {
  const staves = Array.from({ length: staffCount }, (_, t) => {
    const s = staffMap.indexOf(t + 1);
    const own = skeleton.staves[t];
    const staff =
      (s >= 0 && file.staves[s]) || own || DEFAULT_SCORE_DEF.staves[0];
    const id = own?.id ?? (s >= 0 ? file.staves[s]?.id : undefined);
    return id ? { ...staff, id } : { ...staff, id: undefined };
  });
  const oneToOne =
    staffMap.length === staffCount && staffMap.every((t, s) => t === s + 1);
  return {
    ...file,
    staves,
    groups: oneToOne
      ? file.groups
      : skeleton.staves.length === staffCount
        ? skeleton.groups
        : [],
  };
}

/** The whitespace a line holding the element at `start` begins with. */
function indentAt(xml: string, start: number): string {
  const lineStart = xml.lastIndexOf("\n", start) + 1;
  return /^[ \t]*/.exec(xml.slice(lineStart, start))![0];
}

/**
 * Merge `upload` into `skeleton` along `alignment` (computed on
 * readMeasures of both). `staffMap` gives, per file staff, its layout staff
 * (mapStaves); `staffCount` is the layout's staves per system. The file's
 * score definition replaces the skeleton's, unless `keepScoreDef`.
 */
export function mergeEncoding(
  skeleton: string,
  upload: string,
  alignment: Alignment,
  staffMap: (number | null)[],
  staffCount: number,
  { keepScoreDef = false }: { keepScoreDef?: boolean } = {},
): MergeResult {
  const base = keepScoreDef
    ? skeleton
    : replaceScoreDef(
        skeleton,
        mergedScoreDef(
          parseScoreDef(skeleton),
          parseScoreDef(upload),
          staffMap,
          staffCount,
        ),
      );
  const file = withoutClashes(upload, new Set(idsIn(base)));
  const layout = readMeasures(base);
  const fileMeasures = readMeasures(file);
  const resp = `#${applicationId(UPLOAD_APPLICATION)}`;
  const mapStaff = (n: number) => staffMap[n - 1] ?? null;

  // First the staves of every layout measure, so the ids they carry are
  // known before the control events referring to them are kept or dropped.
  const plans = layout.map((box, i) => {
    const slot = alignment.matches[i];
    const measure = slot ? fileMeasures[slot.measure] : null;
    const fileChildren = measure
      ? children(
          file
            .slice(measure.start, measure.end)
            .replace(/^<[^>]*>|<\/measure>$/g, ""),
        )
      : [];
    const staves: string[] = [];
    let fromFile = false;
    for (let t = 1; t <= staffCount; t++) {
      const source = fileChildren.find(
        (child) =>
          child.name === "staff" &&
          mapStaff(Number(attr(child.tag, "n"))) === t,
      );
      const n = source && Number(attr(source.tag, "n"));
      const events = measure && n ? (measure.events.get(n) ?? 0) : 0;
      if (source && events > 0 && measure!.span > 1) {
        staves.push(
          `<staff n="${t}" resp="${resp}"><layer n="1"><mRest/></layer></staff>`,
        );
        fromFile = true;
      } else if (source && events > 0) {
        staves.push(
          withAttr(withAttr(source.text, "n", String(t)), "resp", resp),
        );
        fromFile = true;
      } else staves.push(`<staff n="${t}"><layer n="1"/></staff>`);
    }
    return { box, slot, measure, fileChildren, staves, fromFile };
  });

  const present = new Set([
    ...idsIn(base),
    ...plans.flatMap((plan) => plan.staves.flatMap(idsIn)),
  ]);
  let droppedEvents = 0;
  let droppedDefinitions = 0;
  const leadingOf = (measure: MeasureInfo, index: number): string[] =>
    index === 0
      ? []
      : measure.leading.flatMap((definition) => {
          const name = /^<(\w+)/.exec(definition)![1];
          if (name === "scoreDef" && !definition.includes("<staffDef"))
            return [definition];
          const t =
            name === "staffDef"
              ? mapStaff(Number(attr(definition, "n")))
              : null;
          if (t !== null) return [withAttr(definition, "n", String(t))];
          droppedDefinitions++;
          return [];
        });

  let out = "";
  let last = 0;
  for (const plan of plans) {
    const { box, slot, measure } = plan;
    const own = children(
      base.slice(box.start, box.end).replace(/^<[^>]*>|<\/measure>$/g, ""),
    ).filter((child) => child.name !== "staff");
    const ownSigns = new Set(
      own
        .filter((child) => child.name === "repeatMark")
        .map((child) => attr(child.tag, "func")),
    );
    const events =
      measure && slot!.part === 0
        ? plan.fileChildren.flatMap((child) => {
            if (child.name === "staff") return [];
            if (
              child.name === "repeatMark" &&
              ownSigns.has(attr(child.tag, "func"))
            )
              return [];
            const staves = attr(child.tag, "staff");
            const mapped = staves
              ? staves.split(/\s+/).map((n) => mapStaff(Number(n)))
              : [];
            if (
              mapped.some((t) => t === null) ||
              referencesOf(child.tag).some((id) => !present.has(id))
            ) {
              droppedEvents++;
              return [];
            }
            return [
              staves
                ? withAttr(child.text, "staff", mapped.join(" "))
                : child.text,
            ];
          })
        : [];
    const pad = indentAt(base, box.start);
    const inner = `${pad}   `;
    let open = /^<[^>]*>/
      .exec(base.slice(box.start, box.end))![0]
      .replace(/\/>$/, ">");
    // The file's other barlines (final, double …) are kept where the layout
    // has none; repeats come from the layout alone. A multi-measure rest's
    // left barline goes to its first measure, its right to its last.
    const fileOpen = measure
      ? /^<[^>]*>/.exec(file.slice(measure.start))![0]
      : "";
    const sides = [
      ...(slot?.part === 0 ? ["left"] : []),
      ...(measure && slot!.part === measure.span - 1 ? ["right"] : []),
    ];
    for (const side of sides) {
      const barline = attr(fileOpen, side);
      if (!attr(open, side) && barline && !barline.startsWith("rpt"))
        open = withAttr(open, side, barline);
    }
    const leading =
      measure && slot!.part === 0 ? leadingOf(measure, slot!.measure) : [];
    out +=
      base.slice(last, box.start) +
      leading.map((definition) => `${definition}\n${pad}`).join("") +
      `${open}\n` +
      [...plan.staves, ...events, ...own.map((child) => child.text)]
        .map((line) => `${inner}${line}\n`)
        .join("") +
      `${pad}</measure>`;
    last = box.end;
  }
  out += base.slice(last);

  // A file measure's definitions are written with its first slot; when that
  // slot has no place, they are lost.
  const firstPlaced = new Set(
    alignment.matches.flatMap((slot) =>
      slot && slot.part === 0 ? [slot.measure] : [],
    ),
  );
  const placed = new Set(
    alignment.matches.flatMap((slot) => (slot ? [slot.measure] : [])),
  );
  fileMeasures.forEach((measure, m) => {
    if (m > 0 && !firstPlaced.has(m))
      droppedDefinitions += measure.leading.length;
  });

  const filled = plans.flatMap((plan, i) => (plan.fromFile ? [i] : []));
  const mei = filled.length
    ? recordApplications(out, [UPLOAD_APPLICATION])
    : out;
  return {
    mei: addXmlIds(mei),
    filled,
    empty: plans.flatMap((plan, i) => (plan.fromFile ? [] : [i])),
    droppedMeasures: fileMeasures.filter((_, m) => !placed.has(m)).length,
    droppedEvents,
    droppedDefinitions,
  };
}

/** Each `<score>`'s own score definition: the first `<scoreDef>` after it. */
function opening(mei: string): { start: number; end: number }[] {
  return [...startTags(mei, "score")].flatMap(({ start }) => {
    for (const element of elementsNamed(mei.slice(start), "scoreDef", true))
      return [{ start: start + element.start, end: start + element.end }];
    return [];
  });
}

/**
 * The layout skeleton of a piece's score: its measures rebuilt empty from
 * the zones, breaks and marks the score records (an OMR-prepared piece's from
 * its corrected boxes, `corrected`), with its header and each `<score>`'s
 * score definition carried over as written. A score that already holds an
 * uploaded encoding's notation gives the skeleton it was merged into.
 */
export function layoutSkeleton(
  current: string,
  corrected: string | null,
  omr: boolean,
): string {
  const parsed = parseFacsimileMei(current);
  const rebuilt = buildFacsimileMei(
    {
      headXml: parsed.headXml,
      scoreDef: parsed.scoreDef,
      pages: omr ? withCorrectedLayout(parsed.pages, corrected) : parsed.pages,
    },
    { withBreaks: true, emptyMeasures: true, padZones: omr },
  );
  const from = opening(current);
  const to = opening(rebuilt);
  if (from.length !== to.length) return rebuilt;
  let out = "";
  let last = 0;
  to.forEach((at, k) => {
    out +=
      rebuilt.slice(last, at.start) + current.slice(from[k].start, from[k].end);
    last = at.end;
  });
  return out + rebuilt.slice(last);
}

/**
 * The one-line record of a merge, for its commit message and the change it
 * enters in the score's header.
 */
export function alignmentMessage(
  taskId: string,
  layout: MeasureInfo[],
  result: MergeResult,
): string {
  const parts = [
    result.filled.length
      ? `measures ${labelRanges(layout, result.filled)} from the file`
      : "no measures from the file",
    ...(result.empty.length
      ? [`${labelRanges(layout, result.empty)} empty`]
      : []),
    ...(result.droppedMeasures
      ? [
          `${result.droppedMeasures} file measure${result.droppedMeasures === 1 ? "" : "s"} dropped`,
        ]
      : []),
  ];
  return `Align the uploaded encoding (${taskId}): ${parts.join(", ")}`;
}

/** What alignEncoding works from: the piece's files and the fixed links. */
export interface EncodingInput {
  /** The piece's score as the campaign holds it. */
  current: string;
  /** Its corrected layout (`layout-corrected.json`), for an OMR-prepared piece. */
  corrected: string | null;
  /** The uploaded encoding, as committed. */
  upload: string;
  /** The piece's preparation, one of PREPARATIONS. */
  preparation: string;
  pins: Pin[];
}

export interface AlignedEncoding {
  /** The upload with an xml:id on every element, as merged and rendered. */
  upload: string;
  /** The layout skeleton's measures, in score order. */
  layout: MeasureInfo[];
  /** The upload's measures. */
  file: MeasureInfo[];
  alignment: Alignment;
  summary: AlignmentSummary;
  /** Per file staff, its layout staff. */
  staffMap: (number | null)[];
  /** The layout's staves per system. */
  staffCount: number;
  merged: MergeResult;
  /** The alignment record, as `alignment.json` is written. */
  record: string;
}

/**
 * Align and merge an uploaded encoding into the piece's layout skeleton.
 * An OMR-prepared piece's staff count is its corrected layout's; a piece
 * whose layout task named the instruments ('omr-instruments') keeps its
 * score definition, and its staves are paired with the file's by clef.
 * Otherwise the file's staves are taken as they are.
 */
export function alignEncoding(input: EncodingInput): AlignedEncoding {
  const omr =
    input.preparation === "omr" || input.preparation === "omr-instruments";
  const named = input.preparation === "omr-instruments";
  const skeleton = layoutSkeleton(input.current, input.corrected, omr);
  const upload = addXmlIds(input.upload, "u-");
  const layout = readMeasures(skeleton);
  const file = readMeasures(upload);
  const clef = (s: { clefShape: string; clefLine: number }) =>
    `${s.clefShape}${s.clefLine}`;
  const fileStaves = parseScoreDef(upload).staves;
  const ownStaves = parseScoreDef(skeleton).staves;
  const staffCount = named
    ? ownStaves.length
    : omr
      ? staffCountOf(
          withCorrectedLayout(
            parseFacsimileMei(skeleton).pages,
            input.corrected,
          ),
        )
      : fileStaves.length;
  const staffMap = mapStaves(
    fileStaves.map(clef),
    staffCount,
    named ? ownStaves.map(clef) : undefined,
  );
  const alignment = alignMeasures(layout, file, input.pins);
  const merged = mergeEncoding(
    skeleton,
    upload,
    alignment,
    staffMap,
    staffCount,
    { keepScoreDef: named },
  );
  return {
    upload,
    layout,
    file,
    alignment,
    summary: summariseAlignment(file, alignment),
    staffMap,
    staffCount,
    merged,
    record: alignmentRecord(input.pins, alignment, staffMap),
  };
}
