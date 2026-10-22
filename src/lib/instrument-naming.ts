// Naming the instruments of an 'omr-instruments' piece in its layout task.
// A person names units: one staff, or the staves a grand-staff box joins
// (a brace), of one system. Each unit shows an instrument of the piece
// (LayoutInstrument in layout-corrected.json): a grand-staff unit all staves
// of a grand-staff instrument, a one-staff unit one score staff of an
// instrument, carrying some of its parts (Flauto I; Posaune 2.3) or all of
// them. The unit's staff boxes take the ids of the score staves they show.
// The first page defines the instruments; once they are confirmed, the other
// pages choose from them. Pure functions, no DOM.

import type {
  MeasureBox,
  ScoreDefModel,
  StaffBox,
  StaffGroupModel,
  StaffModel,
  ZoneModel,
} from "./mei-facsimile.ts";
import {
  grandStaffSpans,
  pageSystems,
  type LayoutInstrument,
  type LayoutInstruments,
} from "./omr-layout.ts";
import { labelScore, suggestStaffAssignment } from "./omr-staff-assign.ts";

/** The boxes of one page that the naming reads. */
export interface NamingPage {
  zones: ZoneModel[];
  staves?: StaffBox[];
  grandstaves?: MeasureBox[];
}

/** One staff, or the staves of one grand staff, of one system. */
export interface NamingUnit {
  /** Page index. */
  page: number;
  /** System index on the page. */
  system: number;
  /** Indices into the page's staff boxes, top to bottom. */
  staves: number[];
}

/** A score staff of an instrument: its id and the parts it carries ([] for an instrument without parts). */
export type InstrumentStaff = LayoutInstrument["staves"][number];

export const NO_INSTRUMENTS: LayoutInstruments = {
  instruments: [],
  groups: [],
  fixed: false,
};

/** The units of every page, page by page, system by system, top to bottom. */
export function namingUnits(pages: NamingPage[]): NamingUnit[] {
  const units: NamingUnit[] = [];
  pages.forEach((page, p) => {
    pageSystems(page).systems.forEach((system, s) => {
      const indices = system.map((box) => (page.staves ?? []).indexOf(box));
      const spans = grandStaffSpans(system, page.grandstaves ?? []);
      let i = 0;
      while (i < system.length) {
        const span = spans.find((sp) => sp.start === i + 1);
        const end = span ? span.end : i + 1;
        units.push({ page: p, system: s, staves: indices.slice(i, end) });
        i = end;
      }
    });
  });
  return units;
}

/** The index of the first page with staves; -1 when there is none. */
export function firstNamingPage(pages: NamingPage[]): number {
  return namingUnits(pages)[0]?.page ?? -1;
}

/**
 * Each system's units as one box each, page by page, in unit order: a grand
 * staff's box spans its staves, so a name printed between them reads as its.
 */
export function unitBoxes(pages: NamingPage[]): MeasureBox[][][] {
  const out: MeasureBox[][][] = pages.map(() => []);
  for (const unit of namingUnits(pages)) {
    const boxes = unit.staves.map((i) => pages[unit.page].staves![i]);
    (out[unit.page][unit.system] ??= []).push({
      ulx: Math.min(...boxes.map((b) => b.ulx)),
      uly: boxes[0].uly,
      lrx: Math.max(...boxes.map((b) => b.lrx)),
      lry: boxes[boxes.length - 1].lry,
    });
  }
  // A system without staves leaves no hole.
  return out.map((systems) => Array.from(systems, (units) => units ?? []));
}

/** What a unit shows: an instrument and the score staff of its first box; null when unnamed. */
export function unitName(
  named: LayoutInstruments,
  page: NamingPage,
  unit: NamingUnit,
): { instrument: LayoutInstrument; staff: InstrumentStaff } | null {
  const first = page.staves?.[unit.staves[0]]?.staff;
  if (!first) return null;
  for (const instrument of named.instruments) {
    const staff = instrument.staves.find((s) => s.id === first);
    if (staff) return { instrument, staff };
  }
  return null;
}

/** The parts a staff carries, by name, joined by "." ("I.II"); '' for an instrument without parts. */
export function partsLabel(
  instrument: LayoutInstrument,
  staff: InstrumentStaff,
): string {
  return staff.parts.map((i) => instrument.parts[i].name).join(".");
}

/**
 * Part names as typed or printed: separated by commas, plus signs, or a full
 * stop followed directly by the next name ("1.2.3", "I.II", "Vc., Cb."). A
 * name keeps a full stop that ends it ("Vc.").
 */
export function parseParts(text: string): string[] {
  return text
    .split(/\s*[,+]\s*|\.(?=[^\s.,+])/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

/** An unused instrument id: i1, i2, … */
function nextInstrumentId(instruments: LayoutInstrument[]): string {
  const used = instruments.map((i) => Number(/^i(\d+)$/.exec(i.id)?.[1] ?? 0));
  return `i${Math.max(0, ...used) + 1}`;
}

/** An unused staff id of an instrument: <instrument>-1, -2, … */
function nextStaffId(instrument: LayoutInstrument): string {
  const used = instrument.staves.map((s) =>
    Number(new RegExp(`^${instrument.id}-(\\d+)$`).exec(s.id)?.[1] ?? 0),
  );
  return `${instrument.id}-${Math.max(0, ...used) + 1}`;
}

const cloneInstruments = (named: LayoutInstruments): LayoutInstrument[] =>
  named.instruments.map((i) => ({
    ...i,
    parts: i.parts.map((p) => ({ ...p })),
    staves: i.staves.map((s) => ({ ...s, parts: [...s.parts] })),
  }));

const sameParts = (a: number[], b: number[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The staff ids for a unit of `size` staves showing `instrument` with
 * `parts` (indices; none = all the instrument has), adding the staves the
 * instrument lacks.
 */
function staffIds(
  instrument: LayoutInstrument,
  size: number,
  parts: number[],
): string[] {
  if (instrument.grand) {
    while (instrument.staves.length < size)
      instrument.staves.push({ id: nextStaffId(instrument), parts: [] });
    return instrument.staves.slice(0, size).map((s) => s.id);
  }
  const wanted = parts.length
    ? [...new Set(parts)].sort((a, b) => a - b)
    : instrument.parts.map((_, i) => i);
  let staff = instrument.staves.find((s) => sameParts(s.parts, wanted));
  if (!staff) {
    staff = { id: nextStaffId(instrument), parts: wanted };
    instrument.staves.push(staff);
  }
  return [staff.id];
}

/**
 * Name a unit of `size` staves on the first page, or add an instrument on a
 * later page: the instrument called `name` (a new one when the piece has none
 * by that name, added to the end of the list, which pruneInstruments puts in
 * score order; a grand staff when the unit has several staves) and, for a one-staff unit, the
 * parts `partsText` names (parseParts; added to the instrument's parts as
 * needed; none = all it has). `added` marks a new instrument with the page it was
 * added on. Returns the instruments and the staff ids for the unit's boxes;
 * an empty name returns the unit's boxes without ids.
 */
export function nameUnit(
  named: LayoutInstruments,
  size: number,
  name: string,
  partsText = "",
  added?: number,
): { named: LayoutInstruments; staves: (string | undefined)[] } {
  const trimmed = name.trim();
  if (!trimmed)
    return { named, staves: Array.from({ length: size }, () => undefined) };
  const instruments = cloneInstruments(named);
  let instrument = instruments.find((i) => i.name === trimmed);
  if (!instrument) {
    instrument = {
      id: nextInstrumentId(instruments),
      name: trimmed,
      abbr: "",
      grand: size > 1,
      parts: [],
      staves: [],
      ...(added ? { added } : {}),
    };
    instruments.push(instrument);
  }
  const own = instrument;
  let parts: number[] = [];
  if (!own.grand) {
    parts = parseParts(partsText).map((partName) => {
      const at = own.parts.findIndex((p) => p.name === partName);
      if (at >= 0) return at;
      own.parts.push({ name: partName });
      return own.parts.length - 1;
    });
  }
  return {
    named: { ...named, instruments },
    staves: staffIds(own, size, parts),
  };
}

/**
 * Show an instrument of the list on a unit of `size` staves, with `parts`
 * (indices; none = all) for a one-staff unit. Returns the instruments with any
 * staff the combination needs added, and the staff ids for the unit's boxes.
 */
export function assignUnit(
  named: LayoutInstruments,
  size: number,
  instrumentId: string,
  parts: number[] = [],
): { named: LayoutInstruments; staves: string[] } {
  const instruments = cloneInstruments(named);
  const instrument = instruments.find((i) => i.id === instrumentId);
  if (!instrument) throw new Error(`Unknown instrument ${instrumentId}.`);
  return {
    named: { ...named, instruments },
    staves: staffIds(instrument, size, parts),
  };
}

/**
 * The instruments with only the staves some box shows, without the
 * instruments left with none, in score order: the order in which they first
 * appear, page by page, system by system, top to bottom. Groups keep the
 * instruments they still span: a group whose first or last instrument is
 * gone moves its end inward, and a group left without instruments is
 * dropped.
 */
export function pruneInstruments(
  named: LayoutInstruments,
  pages: NamingPage[],
): LayoutInstruments {
  const used = new Set(
    pages.flatMap((page) =>
      (page.staves ?? []).flatMap((s) => (s.staff ? [s.staff] : [])),
    ),
  );
  const firstSeen = new Map<string, number>();
  namingUnits(pages).forEach((unit, k) => {
    const shown = unitName(named, pages[unit.page], unit);
    if (shown && !firstSeen.has(shown.instrument.id))
      firstSeen.set(shown.instrument.id, k);
  });
  const instruments = named.instruments
    .map((i) => ({ ...i, staves: i.staves.filter((s) => used.has(s.id)) }))
    .filter((i) => i.staves.length > 0)
    .sort(
      (a, b) =>
        (firstSeen.get(a.id) ?? Infinity) - (firstSeen.get(b.id) ?? Infinity),
    );
  const order = instruments.map((i) => i.id);
  const position = (id: string) =>
    named.instruments.findIndex((i) => i.id === id);
  const groups = named.groups.flatMap((g) => {
    const members = new Set(
      named.instruments
        .slice(position(g.first), position(g.last) + 1)
        .map((i) => i.id),
    );
    const span = order.filter((id) => members.has(id));
    return span.length
      ? [{ ...g, first: span[0], last: span[span.length - 1] }]
      : [];
  });
  return { ...named, instruments, groups };
}

/**
 * Why the naming of `only` (page indices; all pages when absent) is not
 * complete, or null when every unit there is named and no system shows an
 * instrument's staff, or one of its parts, twice.
 */
export function namingProblem(
  named: LayoutInstruments,
  pages: NamingPage[],
  only?: number[],
): string | null {
  const within = (p: number) => !only || only.includes(p);
  const units = namingUnits(pages).filter((u) => within(u.page));
  const unnamed = units.filter((u) => !unitName(named, pages[u.page], u));
  if (unnamed.length) {
    const ps = [...new Set(unnamed.map((u) => u.page + 1))];
    return `Name every staff: ${unnamed.length} ${unnamed.length === 1 ? "staff is" : "staves are"} unnamed on ${ps.length === 1 ? "page" : "pages"} ${ps.join(", ")}.`;
  }
  const systems = new Map<string, NamingUnit[]>();
  for (const unit of units) {
    const key = `${unit.page}/${unit.system}`;
    systems.set(key, [...(systems.get(key) ?? []), unit]);
  }
  for (const list of systems.values()) {
    const { page, system } = list[0];
    const seen = new Map<string, Set<number>>();
    for (const unit of list) {
      const { instrument, staff } = unitName(named, pages[page], unit)!;
      const parts = new Set(
        instrument.grand || instrument.parts.length === 0 ? [0] : staff.parts,
      );
      const before = seen.get(instrument.id) ?? new Set<number>();
      if ([...parts].some((x) => before.has(x)))
        return `Page ${page + 1}, system ${system + 1}: ${instrument.name} is named on two staves${instrument.parts.length ? " with the same part" : ""}.`;
      seen.set(instrument.id, new Set([...before, ...parts]));
    }
  }
  return null;
}

/**
 * The score definition the named instruments make, on `base`: their score
 * staves in score order, each with its staffDef xml:id. A one-player
 * instrument's staff carries its full and short name; a grand-staff
 * instrument is a brace group of one instrument with its names; an
 * instrument with parts is a bracket group of one instrument with its names,
 * whose staves are labelled with the parts they carry (the staff carrying
 * all of them first) and declare one layer per part where they carry
 * several. A staff `base` already defines (same id) keeps its clef, lines and
 * transposition; a new one gets a treble clef, or a bass clef as a lower
 * staff of a grand staff. The key and meter are `base`'s. The groups of
 * instruments span their instruments' staves.
 */
export function instrumentScoreDef(
  named: LayoutInstruments,
  base: ScoreDefModel,
): ScoreDefModel {
  const known = new Map(
    base.staves.flatMap((staff) => (staff.id ? [[staff.id, staff]] : [])),
  );
  const staves: StaffModel[] = [];
  const groups: StaffGroupModel[] = [];
  const span = new Map<string, { start: number; end: number }>();
  const firstPart = (s: InstrumentStaff) =>
    s.parts.length === 0 ? -1 : s.parts[0];
  for (const instrument of named.instruments) {
    const start = staves.length + 1;
    const withParts = instrument.parts.length > 0;
    const ordered = instrument.grand
      ? instrument.staves
      : [...instrument.staves].sort(
          (a, b) =>
            firstPart(a) - firstPart(b) || b.parts.length - a.parts.length,
        );
    ordered.forEach((staff, k) => {
      const kept = known.get(staff.id);
      const lower = instrument.grand && k > 0;
      const carried = staff.parts;
      const label = instrument.grand
        ? { label: "", labelAbbr: "" }
        : withParts
          ? {
              label: partsLabel(instrument, staff),
              labelAbbr: partsLabel(instrument, staff),
            }
          : { label: instrument.name, labelAbbr: instrument.abbr };
      staves.push({
        ...(kept ?? {
          clefShape: lower ? "F" : "G",
          clefLine: lower ? 4 : 2,
          clefDis: "",
          clefDisPlace: "",
          lines: 5,
          notationType: "",
        }),
        id: staff.id,
        ...label,
        layers:
          withParts && carried.length > 1
            ? carried.map((i) => instrument.parts[i].name)
            : [],
      });
    });
    const end = staves.length;
    span.set(instrument.id, { start, end });
    if (instrument.grand || withParts)
      groups.push({
        id: instrument.id,
        start,
        end,
        symbol: instrument.grand ? "brace" : "bracket",
        label: instrument.name,
        labelAbbr: instrument.abbr,
        barThru: true,
        oneInstrument: true,
      });
  }
  for (const group of named.groups) {
    const first = span.get(group.first);
    const last = span.get(group.last);
    if (!first || !last) continue;
    groups.push({
      id: group.id,
      start: first.start,
      end: last.end,
      symbol: group.symbol,
      label: group.label,
      labelAbbr: "",
      barThru: group.barThru,
      oneInstrument: false,
    });
  }
  groups.sort((a, b) => a.start - b.start || b.end - a.end);
  return { ...base, staves, groups };
}

// --------------------------------------------------------------- suggestions

/** A printed label's trailing part names ("Flauto I", "Pos. 1.2.3"): the name before them and the parts. */
export function splitLabel(label: string): { name: string; parts: string } {
  const m =
    /^(.*?\S)[\s.]+((?:[IVX]+|\d+)(?:\s*[.,]\s*(?:[IVX]+|\d+))*)\.?$/.exec(
      label.trim(),
    );
  return m
    ? { name: m[1], parts: m[2].replace(/\s+/g, "") }
    : { name: label.trim(), parts: "" };
}

/**
 * A printed label as an instrument name: without what is in parentheses
 * (also the end of a parenthesis that opened in the label above) and
 * without a final full stop.
 */
export const printedName = (label: string): string =>
  label
    .replace(/^[^(]*\)/, "")
    .replace(/\([^)]*\)?/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");

/** The units of the pages `only` admits, by system, and each unit's printed label. */
function systemsOf(
  pages: NamingPage[],
  labels: string[][][],
  only: (page: number) => boolean,
): { units: NamingUnit[]; label: (u: NamingUnit) => string }[] {
  const systems = new Map<string, NamingUnit[]>();
  for (const unit of namingUnits(pages)) {
    if (!only(unit.page)) continue;
    const key = `${unit.page}/${unit.system}`;
    systems.set(key, [...(systems.get(key) ?? []), unit]);
  }
  return [...systems.values()].map((units) => ({
    units,
    label: (u: NamingUnit) =>
      (labels[u.page]?.[u.system]?.[units.indexOf(u)] ?? "")
        .trim()
        .replace(/\s+/g, " "),
  }));
}

/**
 * The first page's instruments from what is printed in front of its staves:
 * for each unit nobody named, the name before trailing part names becomes
 * the instrument (printedName) and those part names its parts on this staff,
 * so "Flauto I" and "Flauto II" make one instrument with two parts. A grand
 * staff takes its whole label as the name. A unit without a label stays
 * unnamed. `labels` holds the printed labels by page and system, in unit
 * order (unitBoxes), '' for none.
 */
export function suggestFirstPage(
  pages: NamingPage[],
  named: LayoutInstruments,
  labels: string[][][],
): { unit: NamingUnit; name: string; parts: string }[] {
  const first = firstNamingPage(pages);
  const out: { unit: NamingUnit; name: string; parts: string }[] = [];
  for (const { units, label } of systemsOf(pages, labels, (p) => p === first)) {
    for (const unit of units) {
      if (unitName(named, pages[unit.page], unit)) continue;
      const printed = printedName(label(unit));
      if (!printed) continue;
      const split =
        unit.staves.length > 1
          ? { name: printed, parts: "" }
          : splitLabel(printed);
      const name = printedName(split.name);
      if (name) out.push({ unit, name, parts: split.parts });
    }
  }
  return out;
}

/**
 * For the units nobody named on the pages `fill` admits (by default those
 * after the first), the instrument staff each shows from the instruments
 * named so far, system by system, each read with the system before it (on
 * the first page as well, so its later systems follow its first one). A staff of
 * the list is a slot: a grand-staff instrument (all its staves), or one score
 * staff of another instrument, labelled with the instrument's name and
 * parts. A unit whose printed label reads as one slot's full or short name
 * takes it (of equal readings the slot carrying more parts); in a system
 * with no more units than the piece has slots the others are placed by
 * suggestStaffAssignment (labels, the slots of the system before, staff
 * spacing), and a unit it gives a slot of another size takes the next free
 * slot of its size in score order. A unit only takes a slot of its size and
 * no slot twice in a system. A unit still without one stays unnamed.
 */
export function suggestFromList(
  pages: NamingPage[],
  named: LayoutInstruments,
  labels: string[][][],
  fill?: (page: number) => boolean,
): { unit: NamingUnit; instrument: string; parts: number[] }[] {
  type Slot = {
    instrument: LayoutInstrument;
    parts: number[];
    size: number;
    full: string;
    short: string;
  };
  const slots: Slot[] = named.instruments.flatMap((instrument): Slot[] =>
    instrument.grand
      ? [
          {
            instrument,
            parts: [],
            size: instrument.staves.length,
            full: instrument.name,
            short: instrument.abbr,
          },
        ]
      : instrument.staves.map((staff) => {
          const parts = partsLabel(instrument, staff);
          return {
            instrument,
            parts: staff.parts,
            size: 1,
            full: `${instrument.name} ${parts}`.trim(),
            short: instrument.abbr ? `${instrument.abbr} ${parts}`.trim() : "",
          };
        }),
  );
  const fullNames = slots.map((s) => s.full);
  const shortNames = slots.map((s) => s.short || s.full);
  const slotOf = (shown: {
    instrument: LayoutInstrument;
    staff: InstrumentStaff;
  }) =>
    slots.findIndex(
      (s) =>
        s.instrument.id === shown.instrument.id &&
        (s.instrument.grand || sameParts(s.parts, shown.staff.parts)),
    );
  const first = firstNamingPage(pages);
  const out: { unit: NamingUnit; instrument: string; parts: number[] }[] = [];
  let previous: number[] = [];
  for (const { units, label } of systemsOf(pages, labels, (p) => p >= first)) {
    const page = pages[units[0].page];
    const chosen = new Map<NamingUnit, number>();
    const taken = new Set<number>();
    for (const unit of units) {
      const shown = unitName(named, page, unit);
      const k = shown ? slotOf(shown) : -1;
      if (k >= 0) {
        chosen.set(unit, k);
        taken.add(k);
      }
    }
    const fits = (unit: NamingUnit, k: number) =>
      !taken.has(k) && slots[k].size === unit.staves.length;
    if (fill ? fill(units[0].page) : units[0].page !== first) {
      // Labels first: the full or the short name, with any part names.
      for (const unit of units) {
        const printed = label(unit);
        if (chosen.has(unit) || !printed) continue;
        let best = -1;
        let score = 0;
        slots.forEach((slot, k) => {
          const v = Math.max(
            labelScore(printed, slot.full, fullNames),
            slot.short ? labelScore(printed, slot.short, shortNames) : 0,
          );
          // Of equal readings, the staff carrying more parts: a printed
          // name without part names is the shared staff.
          const better =
            v > score ||
            (v === score &&
              best >= 0 &&
              slot.parts.length > slots[best].parts.length);
          if (v > 0 && better && fits(unit, k)) {
            best = k;
            score = v;
          }
        });
        if (best >= 0) {
          chosen.set(unit, best);
          taken.add(best);
        }
      }
      // Then the places, where the system has no more units than slots.
      if (slots.length >= units.length) {
        const boxes = page.staves ?? [];
        const placed = suggestStaffAssignment(
          units.map((unit) => ({
            box: {
              ulx: Math.min(...unit.staves.map((i) => boxes[i].ulx)),
              uly: boxes[unit.staves[0]].uly,
              lrx: Math.max(...unit.staves.map((i) => boxes[i].lrx)),
              lry: boxes[unit.staves[unit.staves.length - 1]].lry,
            },
            clef: null,
            label: label(unit),
          })),
          slots.map((s) => ({ clef: "", label: s.full })),
          undefined,
          { previous: previous.map((k) => k + 1) },
        );
        units.forEach((unit, i) => {
          const k = placed[i] - 1;
          if (chosen.has(unit) || k < 0 || !fits(unit, k)) return;
          chosen.set(unit, k);
          taken.add(k);
        });
        // A unit the places gave a slot of another size takes the next
        // free slot of its size below the unit above it, one the system
        // before showed first.
        let floor = -1;
        for (const unit of units) {
          const k = chosen.get(unit);
          if (k !== undefined) {
            floor = k;
            continue;
          }
          const free = slots
            .map((_, j) => j)
            .filter((j) => j > floor && fits(unit, j));
          const next = free.find((j) => previous.includes(j)) ?? free[0];
          if (next === undefined) continue;
          chosen.set(unit, next);
          taken.add(next);
          floor = next;
        }
      }
      for (const unit of units) {
        const k = chosen.get(unit);
        if (k === undefined || unitName(named, page, unit)) continue;
        out.push({
          unit,
          instrument: slots[k].instrument.id,
          parts: slots[k].parts,
        });
      }
    }
    previous = units.flatMap((u) => {
      const k = chosen.get(u);
      return k === undefined ? [] : [k];
    });
  }
  return out;
}
