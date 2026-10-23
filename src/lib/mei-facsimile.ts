// The facsimile MEI model behind the pre-tasks. Pure functions: page geometry
// and MEI text in, MEI text and models out. No DOM, filesystem or network
// access (measure detection lives in measure-detection.ts, image handling in
// prepare-images.ts).
//
// A facsimile campaign's score.mei passes through stages, all emitted by
// buildFacsimileMei from one model:
//   A. facsimile-only  — <surface>/<graphic> per page, one labelled
//      <zone type="measure" n="…"> per measure box, one empty <mdiv>.
//      Committed at init; the measure-correction pre-task rewrites the zones.
//   B. + measures      — one <measure n="label" facs="#zone"> (holding an
//      <mRest/>) per zone.
//   C. + breaks        — a <pb/> before each page's first measure, an <sb/>
//      before each other measure flagged as a system start, and one <mdiv> per
//      movement/section/piece (a zone's mdiv flag starts a new one). A page
//      break implies a system break, so a page's first measure emits only the
//      <pb/>. A <pb/> @n is its page number; an <sb/> @n counts system breaks in
//      document order. Written by the measure-correction pre-task's submission.
// parseFacsimileMei reads any stage back into the model; the <meiHead> block
// is carried verbatim across rebuilds, and the <scoreDef> — staves, clefs, key
// signature, meter and instrument labels, written by the score-setup task and
// defaulting to DEFAULT_SCORE_DEF — is parsed and re-emitted alongside it.

import { addXmlIds } from "./mei-ids.ts";
import { MEI_SCHEMA_URL } from "./mei-schema.ts";
import {
  elementsNamed,
  firstElementNamed,
  startTags,
  xmlEscape,
  xmlUnescape,
} from "./mei-xml.ts";
import { pageSystems } from "./omr-layout.ts";
import { writtenKeysig } from "./transposition.ts";

/** The XML declaration, schema association and <mei> start tag of a generated score. */
const MEI_OPENING =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<?xml-model href="${MEI_SCHEMA_URL}" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>\n` +
  `<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.1">\n`;

/** A detected measure box, in the page image's pixel space. */
export interface MeasureBox {
  ulx: number;
  uly: number;
  lrx: number;
  lry: number;
}

/** A staff box of an OMR-prepared page. */
export interface StaffBox extends MeasureBox {
  /**
   * The xml:id of the score staff (staffDef) the box shows, where the layout
   * task named the instruments; absent otherwise.
   */
  staff?: string;
}

/** One measure zone: its box, its measure label (@n), and its break flags. */
export interface ZoneModel {
  box: MeasureBox;
  /** The measure number/label written as @n — "12", but also "10a"/"10b" for voltas. */
  label: string;
  /**
   * Whether the measure starts a new page — emitted as <pb facs="#surface-N"/>
   * at stage C (each page's first measure). A page break implies a system
   * break, so a measure with pb emits no separate <sb/>.
   */
  pb: boolean;
  /** Whether the measure starts a new system (emitted as <sb/> at stage C, unless pb already implies it). */
  sb: boolean;
  /**
   * Whether the measure starts a new movement/section/piece — it opens a new
   * <mdiv> at stage C. The score's first measure always opens the first
   * <mdiv>; its flag is ignored.
   */
  mdiv: boolean;
  /**
   * Whether the measure is a pickup (an incomplete measure that is not
   * counted), emitted as @metcon="false" on its <measure> at stage C.
   * Absent means false.
   */
  pickup?: boolean;
  /** A repeat barline at the measure's start (@left="rptstart"). Absent means false. */
  rptStart?: boolean;
  /** A repeat barline at the measure's end (@right="rptend"). Absent means false. */
  rptEnd?: boolean;
  /**
   * A double repeat barline at the measure's end (@right="rptboth"): the end
   * of one repeat and the start of the next. Takes the place of rptEnd.
   * Absent means false.
   */
  rptBoth?: boolean;
  /**
   * The ending (volta) the measure belongs to: "1", "2", "3". Consecutive
   * measures of one section with the same ending form one <ending>. Absent
   * means none.
   */
  ending?: string;
  /** The navigation signs the measure carries (MEASURE_SIGNS order). */
  signs?: MeasureSign[];
}

/**
 * A navigation sign on a measure: segno, coda, D.C., D.S. and Fine are a
 * <repeatMark> with that @func; To Coda is a <dir>.
 */
export type MeasureSign =
  | "segno"
  | "coda"
  | "daCapo"
  | "dalSegno"
  | "fine"
  | "toCoda";
/** The signs in the order they are written. */
export const MEASURE_SIGNS: MeasureSign[] = [
  "segno",
  "coda",
  "daCapo",
  "dalSegno",
  "fine",
  "toCoda",
];
/** The text a sign carries; segno and coda are symbols only. */
export const SIGN_TEXT: Record<MeasureSign, string> = {
  segno: "",
  coda: "",
  daCapo: "D.C.",
  dalSegno: "D.S.",
  fine: "Fine",
  toCoda: "To Coda",
};
/** Segno and coda stand at the measure's start, the others at its end. */
const SIGN_AT_START = new Set<MeasureSign>(["segno", "coda"]);

/** The beats of a measure in `scoreDef`'s meter. */
function meterBeats(scoreDef: ScoreDefModel): number {
  if (scoreDef.meterSym === "common") return 4;
  if (scoreDef.meterSym === "cut") return 2;
  return Math.max(1, Number(scoreDef.meterCount) || 4);
}

/**
 * A measure's signs as control events on its first staff, above it: @tstamp
 * 0 is the left barline, the meter's beats + 1 the right barline.
 */
function signsXml(
  signs: MeasureSign[] | undefined,
  measureNo: number,
  beats: number,
): string {
  return MEASURE_SIGNS.filter((sign) => signs?.includes(sign))
    .map((sign, k) => {
      const at = SIGN_AT_START.has(sign) ? 0 : beats + 1;
      const id = `${sign === "toCoda" ? "dir" : "repeatMark"}-${measureNo}-${k + 1}`;
      const where = `staff="1" tstamp="${at}" place="above"`;
      const text = SIGN_TEXT[sign];
      if (sign === "toCoda")
        return `                  <dir xml:id="${id}" ${where}>${text}</dir>\n`;
      return text
        ? `                  <repeatMark xml:id="${id}" func="${sign}" ${where}>${text}</repeatMark>\n`
        : `                  <repeatMark xml:id="${id}" func="${sign}" ${where}/>\n`;
    })
    .join("");
}

/** One page of the facsimile model. */
export interface PageModel {
  /** Written verbatim as the graphic @target; resolved relative to the score, e.g. `img/01.jpg`. */
  image: string;
  width: number;
  height: number;
  zones: ZoneModel[];
  /**
   * Staff boxes of a piece prepared by OMR, whose layout task corrects them
   * and whose transcription crops them. Not written to the score: they are
   * kept in `layout-corrected.json` (see omr-layout.ts).
   */
  staves?: StaffBox[];
  /**
   * Grand-staff boxes (staves one performer plays together) of a piece
   * prepared by OMR, whose layout task corrects them. Kept like `staves`.
   */
  grandstaves?: MeasureBox[];
}

/** One staff of the score definition. */
export interface StaffModel {
  /**
   * The staffDef's xml:id, kept through parse and rebuild; absent gets a
   * generated one. Written on the first movement's score definition only.
   */
  id?: string;
  /** MEI clef.shape: 'G', 'F', 'C', 'perc' (percussion) or 'TAB' (tablature). */
  clefShape: string;
  /** MEI clef.line: the staff line the clef sits on, counted from the bottom. */
  clefLine: number;
  /** MEI clef.dis: octave displacement ('8', '15'); '' emits none. */
  clefDis: string;
  /** MEI clef.dis.place: 'below' or 'above'; written with clefDis. */
  clefDisPlace: string;
  /** MEI staffDef @lines: how many lines the staff has. */
  lines: number;
  /**
   * MEI staffDef @notationtype, for tablature staves: 'tab.guitar' (modern),
   * 'tab.lute.french', 'tab.lute.italian' or 'tab.lute.german'. '' emits
   * none (common notation).
   */
  notationType: string;
  /** Instrument label, written as a <label> child; '' emits none. */
  label: string;
  /** Short label for the systems after the first, written as a <labelAbbr> child; absent or '' emits none. */
  labelAbbr?: string;
  /**
   * The players the staff carries, one layer each in order, written as
   * <layerDef> children labelled with their names; absent or empty emits none.
   */
  layers?: string[];
  /**
   * MEI staffDef @trans.diat and @trans.semi: the interval from written to
   * sounding pitch of a transposing instrument (a clarinet in B♭: -1, -2).
   * Absent or both 0 is no transposition.
   */
  transDiat?: number;
  transSemi?: number;
  /**
   * The staff's own key signature (MEI @keysig) where it differs from the
   * one its transposition gives (`staffKeysig`); absent follows it.
   */
  keysig?: string;
}

/** The key signature a staff is written in: its own, else the score's moved by its transposition. */
export function staffKeysig(scoreKeysig: string, staff: StaffModel): string {
  return (
    staff.keysig ??
    writtenKeysig(scoreKeysig, {
      diat: staff.transDiat ?? 0,
      semi: staff.transSemi ?? 0,
    })
  );
}

/** A run of staves joined by one symbol: a brace (a piano; a pair of horns)
 * or a bracket (a section, like the strings). Staff numbers are 1-based and
 * inclusive. A group within another's staves nests inside it (staff-groups.ts). */
export interface StaffGroupModel {
  /** The staffGrp's xml:id, kept like StaffModel.id. */
  id?: string;
  start: number;
  end: number;
  /** MEI staffGrp @symbol: 'brace' or 'bracket'. */
  symbol: string;
  /** Group label, written as a <label> child; '' emits none. */
  label: string;
  /** Short group label, written as a <labelAbbr> child; absent or '' emits none. */
  labelAbbr?: string;
  /** MEI staffGrp @bar.thru: the barlines run through the group's staves. */
  barThru: boolean;
  /**
   * The staves are one instrument (a piano, a harp: one part over several
   * staves), written as an <instrDef> in the <staffGrp>; false for staves of
   * separate instruments (Horn 1, 2). The score setup sets it on braces
   * only; an instrument of several players on several staves is a bracket
   * of one instrument.
   */
  oneInstrument: boolean;
}

/** The initial score definition: staves with clefs, key signature and meter. */
export interface ScoreDefModel {
  staves: StaffModel[];
  /** Non-overlapping staff groups, each wrapping its staves in a <staffGrp>. */
  groups: StaffGroupModel[];
  /** MEI @keysig: '0' (no accidentals), '1s'…'7s' or '1f'…'7f'. */
  keysig: string;
  /** MEI @meter.count. Unused when meterSym is set. */
  meterCount: string;
  /** MEI @meter.unit. Unused when meterSym is set. */
  meterUnit: string;
  /** MEI @meter.sym: 'common' (C) or 'cut' (¢); '' writes the numeric meter. */
  meterSym: string;
}

/** The score definition a piece carries until its setup task replaces it. */
export const DEFAULT_SCORE_DEF: ScoreDefModel = {
  staves: [
    {
      clefShape: "G",
      clefLine: 2,
      clefDis: "",
      clefDisPlace: "",
      lines: 5,
      notationType: "",
      label: "",
    },
  ],
  groups: [],
  keysig: "0",
  meterCount: "4",
  meterUnit: "4",
  meterSym: "",
};

/** A copy of DEFAULT_SCORE_DEF, safe for a caller to edit. */
const defaultScoreDef = (): ScoreDefModel => ({
  ...DEFAULT_SCORE_DEF,
  staves: DEFAULT_SCORE_DEF.staves.map((staff) => ({ ...staff })),
  groups: [],
});

/** The whole facsimile model — everything buildFacsimileMei needs. */
export interface FacsimileModel {
  /** The `<meiHead>…</meiHead>` block, carried verbatim. */
  headXml: string;
  /** The score definition; absent falls back to DEFAULT_SCORE_DEF. */
  scoreDef?: ScoreDefModel;
  pages: PageModel[];
}

/** One page as measure detection produces it (boxes only, no labels yet). */
export interface FacsimilePage {
  image: string;
  width: number;
  height: number;
  measures: MeasureBox[];
}

/**
 * Group measure boxes into systems (rows), top-to-bottom, each row ordered
 * left-to-right. Boxes are grouped greedily: a box joins the current row if its
 * vertical centre falls above the row's running bottom edge, else it starts a
 * new row. Unit-agnostic — works on normalized or pixel boxes.
 */
export function readingOrderRows(boxes: MeasureBox[]): MeasureBox[][] {
  const byTop = [...boxes].sort((a, b) => a.uly - b.uly);
  const rows: MeasureBox[][] = [];
  let rowBottom = -Infinity;
  for (const box of byTop) {
    const centre = (box.uly + box.lry) / 2;
    if (!rows.length || centre >= rowBottom) {
      rows.push([box]);
      rowBottom = box.lry;
    } else {
      rows[rows.length - 1].push(box);
      rowBottom = Math.max(rowBottom, box.lry);
    }
  }
  return rows.map((row) => [...row].sort((a, b) => a.ulx - b.ulx));
}

/** Sort measure boxes into reading order (readingOrderRows, flattened). */
export function sortReadingOrder(boxes: MeasureBox[]): MeasureBox[] {
  return readingOrderRows(boxes).flat();
}

/**
 * The label following `prevLabel` in the automatic numbering: its leading
 * integer plus one ("10" → "11", "10a" → "11", none/invalid → "1").
 */
export function nextLabel(prevLabel: string | undefined): string {
  const n = parseInt(prevLabel ?? "", 10);
  return String((Number.isNaN(n) ? 0 : n) + 1);
}

/**
 * The labels of a score's measures in reading order. A section start counts
 * from 1, or is 0 when it is a pickup. A pickup inside a section completes
 * the measure before it: the two are numbered as halves (12a, 12b), the
 * first only while its label is automatic. Other measures count on from the
 * previous label (nextLabel). A measure with an `override` takes that label.
 */
export function measureLabels(
  measures: {
    override: string | null;
    pickup: boolean;
    sectionStart: boolean;
  }[],
): string[] {
  const labels: string[] = [];
  measures.forEach((m, i) => {
    const prev = labels[i - 1];
    let auto: string;
    if (m.sectionStart || i === 0) auto = m.pickup ? "0" : "1";
    else if (m.pickup) {
      const base = parseInt(prev, 10) || 0;
      const before = measures[i - 1];
      if (before.override === null && !before.pickup)
        labels[i - 1] = `${base}a`;
      auto = `${base}b`;
    } else auto = nextLabel(prev);
    labels.push(m.override ?? auto);
  });
  return labels;
}

/**
 * The initial model for freshly detected pages: labels numbered continuously
 * across pages in the given order, system flags from the row grouping. The
 * header is left empty — the caller supplies its own headXml (buildPieceHead).
 */
export function initialFacsimileModel(pages: FacsimilePage[]): FacsimileModel {
  let label: string | undefined;
  return {
    headXml: "",
    pages: pages.map((page) => {
      const rows = readingOrderRows(page.measures);
      let firstOfPage = true;
      return {
        image: page.image,
        width: page.width,
        height: page.height,
        zones: rows.flatMap((row) =>
          row.map((box, i) => {
            label = nextLabel(label);
            // The page's first measure carries the page break; other row
            // starts carry a system break. pb and sb stay independent, so a
            // page's first measure does not also default to sb.
            const zone = {
              box,
              label,
              pb: firstOfPage,
              sb: i === 0 && !firstOfPage,
              mdiv: false,
            };
            firstOfPage = false;
            return zone;
          }),
        ),
      };
    }),
  };
}

// The <scoreDef> block at its fixed indentation inside <score>: the key
// signature on the scoreDef, one staffDef per staff carrying its clef, its
// own key signature where it differs from the scoreDef's, its transposition,
// the meter and an optional <label>. keysig '0' means no accidentals and emits no
// attribute. Grouped staves nest in their own <staffGrp>, an inner group
// inside the outer one, with bar.thru where the barlines run through and an
// <instrDef> where a brace's staves are one instrument.
// `optimize` marks a score whose systems leave out staves (@optimize): a
// renderer hides a staff that holds only rests. `withIds` writes the staves'
// and groups' model ids as xml:id; a document has each id once, so only one
// copy of the score definition carries them.
function buildScoreDefXml(
  scoreDef: ScoreDefModel,
  optimize = false,
  withIds = false,
): string {
  const idOf = (id: string | undefined) =>
    withIds && id ? ` xml:id="${xmlEscape(id)}"` : "";
  const keysig =
    scoreDef.keysig === "0" ? "" : ` keysig="${xmlEscape(scoreDef.keysig)}"`;
  const meter = scoreDef.meterSym
    ? `meter.sym="${xmlEscape(scoreDef.meterSym)}"`
    : `meter.count="${xmlEscape(scoreDef.meterCount)}" meter.unit="${xmlEscape(scoreDef.meterUnit)}"`;
  const staffDefXml = (
    staff: StaffModel,
    n: number,
    indent: string,
  ): string => {
    const dis = staff.clefDis
      ? ` clef.dis="${xmlEscape(staff.clefDis)}" clef.dis.place="${xmlEscape(staff.clefDisPlace)}"`
      : "";
    const notation = staff.notationType
      ? ` notationtype="${xmlEscape(staff.notationType)}"`
      : "";
    const trans =
      staff.transDiat || staff.transSemi
        ? ` trans.diat="${staff.transDiat ?? 0}" trans.semi="${staff.transSemi ?? 0}"`
        : "";
    const ownKey = staffKeysig(scoreDef.keysig, staff);
    const key =
      ownKey === scoreDef.keysig ? "" : ` keysig="${xmlEscape(ownKey)}"`;
    // A lute tablature staff carries no clef; the TAB lettering belongs to
    // the modern (guitar) kind only.
    const clef = staff.notationType.startsWith("tab.lute.")
      ? ""
      : ` clef.shape="${xmlEscape(staff.clefShape)}" clef.line="${staff.clefLine}"${dis}`;
    const open =
      `${indent}<staffDef${idOf(staff.id)} n="${n}" lines="${staff.lines}"${notation}${clef}${key}${trans} ` +
      meter;
    const children = [
      ...(staff.label
        ? [`${indent}   <label>${xmlEscape(staff.label)}</label>`]
        : []),
      ...(staff.labelAbbr
        ? [`${indent}   <labelAbbr>${xmlEscape(staff.labelAbbr)}</labelAbbr>`]
        : []),
      ...(staff.layers ?? []).map(
        (name, i) =>
          `${indent}   <layerDef n="${i + 1}"><label>${xmlEscape(name)}</label></layerDef>`,
      ),
    ];
    if (!children.length) return `${open}/>`;
    return `${open}>\n${children.join("\n")}\n${indent}</staffDef>`;
  };
  // Outer groups first, so each group is found before the groups inside it.
  const groups = [...scoreDef.groups].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  );
  const count = scoreDef.staves.length;
  const written = new Set<StaffGroupModel>();
  const rows: string[] = [];
  const emit = (from: number, to: number, indent: string) => {
    let n = from;
    while (n <= to) {
      const group = groups.find(
        (g) => !written.has(g) && g.start === n && Math.min(g.end, count) <= to,
      );
      if (!group) {
        rows.push(staffDefXml(scoreDef.staves[n - 1], n, indent));
        n++;
        continue;
      }
      written.add(group);
      const end = Math.min(group.end, count);
      const thru = group.barThru ? ' bar.thru="true"' : "";
      rows.push(
        `${indent}<staffGrp${idOf(group.id)} symbol="${xmlEscape(group.symbol)}"${thru}>`,
      );
      if (group.label)
        rows.push(`${indent}   <label>${xmlEscape(group.label)}</label>`);
      if (group.labelAbbr)
        rows.push(
          `${indent}   <labelAbbr>${xmlEscape(group.labelAbbr)}</labelAbbr>`,
        );
      if (group.oneInstrument) rows.push(`${indent}   <instrDef/>`);
      emit(n, end, `${indent}   `);
      rows.push(`${indent}</staffGrp>`);
      n = end + 1;
    }
  };
  emit(1, count, "                     ");
  return (
    `               <scoreDef${keysig}${optimize ? ' optimize="true"' : ""}>\n` +
    `                  <staffGrp>\n` +
    rows.join("\n") +
    `\n                  </staffGrp>\n` +
    `               </scoreDef>`
  );
}

// A seed measure's body: one staff per staffDef, each holding a resting
// layer — or, for `empty`, a layer with nothing in it, which renders as bare
// staff lines and leaves the measure's content to come.
function seedStaves(staffCount: number, empty = false): string {
  return Array.from(
    { length: Math.max(1, staffCount) },
    (_, i) =>
      `                  <staff n="${i + 1}">\n` +
      (empty
        ? `                     <layer n="1"/>\n`
        : `                     <layer n="1">\n` +
          `                        <mRest/>\n` +
          `                     </layer>\n`) +
      `                  </staff>\n`,
  ).join("");
}

/**
 * The margin written around each measure zone of a piece prepared by OMR, as
 * a fraction of the page's shorter side. The corrected boxes themselves stay
 * tight in `layout-corrected.json`.
 */
export const MEASURE_ZONE_MARGIN = 0.015;

/** The box grown by `margin` pixels on every side, clamped to the page. */
function grownBox(
  box: MeasureBox,
  margin: number,
  page: { width: number; height: number },
): MeasureBox {
  return {
    ulx: Math.max(0, box.ulx - margin),
    uly: Math.max(0, box.uly - margin),
    lrx: Math.min(page.width, box.lrx + margin),
    lry: Math.min(page.height, box.lry + margin),
  };
}

/**
 * Emit the model as MEI. Stage A (`{}`) contains facsimile zones only; stage C
 * (`{ withBreaks: true }`) adds measures, page/system breaks and movements.
 * `emptyMeasures` gives each measure its staves with empty layers instead of
 * rests: the piece's notation arrives later, from transcription, and nothing
 * is seeded in its place. `padZones` writes each measure zone grown by
 * MEASURE_ZONE_MARGIN; the model's boxes are the tight ones.
 * Every element carries a deterministic xml:id (surface-1, zone-1-2,
 * measure-3, staff-4, …) so rebuilds are stable and diffable.
 */
export function buildFacsimileMei(
  model: FacsimileModel,
  opts: {
    withBreaks?: boolean;
    emptyMeasures?: boolean;
    padZones?: boolean;
  } = {},
): string {
  const withBreaks = Boolean(opts.withBreaks);
  const withMeasures = withBreaks;
  const body = seedStaves(
    (model.scoreDef ?? DEFAULT_SCORE_DEF).staves.length,
    opts.emptyMeasures,
  );
  const scoreDef = model.scoreDef ?? DEFAULT_SCORE_DEF;
  // Some system shows fewer staff boxes than the definition has staves.
  const omits = model.pages.some(
    (page) =>
      page.staves?.length &&
      pageSystems(page).systems.some(
        (system) => system.length > 0 && system.length < scoreDef.staves.length,
      ),
  );
  const surfaces: string[] = [];
  // Section content grouped per movement: mdivParts[k] holds <mdiv> k+1's lines.
  const mdivParts: string[][] = [[]];
  let measureNo = 0;
  // System breaks are numbered in document order; a page break's @n records its
  // page number (the surface ordinal), per the MEI guidelines for <pb>.
  let sbNo = 0;
  const beats = meterBeats(scoreDef);
  // The ending the measures being written belong to, and the endings so far.
  let openEnding: string | null = null;
  let endingNo = 0;
  const closeEnding = () => {
    if (openEnding === null) return;
    mdivParts[mdivParts.length - 1].push(`               </ending>`);
    openEnding = null;
  };

  model.pages.forEach((page, pi) => {
    const p = pi + 1;
    const surfaceId = `surface-${p}`;
    const zones: string[] = [];
    const margin = opts.padZones
      ? Math.round(Math.min(page.width, page.height) * MEASURE_ZONE_MARGIN)
      : 0;

    page.zones.forEach((zone, zi) => {
      measureNo++;
      const zoneId = `zone-${p}-${zi + 1}`;
      const m = margin ? grownBox(zone.box, margin, page) : zone.box;
      zones.push(
        `            <zone xml:id="${zoneId}" type="measure" n="${xmlEscape(zone.label)}" ` +
          `ulx="${Math.round(m.ulx)}" uly="${Math.round(m.uly)}" ` +
          `lrx="${Math.round(m.lrx)}" lry="${Math.round(m.lry)}"/>`,
      );
      if (!withMeasures) return;
      // An ending closes before another ending, a measure of none, or a new
      // movement; a break at the boundary stands outside both endings.
      const ending = zone.ending || null;
      if (ending !== openEnding || (zone.mdiv && measureNo > 1)) closeEnding();
      // A flagged measure opens the next movement (the first one is implicit).
      if (zone.mdiv && measureNo > 1) mdivParts.push([]);
      const parts = mdivParts[mdivParts.length - 1];
      // A page break ties the flow to the page surface and, per the MEI
      // guidelines, implies a system break — so a measure that starts a page
      // emits only the <pb/>, never a redundant <sb/>. A page break's @n is
      // its page number; a system break's @n counts system breaks in order.
      if (zone.pb) {
        parts.push(
          `               <pb xml:id="pb-${p}" n="${p}" facs="#${surfaceId}"/>`,
        );
      } else if (zone.sb) {
        parts.push(
          `               <sb xml:id="sb-${p}-${zi + 1}" n="${++sbNo}"/>`,
        );
      }
      if (ending !== null && openEnding === null) {
        parts.push(
          `               <ending xml:id="ending-${++endingNo}" n="${xmlEscape(ending)}" label="${xmlEscape(ending)}.">`,
        );
        openEnding = ending;
      }
      parts.push(
        `               <measure xml:id="measure-${measureNo}" n="${xmlEscape(zone.label)}"${zone.pickup ? ' metcon="false"' : ""}${zone.rptStart ? ' left="rptstart"' : ""}${zone.rptBoth ? ' right="rptboth"' : zone.rptEnd ? ' right="rptend"' : ""} facs="#${zoneId}">\n` +
          body +
          signsXml(zone.signs, measureNo, beats) +
          `               </measure>`,
      );
    });
    // A page without measure zones (an OMR-prepared piece: its measures come
    // from transcription later) still opens with its page break, so the
    // page's span exists for the per-page tasks.
    if (withMeasures && !page.zones.length) {
      mdivParts[mdivParts.length - 1].push(
        `               <pb xml:id="pb-${p}" n="${p}" facs="#${surfaceId}"/>`,
      );
    }

    if (pi === model.pages.length - 1) closeEnding();
    surfaces.push(
      `         <surface xml:id="${surfaceId}" n="${p}" ulx="0" uly="0" ` +
        `lrx="${page.width}" lry="${page.height}">\n` +
        `            <graphic xml:id="graphic-${p}" target="${xmlEscape(page.image)}" ` +
        `width="${page.width}" height="${page.height}"/>\n` +
        (zones.length ? zones.join("\n") + "\n" : "") +
        `         </surface>`,
    );
  });

  const mdivs = mdivParts.map(
    (parts, i) =>
      `         <mdiv xml:id="mdiv-${i + 1}" n="${i + 1}">\n` +
      `            <score>\n` +
      buildScoreDefXml(scoreDef, omits, i === 0) +
      `\n               <section>\n` +
      (parts.length ? parts.join("\n") + "\n" : "") +
      `               </section>\n` +
      `            </score>\n` +
      `         </mdiv>`,
  );

  return addXmlIds(
    MEI_OPENING +
      model.headXml +
      `\n   <music>\n` +
      `      <facsimile>\n` +
      surfaces.join("\n") +
      `\n      </facsimile>\n` +
      `      <body>\n` +
      mdivs.join("\n") +
      `\n      </body>\n` +
      `   </music>\n` +
      `</mei>`,
  );
}

/**
 * Emit the blank score of a physical piece — one transcribed from the source
 * itself, with no facsimile. With a page count, each page opens with a
 * `<pb facs="#surface-N"/>` marker and holds one seed measure, so per-page
 * tasks address the same `surface-N` locators a facsimile campaign uses (the
 * page-span join replaces a page's content wholesale; see mei-page-splice.ts).
 * Without one, a single seed measure gives the encoder a valid file to start
 * from. Every element carries a deterministic xml:id so rebuilds are stable
 * and diffable.
 */
export function buildBlankScoreMei(
  headXml: string,
  pages = 0,
  scoreDef: ScoreDefModel = DEFAULT_SCORE_DEF,
): string {
  const parts: string[] = [];
  for (let p = 1; p <= Math.max(1, pages); p++) {
    if (pages > 0) {
      parts.push(
        `               <pb xml:id="pb-${p}" n="${p}" facs="#surface-${p}"/>`,
      );
    }
    parts.push(
      `               <measure xml:id="measure-${p}" n="${p}">\n` +
        seedStaves(scoreDef.staves.length) +
        `               </measure>`,
    );
  }
  return addXmlIds(
    MEI_OPENING +
      headXml +
      `\n   <music>\n` +
      `      <body>\n` +
      `         <mdiv xml:id="mdiv-1" n="1">\n` +
      `            <score>\n` +
      buildScoreDefXml(scoreDef, false, true) +
      `\n               <section>\n` +
      parts.join("\n") +
      `\n               </section>\n` +
      `            </score>\n` +
      `         </mdiv>\n` +
      `      </body>\n` +
      `   </music>\n` +
      `</mei>`,
  );
}

/**
 * Swap every `<scoreDef>` block of an MEI document for one built from the
 * model, leaving the measures as they are, and keeping the document's
 * @optimize. The first block carries the model's ids. Used for a piece whose
 * measures hold notation a rebuild would discard.
 */
export function replaceScoreDef(mei: string, scoreDef: ScoreDefModel): string {
  const scoreDefs = [...elementsNamed(mei, "scoreDef", true)];
  const optimize = scoreDefs.some((el) => /\boptimize="true"/.test(el.tag));
  let out = "";
  let last = 0;
  for (const [i, el] of scoreDefs.entries()) {
    out +=
      mei.slice(last, el.start) +
      buildScoreDefXml(scoreDef, optimize, i === 0).trim();
    last = el.end;
  }
  return out + mei.slice(last);
}

/** The staff fields a page task's check of the opening score definition may change. */
export const CHECKED_STAFF_FIELDS = [
  "clefShape",
  "clefLine",
  "clefDis",
  "clefDisPlace",
  "keysig",
  "transDiat",
  "transSemi",
] as const;

/** A score definition without the xml:ids of its staves and groups. */
const withoutIds = (def: ScoreDefModel): ScoreDefModel => ({
  ...def,
  staves: def.staves.map(({ id: _, ...staff }) => staff),
  groups: def.groups.map(({ id: _, ...group }) => group),
});

/**
 * `mei` with its opening score definition (its first `<scoreDef>`) and every
 * later block that repeats it (a movement's copy) built from the model; the
 * other blocks (a key or meter change) stay as they are, and so does the
 * document's @optimize. The opening block carries the model's ids.
 */
export function replaceOpeningScoreDef(
  mei: string,
  scoreDef: ScoreDefModel,
): string {
  const blocks = [...elementsNamed(mei, "scoreDef", true)];
  if (!blocks.length) return mei;
  const plain = (el: (typeof blocks)[number]) =>
    JSON.stringify(withoutIds(parseScoreDef(mei.slice(el.start, el.end))));
  const opening = plain(blocks[0]);
  const optimize = blocks.some((el) => /\boptimize="true"/.test(el.tag));
  let out = "";
  let last = 0;
  for (const [i, el] of blocks.entries()) {
    if (i > 0 && plain(el) !== opening) continue;
    out +=
      mei.slice(last, el.start) +
      buildScoreDefXml(scoreDef, optimize, i === 0).trim();
    last = el.end;
  }
  return out + mei.slice(last);
}

// One attribute's value from an XML tag string, unescaped; null if absent.
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? xmlUnescape(m[1]) : null;
}

/**
 * Parse the first `<scoreDef>` of an MEI document back into the model. The key
 * signature is read from the scoreDef; the meter (symbol, or count and unit)
 * from the scoreDef where it carries one, else from the first staffDef (where
 * buildScoreDefXml writes it). A document without a scoreDef, or one whose
 * scoreDef has no staffDef, yields the default.
 */
export function parseScoreDef(text: string): ScoreDefModel {
  const scoreDefAt = firstElementNamed(text, "scoreDef", true);
  if (!scoreDefAt) return defaultScoreDef();
  const block = text.slice(scoreDefAt.start, scoreDefAt.end);
  const open = scoreDefAt.tag;
  const staves: StaffModel[] = [];
  for (const staffDefAt of elementsNamed(block, "staffDef", true)) {
    const tag = staffDefAt.tag;
    // The staff's own label and short label; its layers' labels sit inside
    // their <layerDef> elements.
    const layerDefs = [...elementsNamed(staffDefAt.inner, "layerDef", true)];
    const own = layerDefs.reduceRight(
      (text, el) => text.slice(0, el.start) + text.slice(el.end),
      staffDefAt.inner,
    );
    const label = firstElementNamed(own, "label")?.inner;
    const labelAbbr = firstElementNamed(own, "labelAbbr")?.inner;
    const layers = layerDefs.map((el) =>
      xmlUnescape((firstElementNamed(el.inner, "label")?.inner ?? "").trim()),
    );
    // A tablature staffDef may carry no clef attributes; its shape is the
    // TAB convention, so the model stays complete.
    const notationType = attr(tag, "notationtype") ?? "";
    const tab = notationType.startsWith("tab");
    const id = attr(tag, "xml:id");
    const staff: StaffModel = {
      ...(id ? { id } : {}),
      clefShape: attr(tag, "clef\\.shape") ?? (tab ? "TAB" : "G"),
      clefLine: Number(attr(tag, "clef\\.line") ?? (tab ? 3 : 2)),
      clefDis: attr(tag, "clef\\.dis") ?? "",
      clefDisPlace: attr(tag, "clef\\.dis\\.place") ?? "",
      lines: Number(attr(tag, "lines") ?? 5),
      notationType,
      label: label ? xmlUnescape(label.trim()) : "",
      ...(labelAbbr ? { labelAbbr: xmlUnescape(labelAbbr.trim()) } : {}),
      ...(layers.length ? { layers } : {}),
    };
    const diat = Number(attr(tag, "trans\\.diat") ?? 0);
    const semi = Number(attr(tag, "trans\\.semi") ?? 0);
    if (diat || semi) {
      staff.transDiat = diat;
      staff.transSemi = semi;
    }
    // A staffDef without a key signature has the scoreDef's; the model keeps
    // a key only where it differs from the one the transposition gives.
    const scoreKeysig = attr(open, "keysig") ?? "0";
    const ownKey = attr(tag, "keysig") ?? scoreKeysig;
    if (ownKey !== staffKeysig(scoreKeysig, staff)) staff.keysig = ownKey;
    staves.push(staff);
  }
  if (!staves.length) return defaultScoreDef();
  // Nested <staffGrp> elements (below the root one) are the staff groups,
  // each spanning the staffDefs it wraps, outer groups before inner ones.
  const groups: StaffGroupModel[] = [];
  let staffNo = 0;
  const pending: Omit<StaffGroupModel, "end">[] = [];
  let depth = 0;
  const tokenRe = /<staffGrp\b[^>]*>|<\/staffGrp>|<staffDef\b/g;
  let token: RegExpExecArray | null;
  while ((token = tokenRe.exec(block))) {
    if (token[0] === "<staffDef") {
      staffNo++;
    } else if (token[0].startsWith("</")) {
      if (depth >= 2) {
        const group = pending.pop()!;
        if (staffNo >= group.start) groups.push({ ...group, end: staffNo });
      }
      depth--;
    } else {
      depth++;
      if (depth >= 2) {
        // A label directly after the open tag names the group (a staff's
        // own label sits inside its staffDef instead), a <labelAbbr> after it
        // gives its short name, and an <instrDef> after those makes the
        // staves one instrument.
        const head =
          /^\s*(?:<label\b[^>]*>([\s\S]*?)<\/label>)?\s*(?:<labelAbbr\b[^>]*>([\s\S]*?)<\/labelAbbr>)?\s*(<instrDef\b)?/.exec(
            block.slice(tokenRe.lastIndex),
          )!;
        const id = attr(token[0], "xml:id");
        pending.push({
          ...(id ? { id } : {}),
          start: staffNo + 1,
          symbol: attr(token[0], "symbol") ?? "bracket",
          label: head[1] ? xmlUnescape(head[1].trim()) : "",
          ...(head[2] ? { labelAbbr: xmlUnescape(head[2].trim()) } : {}),
          barThru: attr(token[0], "bar\\.thru") === "true",
          oneInstrument: !!head[3],
        });
      }
    }
  }
  groups.sort((a, b) => a.start - b.start || b.end - a.end);
  const firstStaff = /<staffDef\b[^>]*>/.exec(block)?.[0] ?? "";
  // A symbol signature implies its numeric meter — common time is 4/4, cut
  // time 2/2 — so the model stays complete either way.
  const meterSym =
    attr(open, "meter\\.sym") ?? attr(firstStaff, "meter\\.sym") ?? "";
  if (meterSym !== "") {
    return {
      staves,
      groups,
      keysig: attr(open, "keysig") ?? "0",
      meterCount: meterSym === "cut" ? "2" : "4",
      meterUnit: meterSym === "cut" ? "2" : "4",
      meterSym,
    };
  }
  return {
    staves,
    groups,
    keysig: attr(open, "keysig") ?? "0",
    meterCount:
      attr(open, "meter\\.count") ?? attr(firstStaff, "meter\\.count") ?? "4",
    meterUnit:
      attr(open, "meter\\.unit") ?? attr(firstStaff, "meter\\.unit") ?? "4",
    meterSym: "",
  };
}

/** What stage the parsed file was at, alongside the model. */
export interface ParsedFacsimile extends FacsimileModel {
  /** Always present on a parse; the default when the document carries none. */
  scoreDef: ScoreDefModel;
  hasMeasures: boolean;
  hasBreaks: boolean;
}

/** The xml:ids of the score's surfaces that hold a measure zone, in document order. */
export function measuredSurfaceIds(text: string): string[] {
  return [...elementsNamed(text, "surface")].flatMap((surface) => {
    const id = attr(surface.tag, "xml:id");
    return id &&
      [...startTags(surface.inner, "zone")].some(({ tag }) =>
        /\btype="measure"/.test(tag),
      )
      ? [id]
      : [];
  });
}

/**
 * Parse a facsimile score (any stage, as emitted by buildFacsimileMei) back
 * into the model. Labels fall back to continuous
 * numbering when zones carry no @n; system flags come from the section's
 * <sb/>/<pb/> tokens where present, else from the row grouping.
 */
export function parseFacsimileMei(text: string): ParsedFacsimile {
  const headAt = firstElementNamed(text, "meiHead");
  if (!headAt) throw new Error("Not a facsimile score: no <meiHead> found.");
  // The header with the indentation in front of its start tag.
  let headStart = headAt.start;
  while (headStart > 0 && /[ \t]/.test(text[headStart - 1])) headStart--;
  const headXml = text.slice(headStart, headAt.end);

  // Which zones the body marks as system/page starts and as movement starts,
  // and which measures it marks as pickups (stage C), keyed by zone id via
  // each measure's facs link. A second or later <mdiv> flags its first
  // measure; the first <mdiv> is implicit.
  const body = firstElementNamed(text, "body")?.inner ?? "";
  const pbZones = new Set<string>();
  const sbZones = new Set<string>();
  const mdivZones = new Set<string>();
  const pickupZones = new Set<string>();
  const rptStartZones = new Set<string>();
  const rptEndZones = new Set<string>();
  const rptBothZones = new Set<string>();
  const endingOf = new Map<string, string>();
  const signsOf = new Map<string, MeasureSign[]>();
  // The ending being read, and the measure the control events after it belong to.
  let ending: string | null = null;
  let lastZone: string | null = null;
  let hasMeasures = false;
  let hasBreaks = false;
  let pendingPb = false;
  let pendingSb = false;
  let pendingMdiv = false;
  let seenMdiv = false;
  // The body's tokens, as the pattern
  // /<(mdiv|pb|sb|measure|ending)\b[^>]*>|<\/ending>|<repeatMark\b[^>]*>|<dir\b[^>]*>[^<]*<\/dir>/g
  // matches them, found in linear time: a start tag ends at the next ">", and
  // a <dir> is a token, with its text, when only text stands before </dir>.
  const tokens: string[] = [];
  const opener = /<(?:mdiv|pb|sb|measure|ending|repeatMark|dir)\b|<\/ending>/g;
  for (let m = opener.exec(body); m; m = opener.exec(body)) {
    if (m[0] === "</ending>") {
      tokens.push(m[0]);
      continue;
    }
    const tagEnd = body.indexOf(">", m.index);
    if (tagEnd < 0) break;
    opener.lastIndex = tagEnd + 1;
    if (m[0] !== "<dir") {
      tokens.push(body.slice(m.index, tagEnd + 1));
      continue;
    }
    const textEnd = body.indexOf("<", tagEnd + 1);
    if (textEnd >= 0 && body.startsWith("</dir>", textEnd)) {
      opener.lastIndex = textEnd + "</dir>".length;
      tokens.push(body.slice(m.index, opener.lastIndex));
    }
  }
  for (const token of tokens) {
    if (token.startsWith("<ending")) {
      ending = attr(token, "n") ?? null;
    } else if (token === "</ending>") {
      ending = null;
    } else if (token.startsWith("<repeatMark") || token.startsWith("<dir")) {
      const sign: MeasureSign | undefined = token.startsWith("<dir")
        ? token.replace(/<[^>]*>/g, "").trim() === SIGN_TEXT.toCoda
          ? "toCoda"
          : undefined
        : MEASURE_SIGNS.find((s) => s === attr(token, "func"));
      if (sign && lastZone) {
        const list = signsOf.get(lastZone) ?? [];
        if (!list.includes(sign)) list.push(sign);
        signsOf.set(lastZone, list);
      }
    } else if (token.startsWith("<mdiv")) {
      if (seenMdiv) pendingMdiv = true;
      seenMdiv = true;
    } else if (token.startsWith("<pb")) {
      pendingPb = true;
      hasBreaks = true;
    } else if (token.startsWith("<sb")) {
      pendingSb = true;
    } else {
      hasMeasures = true;
      const facs = attr(token, "facs");
      if (facs?.startsWith("#")) {
        if (pendingPb) pbZones.add(facs.slice(1));
        if (pendingSb) sbZones.add(facs.slice(1));
        if (pendingMdiv) mdivZones.add(facs.slice(1));
        if (attr(token, "metcon") === "false") pickupZones.add(facs.slice(1));
        if (attr(token, "left") === "rptstart")
          rptStartZones.add(facs.slice(1));
        if (attr(token, "right") === "rptend") rptEndZones.add(facs.slice(1));
        if (attr(token, "right") === "rptboth") rptBothZones.add(facs.slice(1));
        if (ending !== null) endingOf.set(facs.slice(1), ending);
        lastZone = facs.slice(1);
      } else {
        lastZone = null;
      }
      pendingPb = false;
      pendingSb = false;
      pendingMdiv = false;
    }
  }

  const pages: PageModel[] = [];
  let label: string | undefined;
  // A self-closing <surface/> is a complete (zone-less, graphic-less) element,
  // so the first alternative keeps it from swallowing text up to the next
  // </surface>.
  for (const surfaceAt of elementsNamed(text, "surface", true)) {
    const body = surfaceAt.inner;
    const graphic = [...startTags(body, "graphic")][0]?.tag;
    if (!graphic) continue;
    const zones: ZoneModel[] = [];
    const boxesOnly: MeasureBox[] = [];
    for (const { tag } of startTags(body, "zone")) {
      if (attr(tag, "type") !== "measure") continue;
      const box = {
        ulx: Number(attr(tag, "ulx") ?? 0),
        uly: Number(attr(tag, "uly") ?? 0),
        lrx: Number(attr(tag, "lrx") ?? 0),
        lry: Number(attr(tag, "lry") ?? 0),
      };
      label = attr(tag, "n") ?? nextLabel(label);
      const id = attr(tag, "xml:id") ?? "";
      zones.push({
        box,
        label,
        pb: pbZones.has(id),
        sb: sbZones.has(id),
        mdiv: mdivZones.has(id),
        pickup: pickupZones.has(id),
        ...(rptStartZones.has(id) ? { rptStart: true } : {}),
        ...(rptEndZones.has(id) ? { rptEnd: true } : {}),
        ...(rptBothZones.has(id) ? { rptBoth: true } : {}),
        ...(endingOf.has(id) ? { ending: endingOf.get(id) } : {}),
        ...(signsOf.has(id)
          ? {
              signs: MEASURE_SIGNS.filter((s) => signsOf.get(id)!.includes(s)),
            }
          : {}),
      });
      boxesOnly.push(box);
    }
    if (!hasBreaks) {
      // No breaks recorded yet — default the page break to the first measure
      // and suggest system starts for the other row starts (kept independent).
      const rowStarts = new Set(
        readingOrderRows(boxesOnly).map((row) => row[0]),
      );
      const pageFirst = boxesOnly[0];
      for (const zone of zones) {
        zone.pb = zone.box === pageFirst;
        zone.sb = rowStarts.has(zone.box) && zone.box !== pageFirst;
      }
    }
    pages.push({
      image: attr(graphic, "target") ?? "",
      width: Number(attr(graphic, "width") ?? 0),
      height: Number(attr(graphic, "height") ?? 0),
      zones,
    });
  }

  return {
    headXml,
    scoreDef: parseScoreDef(text),
    pages,
    hasMeasures,
    hasBreaks,
  };
}

/** A committed page image a surface can be relinked to. */
export interface FacsimileImage {
  /** Written as the graphic @target; resolved relative to the score file. */
  target: string;
  /** The image's real pixel size, which the surface's coordinates become. */
  width: number;
  height: number;
}

/**
 * Relink an MEI's facsimile to a given sequence of page images: the nth
 * `<surface>` is pointed at the nth image, and that surface's coordinates are
 * scaled from the size its `<graphic>` declared to the image's real pixel size.
 * Surfaces past the end of the sequence, and any without a `<graphic>`, are left
 * as they are.
 *
 * Used on an uploaded encoding, whose facsimile references the files and pixel
 * sizes it was authored against rather than the copies committed alongside it.
 */
export function relinkFacsimileImages(
  mei: string,
  images: FacsimileImage[],
): string {
  let index = 0;
  // A self-closing <surface/> is an element of its own, so it does not
  // swallow text up to the next </surface>.
  const relinked = (surface: string) => {
    const image = images[index++];
    const graphic = /<graphic\b[^>]*>/.exec(surface)?.[0];
    if (!image || !graphic) return surface;
    const width = Number(attr(graphic, "width") ?? 0);
    const height = Number(attr(graphic, "height") ?? 0);
    const sx = width > 0 ? image.width / width : 1;
    const sy = height > 0 ? image.height / height : 1;
    // The surface's own box and its zones are in the coordinate space the
    // graphic declares, so both move with it.
    return surface
      .replace(/<(?:surface|zone)\b[^>]*>/g, (tag) => scaleBox(tag, sx, sy))
      .replace(/<graphic\b[^>]*>/, () =>
        setAttrs(graphic, {
          target: image.target,
          width: image.width,
          height: image.height,
        }),
      );
  };
  let out = "";
  let last = 0;
  for (const el of elementsNamed(mei, "surface", true)) {
    out += mei.slice(last, el.start) + relinked(mei.slice(el.start, el.end));
    last = el.end;
  }
  return out + mei.slice(last);
}

// Scale a tag's bounding box, when it has one; a tag without stays as it is.
function scaleBox(tag: string, sx: number, sy: number): string {
  if (attr(tag, "ulx") === null) return tag;
  return setAttrs(tag, {
    ulx: Math.round(Number(attr(tag, "ulx") ?? 0) * sx),
    uly: Math.round(Number(attr(tag, "uly") ?? 0) * sy),
    lrx: Math.round(Number(attr(tag, "lrx") ?? 0) * sx),
    lry: Math.round(Number(attr(tag, "lry") ?? 0) * sy),
  });
}

// Set attributes on an XML tag string: an attribute already present is
// rewritten in place, one that is absent is appended.
function setAttrs(
  tag: string,
  values: Record<string, string | number>,
): string {
  let out = tag;
  for (const [name, value] of Object.entries(values)) {
    const attribute = `${name}="${xmlEscape(value)}"`;
    const present = new RegExp(`\\b${name}="[^"]*"`);
    out = present.test(out)
      ? out.replace(present, () => attribute)
      : out.replace(/\s*\/?>$/, (end) => ` ${attribute}${end.trimStart()}`);
  }
  return out;
}

/**
 * Swap an MEI document's `<meiHead>` for another. Used on an uploaded encoding
 * once it has been converted: the converter emits its own header, which the
 * campaign replaces with the piece's, so every piece MEI describes itself and
 * its source the same way. A document with no header gets one inserted after
 * the root element's start tag.
 */
export function replaceMeiHead(mei: string, headXml: string): string {
  // A header with content first, else an empty <meiHead/>.
  const head =
    firstElementNamed(mei, "meiHead") ??
    [...elementsNamed(mei, "meiHead", true)].find(
      (el) => el.inner === "" && el.tag.endsWith("/>"),
    ) ??
    null;
  if (head)
    return mei.slice(0, head.start) + headXml.trim() + mei.slice(head.end);
  const root = /<mei\b[^>]*>/.exec(mei);
  if (!root) return mei;
  const at = root.index + root[0].length;
  return `${mei.slice(0, at)}\n${headXml}${mei.slice(at)}`;
}
