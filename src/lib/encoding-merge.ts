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
  applyFileEdits,
  labelRanges,
  mapStaves,
  readMeasures,
  staffKey,
  summariseAlignment,
  type Alignment,
  type AlignmentSummary,
  type FileEdits,
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
  type StaffModel,
} from "./mei-facsimile.ts";
import { staffCountOf, withCorrectedLayout } from "./omr-layout.ts";
import { addXmlIds } from "./mei-ids.ts";
import { applicationId, recordApplications } from "./mei-provenance.ts";
import {
  elementsNamed,
  escapeRegex,
  startTags,
  tagAttribute,
  tagsIn,
  xmlEscape,
  xmlUnescape,
} from "./mei-xml.ts";

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
  /**
   * Measure-level elements dropped: a control event none of whose staves has
   * a place and which points to a note, or one an element it points to is
   * gone from; an `<ossia>` whose staff has no place.
   */
  droppedEvents: number;
  /**
   * Score-definition changes between measures that could not be carried,
   * staff definitions of staves without a place among them.
   */
  droppedDefinitions: number;
  /**
   * `@staff` attributes inside a staff's content (cross-staff notes, chords,
   * rests, beams …) removed because the staff they name has no place.
   */
  crossStaffRemoved: number;
  /**
   * `@beam.with` and `@stem.with` attributes removed because the neighbouring
   * staff in their direction is no longer the same file staff.
   */
  neighbourRemoved: number;
  /**
   * Control events without a pointer to a note moved to the first score
   * staff from the file because none of their staves has a place.
   */
  movedEvents: number;
  /** The file's staff groups not carried into the score definition. */
  droppedGroups: number;
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

/** The tag (or element) with its start tag's attribute `name` removed. */
const withoutAttr = (element: string, name: string): string =>
  element.replace(
    new RegExp(`^(<[^>]*?)\\s${escapeRegex(name)}="[^"]*"`),
    "$1",
  );

/** `xml` with each start and empty-element tag replaced by `rewrite`'s result. */
function rewriteTags(
  xml: string,
  rewrite: (tag: string, name: string) => string,
): string {
  let out = "";
  let last = 0;
  for (const tag of tagsIn(xml)) {
    if (tag.kind === "end") continue;
    out +=
      xml.slice(last, tag.start) +
      rewrite(xml.slice(tag.start, tag.end), tag.name);
    last = tag.end;
  }
  return out + xml.slice(last);
}

/** The xml:ids an XML fragment declares. */
const idsIn = (xml: string): string[] =>
  [...tagsIn(xml)].flatMap((tag) => {
    const id = tag.attributes?.get("xml:id");
    return id === undefined ? [] : [xmlUnescape(id)];
  });

/** The ids a control event refers to through its pointing attributes. */
function referencesOf(tag: string): string[] {
  return ["startid", "endid", "plist"].flatMap((name) =>
    (tagAttribute(tag, name) ?? "")
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
 * A file group is carried, renumbered, where its staves all have a place and
 * stand next to each other in the same order; `droppedGroups` counts the
 * others. With `layoutGroups`, the file's groups are kept only where the
 * file's staves map one to one, else the skeleton's are used where its staff
 * count is the score's, and none is counted as dropped.
 */
function mergedScoreDef(
  skeleton: ScoreDefModel,
  file: ScoreDefModel,
  staffMap: (number | null)[],
  staffCount: number,
  layoutGroups: boolean,
): { def: ScoreDefModel; droppedGroups: number } {
  const staves = Array.from({ length: staffCount }, (_, t) => {
    const s = staffMap.indexOf(t + 1);
    const own = skeleton.staves[t];
    const staff =
      (s >= 0 && file.staves[s]) || own || DEFAULT_SCORE_DEF.staves[0];
    const id = own?.id ?? (s >= 0 ? file.staves[s]?.id : undefined);
    return id ? { ...staff, id } : { ...staff, id: undefined };
  });
  if (layoutGroups) {
    const oneToOne =
      staffMap.length === staffCount && staffMap.every((t, s) => t === s + 1);
    return {
      def: {
        ...file,
        staves,
        groups: oneToOne
          ? file.groups
          : skeleton.staves.length === staffCount
            ? skeleton.groups
            : [],
      },
      droppedGroups: 0,
    };
  }
  const groups = file.groups.flatMap((group) => {
    const first = staffMap[group.start - 1] ?? null;
    const kept =
      first !== null &&
      Array.from(
        { length: group.end - group.start + 1 },
        (_, k) => staffMap[group.start - 1 + k],
      ).every((t, k) => t === first + k);
    return kept
      ? [{ ...group, start: first, end: first + group.end - group.start }]
      : [];
  });
  return {
    def: { ...file, staves, groups },
    droppedGroups: file.groups.length - groups.length,
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
 * or null (mapStaves); `staffCount` is the layout's staves per system. The
 * file's score definition replaces the skeleton's, unless `keepScoreDef`;
 * `layoutGroups` keeps its staff groups as mergedScoreDef describes.
 *
 * References to staves are rewritten through the map: `@staff` inside a
 * staff's content, removed where its staff has no place; `@beam.with` and
 * `@stem.with`, removed where the neighbouring staff changes; `@staff` on
 * control events, which keep the staves that have a place. A control event
 * none of whose staves has a place moves to the first score staff from the
 * file when it points to no note, else it is dropped. Staff definitions
 * between measures and the staves of an `<ossia>` are renumbered; those
 * without a place are dropped, and an ossia with them.
 */
export function mergeEncoding(
  skeleton: string,
  upload: string,
  alignment: Alignment,
  staffMap: (number | null)[],
  staffCount: number,
  {
    keepScoreDef = false,
    layoutGroups = false,
  }: { keepScoreDef?: boolean; layoutGroups?: boolean } = {},
): MergeResult {
  const scoreDef = keepScoreDef
    ? null
    : mergedScoreDef(
        parseScoreDef(skeleton),
        parseScoreDef(upload),
        staffMap,
        staffCount,
        layoutGroups,
      );
  const base = scoreDef ? replaceScoreDef(skeleton, scoreDef.def) : skeleton;
  const file = withoutClashes(upload, new Set(idsIn(base)));
  const layout = readMeasures(base);
  const fileMeasures = readMeasures(file);
  const resp = `#${applicationId(UPLOAD_APPLICATION)}`;
  const mapStaff = (n: number) => staffMap[n - 1] ?? null;
  /** The file staff at score staff `t`, or null. */
  const fileStaffAt = (t: number) => {
    const s = staffMap.indexOf(t);
    return s < 0 ? null : s + 1;
  };
  const placedStaves = staffMap.filter((t): t is number => t !== null);
  const top = placedStaves.length ? Math.min(...placedStaves) : null;
  /** A list of file staff numbers as the score staves of those with a place. */
  const mapList = (value: string) =>
    value.split(/\s+/).flatMap((n) => {
      const t = n ? mapStaff(Number(n)) : null;
      return t === null ? [] : [t];
    });
  let crossStaffRemoved = 0;
  let neighbourRemoved = 0;
  let movedEvents = 0;
  /** The tag with its `@staff` mapped, or removed when no staff has a place. */
  const mapStaffAttr = (tag: string) => {
    const staves = tagAttribute(tag, "staff");
    if (staves === null) return tag;
    const mapped = mapList(staves);
    if (mapped.length) return withAttr(tag, "staff", mapped.join(" "));
    crossStaffRemoved++;
    return withoutAttr(tag, "staff");
  };
  /** File staff `s`'s content as score staff `t`. */
  const placeStaff = (text: string, s: number, t: number) =>
    rewriteTags(text, (tag) => {
      let out = mapStaffAttr(tag);
      for (const name of ["beam.with", "stem.with"]) {
        const side = tagAttribute(out, name);
        const step = side === "above" ? -1 : side === "below" ? 1 : 0;
        if (step && fileStaffAt(t + step) !== s + step) {
          out = withoutAttr(out, name);
          neighbourRemoved++;
        }
      }
      return out;
    });

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
          mapStaff(Number(tagAttribute(child.tag, "n"))) === t,
      );
      const n = source && Number(tagAttribute(source.tag, "n"));
      const events = measure && n ? (measure.events.get(n) ?? 0) : 0;
      if (source && events > 0 && measure!.span > 1) {
        staves.push(
          `<staff n="${t}" resp="${resp}"><layer n="1"><mRest/></layer></staff>`,
        );
        fromFile = true;
      } else if (source && events > 0) {
        staves.push(
          withAttr(
            withAttr(placeStaff(source.text, n!, t), "n", String(t)),
            "resp",
            resp,
          ),
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
  /**
   * A score-definition change with its staff definitions renumbered, those
   * without a place and staff groups left empty removed; null when it is
   * left without attributes and content.
   */
  const scoreDefChange = (definition: string): string | null => {
    let out = "";
    let last = 0;
    for (const def of elementsNamed(definition, "staffDef", true)) {
      const t = mapStaff(Number(tagAttribute(def.tag, "n")));
      const before = definition.slice(last, def.start);
      if (t === null) {
        out += before.replace(/\s*$/, "");
        droppedDefinitions++;
      } else
        out +=
          before +
          withAttr(definition.slice(def.start, def.end), "n", String(t));
      last = def.end;
    }
    out += definition.slice(last);
    for (let previous = ""; previous !== out; ) {
      previous = out;
      out = out.replace(/\s*<staffGrp\b[^>]*?(?:\/>|>\s*<\/staffGrp>)/g, "");
    }
    const open = /^<[^>]*>/.exec(out)![0];
    const content = out
      .slice(open.length)
      .replace(/<\/scoreDef>$/, "")
      .trim();
    const attributes = [...tagsIn(open)][0].attributes ?? new Map();
    return content || [...attributes.keys()].some((name) => name !== "xml:id")
      ? out
      : null;
  };
  const leadingOf = (measure: MeasureInfo, index: number): string[] =>
    index === 0
      ? []
      : measure.leading.flatMap((definition) => {
          const name = /^<(\w+)/.exec(definition)![1];
          if (name === "scoreDef") {
            const kept = scoreDefChange(definition);
            return kept === null ? [] : [kept];
          }
          const t =
            name === "staffDef"
              ? mapStaff(Number(tagAttribute(definition, "n")))
              : null;
          if (t !== null) return [withAttr(definition, "n", String(t))];
          droppedDefinitions++;
          return [];
        });
  /** An `<ossia>` with its staves renumbered; null when one has no place. */
  const ossiaOf = (text: string): string | null =>
    [...startTags(text, "staff")].some(
      ({ tag }) => mapStaff(Number(tagAttribute(tag, "n"))) === null,
    )
      ? null
      : rewriteTags(text, (tag, name) =>
          name === "staff"
            ? withAttr(
                tag,
                "n",
                String(mapStaff(Number(tagAttribute(tag, "n")))),
              )
            : mapStaffAttr(tag),
        );

  let out = "";
  let last = 0;
  for (const [i, plan] of plans.entries()) {
    const { box, slot, measure } = plan;
    const own = children(
      base.slice(box.start, box.end).replace(/^<[^>]*>|<\/measure>$/g, ""),
    ).filter((child) => child.name !== "staff");
    const ownSigns = new Set(
      own
        .filter((child) => child.name === "repeatMark")
        .map((child) => tagAttribute(child.tag, "func")),
    );
    const events =
      measure && slot!.part === 0
        ? plan.fileChildren.flatMap((child) => {
            if (child.name === "staff") return [];
            if (
              child.name === "repeatMark" &&
              ownSigns.has(tagAttribute(child.tag, "func"))
            )
              return [];
            if (child.name === "ossia") {
              const ossia = ossiaOf(child.text);
              if (ossia === null) droppedEvents++;
              return ossia === null ? [] : [ossia];
            }
            const references = referencesOf(child.tag);
            if (references.some((id) => !present.has(id))) {
              droppedEvents++;
              return [];
            }
            const staves = tagAttribute(child.tag, "staff");
            if (!staves) return [child.text];
            const mapped = mapList(staves);
            if (mapped.length)
              return [withAttr(child.text, "staff", mapped.join(" "))];
            if (!references.length && top !== null) {
              movedEvents++;
              return [withAttr(child.text, "staff", String(top))];
            }
            droppedEvents++;
            return [];
          })
        : [];
    const pad = indentAt(base, box.start);
    const inner = `${pad}   `;
    let open = /^<[^>]*>/
      .exec(base.slice(box.start, box.end))![0]
      .replace(/\/>$/, ">");
    // The file's other barlines (final, double …) are kept where the layout
    // has none; repeats come from the layout alone, and a final barline is
    // kept only on the last measure of a movement. A multi-measure rest's
    // left barline goes to its first measure, its right to its last.
    const next = layout[i + 1];
    const endsMovement =
      !next || /<\/(section|mdiv)>/.test(base.slice(box.end, next.start));
    const fileOpen = measure
      ? /^<[^>]*>/.exec(file.slice(measure.start))![0]
      : "";
    const sides = [
      ...(slot?.part === 0 ? ["left"] : []),
      ...(measure && slot!.part === measure.span - 1 ? ["right"] : []),
    ];
    for (const side of sides) {
      const barline = tagAttribute(fileOpen, side);
      if (
        !tagAttribute(open, side) &&
        barline &&
        !barline.startsWith("rpt") &&
        (barline !== "end" || endsMovement)
      )
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
    crossStaffRemoved,
    neighbourRemoved,
    movedEvents,
    droppedGroups: scoreDef?.droppedGroups ?? 0,
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

/** A problem checkScore finds: the measure it is in (index in score order), if any. */
export interface ScoreProblem {
  measure: number | null;
  text: string;
}

/**
 * What is wrong with a merged score's references: a `@staff` value that
 * names no staff 1..`staffCount`, and a `#id` in `@startid`, `@endid` or
 * `@plist` that no element of the score carries.
 */
export function checkScore(mei: string, staffCount: number): ScoreProblem[] {
  const bodyAt = mei.indexOf("<body");
  if (bodyAt < 0) return [];
  const ids = new Set(idsIn(mei));
  const problems: ScoreProblem[] = [];
  let measure: number | null = null;
  let count = 0;
  let label = "";
  for (const tag of tagsIn(mei, bodyAt)) {
    if (tag.kind === "end") {
      if (tag.name === "measure") measure = null;
      continue;
    }
    if (tag.name === "measure") {
      measure = count++;
      label = xmlUnescape(tag.attributes?.get("n") ?? String(count));
    }
    const where = measure === null ? "Between measures" : `Measure ${label}`;
    const staves = tag.attributes?.get("staff");
    for (const n of staves?.split(/\s+/).filter(Boolean) ?? [])
      if (!/^\d+$/.test(n) || Number(n) < 1 || Number(n) > staffCount)
        problems.push({
          measure,
          text: `${where}: <${tag.name}> names staff ${n}, the score has ${staffCount}`,
        });
    for (const name of ["startid", "endid", "plist"])
      for (const ref of tag.attributes?.get(name)?.split(/\s+/) ?? [])
        if (ref.startsWith("#") && !ids.has(xmlUnescape(ref.slice(1))))
          problems.push({
            measure,
            text: `${where}: <${tag.name}> points to ${ref}, which is not in the score`,
          });
  }
  return problems;
}

/** What alignEncoding works from: the piece's files and the volunteer's choices. */
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
  /**
   * The file staff (1-based) per score staff, in score order, null for an
   * empty staff; absent: placed automatically (mapStaves).
   */
  scoreStaves?: (number | null)[];
  /** Changes to the uploaded file's measure sequence; absent: none. */
  fileEdits?: FileEdits;
}

/** A staff of the uploaded file as a staff choice shows it. */
export type FileStaff = { n: number } & Pick<
  StaffModel,
  "label" | "clefShape" | "clefLine"
>;

export interface AlignedEncoding {
  /**
   * The upload with an xml:id on every element and the file edits applied,
   * as merged and rendered.
   */
  upload: string;
  /** The layout skeleton's measures, in score order. */
  layout: MeasureInfo[];
  /** The upload's measures after the file edits. */
  file: MeasureInfo[];
  /** The xml:ids of the upload's measures before the file edits (shiftPins). */
  fileIds: string[];
  /** The file measures the edits removed, with their labels ('' for none). */
  fileRemoved: { id: string; label: string }[];
  /** The empty file measures the edits added, as the edits name them. */
  fileAdded: FileEdits["added"];
  alignment: Alignment;
  summary: AlignmentSummary;
  /** Per file staff, its layout staff. */
  staffMap: (number | null)[];
  /** The layout's staves per system. */
  staffCount: number;
  /**
   * Per score staff, the file staff (1-based) it takes or null: the chosen
   * list where it was taken, else the automatic one.
   */
  scoreStaves: (number | null)[];
  /** The uploaded file's staves, in order. */
  fileStaves: FileStaff[];
  /**
   * Per score staff, the name the layout task gave it (its label, else its
   * group's), '' for none; null unless the piece is 'omr-instruments'.
   */
  layoutStaffNames: string[] | null;
  merged: MergeResult;
  /** What checkScore finds in the merged score; empty when it is sound. */
  problems: ScoreProblem[];
  /** The alignment record, as `alignment.json` is written. */
  record: string;
}

/**
 * Align and merge an uploaded encoding, after its file edits
 * (applyFileEdits), into the piece's layout skeleton. An OMR-prepared piece's
 * staff count is its corrected layout's; a piece whose layout task named the
 * instruments ('omr-instruments') keeps its score definition, and its staves
 * are paired with the file's by clef. Otherwise the file's staves are taken
 * as they are.
 *
 * `scoreStaves`, where given, sets the staves instead: each entry an integer
 * file staff in range or null, no file staff twice, at least one entry. For an
 * OMR-prepared piece its length must be the layout's staff count; for
 * another piece it sets the staff count. A list that breaks any of these is
 * ignored and the staves are placed automatically.
 */
export function alignEncoding(input: EncodingInput): AlignedEncoding {
  const omr =
    input.preparation === "omr" || input.preparation === "omr-instruments";
  const named = input.preparation === "omr-instruments";
  const skeleton = layoutSkeleton(input.current, input.corrected, omr);
  const withIds = addXmlIds(input.upload, "u-");
  const fileEdits = input.fileEdits ?? { removed: [], added: [] };
  const upload = applyFileEdits(withIds, fileEdits);
  const unedited = readMeasures(withIds);
  const removed = new Set(fileEdits.removed);
  const layout = readMeasures(skeleton);
  const file = readMeasures(upload);
  const fileDef = parseScoreDef(upload);
  const ownDef = parseScoreDef(skeleton);
  const fileStaves = fileDef.staves;
  const ownStaves = ownDef.staves;
  const layoutCount = named
    ? ownStaves.length
    : omr
      ? staffCountOf(
          withCorrectedLayout(
            parseFacsimileMei(skeleton).pages,
            input.corrected,
          ),
        )
      : null;
  const chosen = input.scoreStaves;
  const valid =
    chosen !== undefined &&
    chosen.length > 0 &&
    (layoutCount === null || chosen.length === layoutCount) &&
    chosen.every(
      (s) =>
        s === null || (Number.isInteger(s) && s >= 1 && s <= fileStaves.length),
    ) &&
    new Set(chosen.filter((s) => s !== null)).size ===
      chosen.filter((s) => s !== null).length;
  const staffCount = valid ? chosen.length : (layoutCount ?? fileStaves.length);
  const staffMap = valid
    ? fileStaves.map((_, s) => {
        const t = chosen.indexOf(s + 1);
        return t < 0 ? null : t + 1;
      })
    : mapStaves(
        fileStaves.map((s, i) => staffKey(s, i + 1, fileDef.groups)),
        staffCount,
        named
          ? ownStaves.map((s, i) => staffKey(s, i + 1, ownDef.groups))
          : undefined,
      );
  const scoreStaves = valid
    ? chosen
    : Array.from({ length: staffCount }, (_, t) => {
        const s = staffMap.indexOf(t + 1);
        return s < 0 ? null : s + 1;
      });
  const alignment = alignMeasures(layout, file, input.pins);
  const merged = mergeEncoding(
    skeleton,
    upload,
    alignment,
    staffMap,
    staffCount,
    { keepScoreDef: named, layoutGroups: omr },
  );
  return {
    upload,
    layout,
    file,
    fileIds: unedited.map((m) => m.id),
    fileRemoved: unedited.flatMap((m) =>
      removed.has(m.id) ? [{ id: m.id, label: m.label }] : [],
    ),
    fileAdded: fileEdits.added.filter((a) => file.some((m) => m.id === a.id)),
    alignment,
    summary: summariseAlignment(file, alignment),
    staffMap,
    staffCount,
    scoreStaves,
    fileStaves: fileStaves.map((s, i) => ({
      n: i + 1,
      label: s.label,
      clefShape: s.clefShape,
      clefLine: s.clefLine,
    })),
    layoutStaffNames: named
      ? ownStaves.map(
          (s, t) =>
            s.label ||
            ownDef.groups.find(
              (g) => g.label && g.start <= t + 1 && t + 1 <= g.end,
            )?.label ||
            "",
        )
      : null,
    merged,
    problems: checkScore(merged.mei, staffCount),
    record: alignmentRecord(input.pins, alignment, staffMap, {
      scoreStaves: valid ? chosen : undefined,
      fileEdits: input.fileEdits,
    }),
  };
}
