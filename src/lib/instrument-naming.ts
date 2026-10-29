// Naming the instruments of an 'omr-instruments' piece in its layout task.
// A person names units: one staff, or the staves a grand-staff box joins
// (a brace), of one system. Each unit shows an instrument of the piece
// (LayoutInstrument in layout-corrected.json): a grand-staff unit the staves
// of a grand-staff instrument, a one-staff unit one score staff of an
// instrument, each carrying some of the instrument's parts (Flauto I;
// Posaune 2.3; Harfe 1 on a grand staff) or all of them. The unit's staff boxes take the ids of the score staves they show.
// The first system defines the instruments; once they are confirmed, the
// other systems choose from them. Pure functions, no DOM.

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
import {
  labelNumerals,
  labelScore,
  suggestStaffAssignment,
} from "./omr-staff-assign.ts";
import { proposeScoreDef, readAttributes } from "./omr-musicxml.ts";
import { sameBox, type OmrRecord } from "./omr-record.ts";
import { xmlEscape } from "./mei-xml.ts";
import type { UnprintedStaff } from "./omr-draft.ts";

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

/** A system of a page: page index, and system index on the page. */
export interface NamingSystem {
  page: number;
  system: number;
}

/** The first system with staves, where the instruments are defined; null when there is none. */
export function firstNamingSystem(pages: NamingPage[]): NamingSystem | null {
  const unit = namingUnits(pages)[0];
  return unit ? { page: unit.page, system: unit.system } : null;
}

/** Whether a unit belongs to `system`. */
export const inSystem = (system: NamingSystem | null, unit: NamingUnit) =>
  system !== null && unit.page === system.page && unit.system === system.system;

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

// ----------------------------------------------------------- score staves

/** A score staff of the named instruments: an instrument's k-th staff from the top in a system. */
export interface PlannedStaff {
  /** Its staffDef xml:id, `<instrument>-staff<k>`. */
  id: string;
  instrument: LayoutInstrument;
  /** k: its place among the instrument's staves, from 1. */
  position: number;
  /** Every part it carries in some system, ascending; [] for an instrument without parts. */
  parts: number[];
  /** It carries the same parts in every system that prints it. */
  sameParts: boolean;
  /** Where it is first printed: page index and index of the page's staff box; null for never. */
  first: { page: number; box: number } | null;
}

/** A system and, per staff box (index into its page's boxes), the score staff n it prints and the parts it carries there. */
export interface PlannedSystem {
  page: number;
  system: number;
  boxes: Map<number, { n: number; parts: number[] }>;
}

/** The score staves of the named instruments and what each system prints of them. */
export interface StaffPlan {
  staves: PlannedStaff[];
  /** Every system with staff boxes, page by page, top to bottom. */
  systems: PlannedSystem[];
}

/**
 * The score staves the named instruments need, and where each system's staff
 * boxes go. An instrument has as many score staves as it prints at once at
 * most in one system; its boxes in a system, top to bottom (a grand staff's
 * one by one), are its score staves 1, 2, …, each carrying the parts its unit
 * is named with. The staves follow the instruments' order. A box of an
 * unnamed unit goes to no staff.
 */
export function staffPlan(
  named: LayoutInstruments,
  pages: NamingPage[],
): StaffPlan {
  type Placed = {
    box: number;
    instrument: LayoutInstrument;
    position: number;
    parts: number[];
  };
  const systems: { page: number; system: number; placed: Placed[] }[] = [];
  const count = new Map<LayoutInstrument, number>();
  for (const unit of namingUnits(pages)) {
    let current = systems[systems.length - 1];
    if (current?.page !== unit.page || current.system !== unit.system) {
      current = { page: unit.page, system: unit.system, placed: [] };
      systems.push(current);
    }
    const shown = unitName(named, pages[unit.page], unit);
    if (!shown) continue;
    for (const box of unit.staves) {
      const position =
        current.placed.filter((x) => x.instrument === shown.instrument).length +
        1;
      current.placed.push({
        box,
        instrument: shown.instrument,
        position,
        parts: shown.staff.parts,
      });
      count.set(
        shown.instrument,
        Math.max(count.get(shown.instrument) ?? 0, position),
      );
    }
  }
  const staves: PlannedStaff[] = [];
  const numberOf = new Map<string, number>();
  for (const instrument of named.instruments) {
    for (let k = 1; k <= (count.get(instrument) ?? 0); k++) {
      const shown = systems.flatMap((s) =>
        s.placed
          .filter((x) => x.instrument === instrument && x.position === k)
          .map((x) => ({ page: s.page, box: x.box, parts: x.parts })),
      );
      staves.push({
        id: `${instrument.id}-staff${k}`,
        instrument,
        position: k,
        parts: [...new Set(shown.flatMap((x) => x.parts))].sort(
          (a, b) => a - b,
        ),
        sameParts: new Set(shown.map((x) => x.parts.join(","))).size <= 1,
        first: shown[0] ? { page: shown[0].page, box: shown[0].box } : null,
      });
      numberOf.set(`${instrument.id}#${k}`, staves.length);
    }
  }
  return {
    staves,
    systems: systems.map((s) => ({
      page: s.page,
      system: s.system,
      boxes: new Map(
        s.placed.map((x) => [
          x.box,
          {
            n: numberOf.get(`${x.instrument.id}#${x.position}`)!,
            parts: x.parts,
          },
        ]),
      ),
    })),
  };
}

/** Per page (index), each staff box's score staff n (staffPlan); a box of no staff is absent. */
export const plannedBoxes = (
  plan: StaffPlan,
  pageCount: number,
): Map<number, number>[] =>
  Array.from(
    { length: pageCount },
    (_, p) =>
      new Map(
        plan.systems
          .filter((s) => s.page === p)
          .flatMap((s) => [...s.boxes].map(([box, at]) => [box, at.n])),
      ),
  );

/** A planned system's index, by page and system index; -1 for a system without staff boxes. */
export const plannedSystemIndex = (
  plan: StaffPlan,
  page: number,
  system: number,
): number =>
  plan.systems.findIndex((s) => s.page === page && s.system === system);

/**
 * Per planned system, per score staff (n − 1): whether the system prints it,
 * and the parts it carries there; a staff the system does not print keeps
 * the parts it last carried, before its first printing those it first
 * carries.
 */
export function staffStates(
  plan: StaffPlan,
): { visible: boolean; parts: number[] }[][] {
  const current = plan.staves.map((_, i) => {
    for (const system of plan.systems)
      for (const at of system.boxes.values())
        if (at.n === i + 1) return at.parts;
    return [] as number[];
  });
  return plan.systems.map((system) => {
    const printed = new Map([...system.boxes.values()].map((at) => [at.n, at]));
    return plan.staves.map((_, i) => {
      const at = printed.get(i + 1);
      if (at) current[i] = at.parts;
      return { visible: !!at, parts: current[i] };
    });
  });
}

/**
 * A staff's full and short name where it carries `parts`: the instrument's
 * names, followed by the part where it carries one ("Flöte I"), or where the
 * parts are instruments the part's own names ("Kontrabass"); none for a
 * staff of a grand-staff instrument, whose brace carries them.
 */
export function plannedLabels(
  staff: PlannedStaff,
  parts: number[],
): { label: string; labelAbbr: string } {
  const { instrument } = staff;
  if (instrument.grand) return { label: "", labelAbbr: "" };
  const own =
    instrument.partsAreInstruments && parts.length === 1
      ? instrument.parts[parts[0]]
      : undefined;
  if (own) return { label: own.name, labelAbbr: own.abbr ?? "" };
  const part =
    parts.length === 1 && instrument.parts[parts[0]]
      ? ` ${instrument.parts[parts[0]].name}`
      : "";
  return {
    label: `${instrument.name}${part}`,
    labelAbbr: instrument.abbr ? `${instrument.abbr}${part}` : "",
  };
}

/**
 * The instrument a planned staff is played by, by name: its first part's
 * where the parts are instruments ("Kontrabass"), else the instrument's.
 */
export function staffInstrumentName(staff: PlannedStaff): string {
  const { instrument } = staff;
  const first = instrument.partsAreInstruments
    ? instrument.parts[staff.parts[0]]
    : undefined;
  return first?.name ?? instrument.name;
}

/**
 * `def` with each layer that is an instrument of its own transposed as the
 * score staff that carries its part alone (the Kontrabass layer of a shared
 * staff as the Kontrabass staff); a layer whose part no staff carries alone
 * has no transposition.
 */
export function withLayerTranspositions(
  def: ScoreDefModel,
  plan: StaffPlan,
): ScoreDefModel {
  const byId = new Map(
    def.staves.flatMap((staff) => (staff.id ? [[staff.id, staff]] : [])),
  );
  return {
    ...def,
    staves: def.staves.map((staff) => {
      const planned = plan.staves.find((s) => s.id === staff.id);
      if (!planned || !staff.layers?.some((l) => l.instrument)) return staff;
      return {
        ...staff,
        layers: staff.layers.map((layer) => {
          if (!layer.instrument) return layer;
          const alone = plan.staves.find(
            (s) =>
              s.instrument === planned.instrument &&
              s.parts.length === 1 &&
              s.parts[0] === layer.n - 1,
          );
          const source = alone ? byId.get(alone.id) : undefined;
          const { transDiat: _d, transSemi: _s, ...rest } = layer;
          return source?.transDiat || source?.transSemi
            ? {
                ...rest,
                transDiat: source.transDiat ?? 0,
                transSemi: source.transSemi ?? 0,
              }
            : rest;
        }),
      };
    }),
  };
}

/**
 * The `<scoreDef>` that opens planned system `g` where a staff's visibility
 * or label differs from the system before it: the changed staves'
 * `<staffDef>`s with @visible, <label> and <labelAbbr>; '' for the first
 * system and where nothing changes.
 */
export function systemScoreDef(
  plan: StaffPlan,
  states: { visible: boolean; parts: number[] }[][],
  g: number,
): string {
  if (g <= 0 || !states[g]) return "";
  const defs = plan.staves.flatMap((staff, i) => {
    const before = states[g - 1][i];
    const now = states[g][i];
    const was = plannedLabels(staff, before.parts);
    const is = plannedLabels(staff, now.parts);
    const relabel =
      now.visible && (was.label !== is.label || was.labelAbbr !== is.labelAbbr);
    if (before.visible === now.visible && !relabel) return [];
    const names = relabel
      ? (is.label ? `<label>${xmlEscape(is.label)}</label>` : "") +
        (is.labelAbbr
          ? `<labelAbbr>${xmlEscape(is.labelAbbr)}</labelAbbr>`
          : "")
      : "";
    const open = `<staffDef n="${i + 1}" visible="${now.visible}"`;
    return [names ? `${open}>${names}</staffDef>` : `${open}/>`];
  });
  return defs.length
    ? `<scoreDef><staffGrp>${defs.join("")}</staffGrp></scoreDef>`
    : "";
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

const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };

/** A part name's number: arabic ("2") or roman ("IV"); null for any other name. */
function partNumber(name: string): number | null {
  if (/^\d+$/.test(name)) return Number(name);
  if (!/^[IVXLC]+$/i.test(name)) return null;
  const digits = [...name.toUpperCase()].map((c) => ROMAN[c]);
  return digits.reduce(
    (sum, d, i) => sum + (d < (digits[i + 1] ?? 0) ? -d : d),
    0,
  );
}

/**
 * Add the parts `names` to an instrument's parts, in the order given: the
 * named parts move to where the first of them that the instrument has stands,
 * new ones there or at the end. Parts that are all numbers stand in numeric
 * order. The staves' part indices follow. Returns the indices of `names`.
 */
function orderParts(instrument: LayoutInstrument, names: string[]): number[] {
  const old = instrument.parts.map((p) => p.name);
  const typed = [...new Set(names)];
  const anchor = old.findIndex((n) => typed.includes(n));
  const rest = old.filter((n) => !typed.includes(n));
  const at =
    anchor < 0
      ? rest.length
      : old.slice(0, anchor).filter((n) => !typed.includes(n)).length;
  let order = [...rest.slice(0, at), ...typed, ...rest.slice(at)];
  const numbers = order.map(partNumber);
  if (numbers.every((n) => n !== null))
    order = order
      .map((n, i) => ({ n, v: numbers[i]! }))
      .sort((a, b) => a.v - b.v)
      .map((x) => x.n);
  const moved = old.map((n) => order.indexOf(n));
  instrument.parts = order.map((name) => ({ name }));
  for (const staff of instrument.staves)
    staff.parts = staff.parts.map((i) => moved[i]).sort((a, b) => a - b);
  return names.map((n) => order.indexOf(n));
}

/**
 * The staff ids for a unit of `size` staves showing `instrument` with
 * `parts` (indices; none = all the instrument has), adding the staves the
 * instrument lacks. A grand-staff instrument has `size` staves for each
 * combination of parts.
 */
function staffIds(
  instrument: LayoutInstrument,
  size: number,
  parts: number[],
): string[] {
  const wanted = parts.length
    ? [...new Set(parts)].sort((a, b) => a - b)
    : instrument.parts.map((_, i) => i);
  if (instrument.grand) {
    const ids = instrument.staves
      .filter((s) => sameParts(s.parts, wanted))
      .map((s) => s.id);
    while (ids.length < size) {
      const id = nextStaffId(instrument);
      instrument.staves.push({ id, parts: wanted });
      ids.push(id);
    }
    return ids.slice(0, size);
  }
  let staff = instrument.staves.find((s) => sameParts(s.parts, wanted));
  if (!staff) {
    staff = { id: nextStaffId(instrument), parts: wanted };
    instrument.staves.push(staff);
  }
  return [staff.id];
}

/**
 * Name a unit of `size` staves in the first system, or add an instrument in a
 * later system: the instrument called `name` (a new one when the piece has none
 * by that name, added to the end of the list, which pruneInstruments puts in
 * score order; a grand staff when the unit has several staves) and the
 * parts `partsText` names (parseParts; added to and ordered in the
 * instrument's parts by orderParts; none = all it has). `added` marks a new instrument with the page it was
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
  const parts = orderParts(instrument, parseParts(partsText));
  return {
    named: { ...named, instruments },
    staves: staffIds(instrument, size, parts),
  };
}

/**
 * The instruments with the parts of the instrument called `name` taken away,
 * for `unit` of the first system named with it and no parts, where no other
 * unit of `first` (the first system's units) shows that instrument: it keeps
 * one staff without parts, and `staves` maps each staff id it had to that
 * staff's, for the boxes that showed them. Null where there is nothing to
 * take away: no such instrument, one without parts, a grand-staff
 * instrument, or another unit of the first system showing it.
 */
export function dropParts(
  named: LayoutInstruments,
  pages: NamingPage[],
  unit: NamingUnit,
  name: string,
  first: (unit: NamingUnit) => boolean,
): { named: LayoutInstruments; staves: Map<string, string> } | null {
  const target = named.instruments.find((i) => i.name === name.trim());
  if (!target || !target.parts.length || target.grand) return null;
  const same = (u: NamingUnit) =>
    u.page === unit.page && u.staves[0] === unit.staves[0];
  if (
    namingUnits(pages).some(
      (u) =>
        first(u) &&
        !same(u) &&
        unitName(named, pages[u.page], u)?.instrument.id === target.id,
    )
  )
    return null;
  const instruments = cloneInstruments(named);
  const own = instruments.find((i) => i.id === target.id)!;
  const keep = own.staves.find((s) => !s.parts.length) ?? {
    id: nextStaffId(own),
    parts: [],
  };
  const staves = new Map(
    own.staves.filter((s) => s.id !== keep.id).map((s) => [s.id, keep.id]),
  );
  own.parts = [];
  own.staves = [keep];
  return { named: { ...named, instruments }, staves };
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
 * Why the naming of the units `only` admits (all units when absent) is not
 * complete, or null when every unit there is named and no system shows an
 * instrument's staff, or one of its parts, twice.
 */
export function namingProblem(
  named: LayoutInstruments,
  pages: NamingPage[],
  only?: (unit: NamingUnit) => boolean,
): string | null {
  const units = namingUnits(pages).filter((u) => !only || only(u));
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
      const parts = new Set(instrument.parts.length === 0 ? [0] : staff.parts);
      const before = seen.get(instrument.id) ?? new Set<number>();
      if ([...parts].some((x) => before.has(x)))
        return `Page ${page + 1}, system ${system + 1}: ${instrument.name} is named on two staves${instrument.parts.length ? " with the same part" : ""}.`;
      seen.set(instrument.id, new Set([...before, ...parts]));
    }
  }
  return null;
}

/** An instrument that looks like another one named a second time. */
export interface DoubleNaming {
  /** The instrument named a second time (id). */
  instrument: string;
  /** The instrument it looks like (id). */
  like: string;
  /** How they match: the same name, the name with more after it, or a part of `like`. */
  how: "same" | "longer" | "part";
}

const plainName = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[.,;:()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Instruments that look like another instrument named a second time, as
 * happens when the players of one instrument written on several staves are
 * each named as an instrument of their own: the same name; the other's name
 * followed by more ("Flöte I", "Oboe I, II" beside "Flöte", "Oboe"); or,
 * for an instrument with parts, the name or short name of one of its parts
 * or a whole word of its name ("Kontrabass" with short name "Kb" beside
 * "Violoncello und Kontrabass" with the parts Vc and Kb). Each instrument
 * once, with the first instrument it looks like: `instrument` is the one with
 * the longer name or the part's name, or for the same name the one named
 * later.
 */
export function doubleNamings(named: LayoutInstruments): DoubleNaming[] {
  const match = (
    a: LayoutInstrument,
    b: LayoutInstrument,
  ): DoubleNaming["how"] | null => {
    const an = plainName(a.name);
    const bn = plainName(b.name);
    if (!an || !bn) return null;
    if (an === bn) return "same";
    if (bn.startsWith(`${an} `)) return "longer";
    if (!a.parts.length) return null;
    const bAbbr = plainName(b.abbr);
    if (
      a.parts.some((part) => {
        const pn = plainName(part.name);
        return pn === bn || (bAbbr !== "" && pn === bAbbr);
      }) ||
      ` ${an} `.includes(` ${bn} `)
    )
      return "part";
    return null;
  };
  const found: DoubleNaming[] = [];
  named.instruments.forEach((b, j) => {
    for (const a of named.instruments.slice(0, j)) {
      const how = match(a, b);
      const back =
        how || found.some((d) => d.instrument === a.id) ? null : match(b, a);
      if (how) {
        found.push({ instrument: b.id, like: a.id, how });
        return;
      }
      if (back) {
        found.push({ instrument: a.id, like: b.id, how: back });
        return;
      }
    }
  });
  return found;
}

/** The part of `like` whose name or short name `other` carries; -1 for none. */
function partNamed(like: LayoutInstrument, other: LayoutInstrument): number {
  const name = plainName(other.name);
  const abbr = plainName(other.abbr);
  const exact = like.parts.findIndex((part) => {
    const pn = plainName(part.name);
    return pn === name || (abbr !== "" && pn === abbr);
  });
  if (exact >= 0) return exact;
  // A part's letters in order through the name, from its first: Vc in
  // Violoncello, Kb in Kontrabass.
  const letters = name.replace(/\s/g, "");
  return like.parts.findIndex((part) => {
    const pl = plainName(part.name).replace(/\s/g, "");
    if (!pl || pl[0] !== letters[0]) return false;
    let at = 0;
    for (const c of letters) if (c === pl[at]) at++;
    return at === pl.length;
  });
}

/**
 * Merge an instrument named a second time into the one it looks like
 * (doubleNamings): each of its staves becomes a staff of `like` with the
 * parts the match gives (added to `like`'s parts as needed): for a longer
 * name the rest of it ("Flöte I" → part I, "Oboe I, II" → parts I and II),
 * for a part that part, for the same name the staff's own parts or, without
 * any, all of `like`'s; its own parts where it has them and the longer name
 * gives none. Groups that start or end at it move to `like`. Returns the
 * instruments without it and, per staff id of the merged instrument, the
 * staff id that replaces it; null when no part can be found, or one is a
 * grand staff and the other is not.
 */
export function mergeInstrument(
  named: LayoutInstruments,
  double: DoubleNaming,
): { named: LayoutInstruments; staves: Map<string, string> } | null {
  const instruments = cloneInstruments(named);
  const like = instruments.find((i) => i.id === double.like);
  const other = instruments.find((i) => i.id === double.instrument);
  if (!like || !other || like.grand !== other.grand) return null;
  const staves = new Map<string, string>();
  {
    let common: string | null = null;
    if (double.how === "longer") {
      const words = plainName(like.name).split(" ").length;
      common = other.name.trim().split(/\s+/).slice(words).join(" ");
    } else if (double.how === "part") {
      const at = partNamed(like, other);
      if (at < 0) return null;
      common = like.parts[at].name;
      // A part that is an instrument keeps the merged instrument's short
      // name where it has none.
      if (like.partsAreInstruments && !like.parts[at].abbr && other.abbr)
        like.parts[at].abbr = other.abbr;
    }
    // The staves of one combination of parts (a grand staff's several)
    // move together.
    const combinations = new Map<string, InstrumentStaff[]>();
    for (const staff of other.staves) {
      const key = staff.parts.join(",");
      combinations.set(key, [...(combinations.get(key) ?? []), staff]);
    }
    for (const group of combinations.values()) {
      const own = partsLabel(other, group[0]);
      const text = own || common || "";
      const parts = parseParts(text).map((partName) => {
        const at = like.parts.findIndex(
          (p) => plainName(p.name) === plainName(partName),
        );
        if (at >= 0) return at;
        like.parts.push({ name: partName });
        return like.parts.length - 1;
      });
      const ids = staffIds(like, like.grand ? group.length : 1, parts);
      group.forEach((staff, k) =>
        staves.set(staff.id, ids[like.grand ? k : 0]),
      );
    }
  }
  return {
    named: {
      ...named,
      instruments: instruments.filter((i) => i.id !== other.id),
      groups: named.groups.map((g) => ({
        ...g,
        first: g.first === other.id ? like.id : g.first,
        last: g.last === other.id ? like.id : g.last,
      })),
    },
    staves,
  };
}

/**
 * The score definition the named instruments make on `pages`, on `base`:
 * the score staves of their staff plan (staffPlan) in order, each with its
 * staffDef xml:id, named and shown as the piece's first system prints them
 * (a staff it does not print is not visible and named as where it is first
 * printed). A staff's names are its instrument's, followed by the part where
 * it carries one (plannedLabels). A staff of an instrument with parts
 * declares a layer for each part it carries in some system, numbered by the
 * part (part 1 is layer 1 on every staff); the layer names are printed where
 * the staff carries the same two or more parts in every system, else given
 * as @label only. Each staff of an instrument that is not a grand staff is
 * one instrument (<instrDef>), and such an instrument with more than one
 * staff is a bracket group without names. A grand-staff instrument is a
 * brace group of one instrument with its names; with parts, a group of one
 * instrument without a symbol (symbol="none") around one brace per two
 * staves, named with the parts they first carry (Harfe: 1, 2). A staff `base`
 * already defines (same id) keeps its clef, lines and transposition; a new
 * one gets a treble clef, or a bass clef as the lower staff of a grand staff.
 * The key and meter are `base`'s. The groups of instruments span their
 * instruments' staves.
 *
 * With `opening` (openingTranscriptions), the clefs, key and meter are
 * proposed from the transcription (proposeScoreDef): a staff with an opening
 * transcription takes its clef, and its own key signature where it reads
 * another key than the score's; the score takes the key and the meter where
 * a transcription reads them. Anything not read stays as above.
 */
export function instrumentScoreDef(
  named: LayoutInstruments,
  base: ScoreDefModel,
  pages: NamingPage[],
  opening?: OpeningTranscriptions,
): ScoreDefModel {
  const known = new Map(
    base.staves.flatMap((staff) => (staff.id ? [[staff.id, staff]] : [])),
  );
  const plan = staffPlan(named, pages);
  const first = staffStates(plan)[0];
  const staves: StaffModel[] = plan.staves.map((planned, i) => {
    const { instrument } = planned;
    const kept = known.get(planned.id);
    const lower = instrument.grand && planned.position % 2 === 0;
    const parts = first?.[i].parts ?? planned.parts;
    const visible = first?.[i].visible ?? true;
    return {
      ...(kept ?? {
        clefShape: lower ? "F" : "G",
        clefLine: lower ? 4 : 2,
        clefDis: "",
        clefDisPlace: "",
        lines: 5,
        notationType: "",
      }),
      id: planned.id,
      ...plannedLabels(planned, parts),
      layers: instrument.parts.length
        ? planned.parts.map((p) => ({
            n: p + 1,
            label: instrument.parts[p].name,
            printed:
              !instrument.partsAreInstruments &&
              planned.sameParts &&
              planned.parts.length > 1,
            // On a staff of several parts that are instruments, each layer
            // names its own; a staff of one part has the staff's.
            ...(instrument.partsAreInstruments && planned.parts.length > 1
              ? { instrument: true }
              : {}),
          }))
        : [],
      ...(visible ? {} : { visible: false }),
      ...(instrument.grand ? {} : { instrument: true }),
    };
  });
  const groups: StaffGroupModel[] = [];
  const span = new Map<string, { start: number; end: number }>();
  for (const instrument of named.instruments) {
    const own = plan.staves.flatMap((p, i) =>
      p.instrument === instrument ? [i + 1] : [],
    );
    if (!own.length) continue;
    const start = own[0];
    const end = own[own.length - 1];
    span.set(instrument.id, { start, end });
    if (!instrument.grand) {
      if (end > start)
        groups.push({
          id: instrument.id,
          start,
          end,
          symbol: "bracket",
          label: "",
          labelAbbr: "",
          barThru: true,
          oneInstrument: false,
        });
      continue;
    }
    const withParts = instrument.parts.length > 0;
    groups.push({
      id: instrument.id,
      start,
      end,
      symbol: withParts ? "none" : "brace",
      label: instrument.name,
      labelAbbr: instrument.abbr,
      barThru: true,
      oneInstrument: true,
    });
    if (withParts)
      for (let n = start; n <= end; n += 2) {
        const parts = plan.staves[n - 1].parts;
        const label = parts.map((p) => instrument.parts[p].name).join(".");
        groups.push({
          id: `${plan.staves[n - 1].id}g`,
          start: n,
          end: Math.min(n + 1, end),
          symbol: "brace",
          label,
          labelAbbr: label,
          barThru: true,
          oneInstrument: false,
        });
      }
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
  if (!opening) return { ...base, staves, groups };

  const xmls = staves.map((staff) => opening.byStaff.get(staff.id!) ?? null);
  const proposal = proposeScoreDef(xmls, opening.firstSystem);
  xmls.forEach((xml, i) => {
    if (!xml) return;
    const p = proposal.staves[i];
    const { keysig: _, ...rest } = staves[i];
    staves[i] = {
      ...rest,
      clefShape: p.clefShape,
      clefLine: p.clefLine,
      clefDis: p.clefDis,
      clefDisPlace: p.clefDisPlace,
      ...(p.keysig ? { keysig: p.keysig } : {}),
    };
  });
  const read = [...opening.firstSystem, ...xmls].flatMap((xml) =>
    xml ? [readAttributes(xml)] : [],
  );
  return {
    ...base,
    ...(read.some((a) => a.fifths !== null) ? { keysig: proposal.keysig } : {}),
    ...(read.some((a) => a.time)
      ? {
          meterCount: proposal.meterCount,
          meterUnit: proposal.meterUnit,
          meterSym: proposal.meterSym,
        }
      : {}),
    staves,
    groups,
  };
}

/** The transcriptions a score definition is proposed from (instrumentScoreDef). */
export interface OpeningTranscriptions {
  /** Per score staff (staffDef xml:id), the transcription it opens with. */
  byStaff: Map<string, string>;
  /** The transcriptions of the piece's first system with staves, top to bottom; null for a staff without one. */
  firstSystem: (string | null)[];
}

/**
 * The opening transcriptions of the named pages in `record`: for each score
 * staff of the staff plan (staffPlan) the transcription of the first box
 * placed on it that reads a clef, in page, system and staff order, where the
 * staff's opening clef is printed; and the piece's first system, where the
 * key and time signatures are printed. A box the record describes with other
 * corners has none.
 */
export function openingTranscriptions(
  named: LayoutInstruments,
  pages: NamingPage[],
  record: OmrRecord,
): OpeningTranscriptions {
  const plan = staffPlan(named, pages);
  const placed = plannedBoxes(plan, pages.length);
  const byStaff = new Map<string, string>();
  let firstSystem: (string | null)[] | null = null;
  for (const [p, pg] of pages.entries()) {
    const staves = pg.staves ?? [];
    const entries = record.pages.find((r) => r.n === p + 1)?.staves ?? [];
    const xmlOf = (box: StaffBox) => {
      const zone = `staff-zone-${p + 1}-${staves.indexOf(box) + 1}`;
      const entry = entries.find((e) => e.zone === zone);
      return entry && sameBox(entry.box, box) ? entry.musicxml : null;
    };
    for (const system of pageSystems({ zones: pg.zones, staves }).systems) {
      if (!system.length) continue;
      const xmls = system.map(xmlOf);
      firstSystem ??= xmls;
      system.forEach((box, i) => {
        const n = placed[p].get(staves.indexOf(box));
        const id = n ? plan.staves[n - 1].id : null;
        const xml = xmls[i];
        if (id && xml && !byStaff.has(id) && readAttributes(xml).clef)
          byStaff.set(id, xml);
      });
    }
  }
  return { byStaff, firstSystem: firstSystem ?? [] };
}

/**
 * How each planned system (staffPlan) writes the score staves it does not
 * print. Every part of an instrument (an instrument without parts counts as
 * one) that a system does not print rests on the staves that carry it in
 * force: those that last printed it, before its first printing those that
 * first print it. Such a staff rests in the part's layer (part 1 is layer
 * 1). Every other staff the system does not print holds an mSpace: its parts
 * are on other staves there.
 */
export function unprintedStaves(
  plan: StaffPlan,
): Map<number, UnprintedStaff>[] {
  // Per system, staff n → the parts it prints there ([0] without parts).
  const printed = plan.systems.map(
    (system) =>
      new Map(
        [...system.boxes.values()].map((at) => [
          at.n,
          at.parts.length ? at.parts : [0],
        ]),
      ),
  );
  const instruments = [...new Set(plan.staves.map((s) => s.instrument))].map(
    (instrument) => {
      const staves = plan.staves.flatMap((s, i) =>
        s.instrument === instrument ? [i + 1] : [],
      );
      const carrying = (p: number, system: Map<number, number[]>) =>
        staves.filter((n) => system.get(n)?.includes(p));
      const parts = Math.max(1, instrument.parts.length);
      const inForce = Array.from({ length: parts }, (_, p) => {
        const first = printed.find((system) => carrying(p, system).length);
        return first ? carrying(p, first) : staves.slice(0, 1);
      });
      return { staves, parts, carrying, inForce };
    },
  );
  return printed.map((system) => {
    const out = new Map<number, UnprintedStaff>();
    for (const { staves, parts, carrying, inForce } of instruments) {
      for (const n of staves) if (!system.has(n)) out.set(n, "space");
      for (let p = 0; p < parts; p++) {
        const shown = carrying(p, system);
        if (shown.length) {
          inForce[p] = shown;
          continue;
        }
        for (const n of inForce[p]) {
          if (system.has(n)) continue;
          const held = out.get(n);
          const layers = held === "space" || !held ? [] : held;
          out.set(
            n,
            [...new Set([...layers, p + 1])].sort((a, b) => a - b),
          );
        }
      }
    }
    return out;
  });
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

/** The units `only` admits (all units when absent), by system, and each unit's printed label. */
function systemsOf(
  pages: NamingPage[],
  labels: string[][][],
  only?: (unit: NamingUnit) => boolean,
): { units: NamingUnit[]; label: (u: NamingUnit) => string }[] {
  const systems = new Map<string, NamingUnit[]>();
  for (const unit of namingUnits(pages)) {
    if (only && !only(unit)) continue;
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
 * The first system's instruments from what is printed in front of its staves:
 * for each unit nobody named, the name before trailing part names becomes
 * the instrument (printedName) and those part names its parts on this staff,
 * so "Flauto I" and "Flauto II" make one instrument with two parts, and
 * "Harfe 1" and "Harfe 2" on grand staves one grand-staff instrument. A unit without a label stays
 * unnamed. `labels` holds the printed labels by page and system, in unit
 * order (unitBoxes), '' for none.
 */
export function suggestFirstSystem(
  pages: NamingPage[],
  named: LayoutInstruments,
  labels: string[][][],
): { unit: NamingUnit; name: string; parts: string }[] {
  const first = firstNamingSystem(pages);
  const out: { unit: NamingUnit; name: string; parts: string }[] = [];
  for (const { units, label } of systemsOf(pages, labels, (u) =>
    inSystem(first, u),
  )) {
    for (const unit of units) {
      if (unitName(named, pages[unit.page], unit)) continue;
      const printed = printedName(label(unit));
      if (!printed) continue;
      const split = splitLabel(printed);
      const name = printedName(split.name);
      if (name) out.push({ unit, name, parts: split.parts });
    }
  }
  return out;
}

/**
 * For the units nobody named in the systems `fill` admits (it is asked with
 * a system's first unit; by default the systems after the first), the
 * instrument staff each shows from the instruments named so far, system by
 * system, each read with the system before it. A combination of parts of
 * an instrument is a slot: the staves of a grand-staff instrument that carry
 * it, or one score staff of another instrument, labelled with the
 * instrument's name and parts. A unit whose printed label reads as one slot's full or short name
 * takes it (of equal readings the slot carrying more parts); in a system
 * with no more units than the piece has slots the others are placed by
 * suggestStaffAssignment (labels, the slots of the system before, staff
 * spacing), and a unit it gives a slot of another size takes the next free
 * slot of its size in score order. A unit only takes a slot of its size and
 * no slot twice in a system. A unit still without one stays unnamed. A
 * one-staff unit whose printed label gives no part, and the only unit of its
 * instrument in the system, shows all the instrument's parts.
 */
export function suggestFromList(
  pages: NamingPage[],
  named: LayoutInstruments,
  labels: string[][][],
  fill?: (unit: NamingUnit) => boolean,
): { unit: NamingUnit; instrument: string; parts: number[] }[] {
  type Slot = {
    instrument: LayoutInstrument;
    parts: number[];
    size: number;
    full: string;
    short: string;
  };
  // A slot per combination of parts: one staff, or a grand staff's staves.
  const slots: Slot[] = named.instruments.flatMap((instrument): Slot[] => {
    const combinations = new Map<string, InstrumentStaff[]>();
    for (const staff of instrument.staves) {
      const key = staff.parts.join(",");
      combinations.set(key, [...(combinations.get(key) ?? []), staff]);
    }
    return [...combinations.values()].map((list) => {
      const parts = partsLabel(instrument, list[0]);
      return {
        instrument,
        parts: list[0].parts,
        size: instrument.grand ? list.length : 1,
        full: `${instrument.name} ${parts}`.trim(),
        short: instrument.abbr ? `${instrument.abbr} ${parts}`.trim() : "",
      };
    });
  });
  const fullNames = slots.map((s) => s.full);
  const shortNames = slots.map((s) => s.short || s.full);
  const slotOf = (shown: {
    instrument: LayoutInstrument;
    staff: InstrumentStaff;
  }) =>
    slots.findIndex(
      (s) =>
        s.instrument.id === shown.instrument.id &&
        sameParts(s.parts, shown.staff.parts),
    );
  const first = firstNamingSystem(pages);
  const out: { unit: NamingUnit; instrument: string; parts: number[] }[] = [];
  let previous: number[] = [];
  for (const { units, label } of systemsOf(pages, labels)) {
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
    if (fill ? fill(units[0]) : !inSystem(first, units[0])) {
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
      // A staff whose printed name gives no part, and the only staff of its
      // instrument in the system, carries all the instrument's parts.
      const partsOf = (unit: NamingUnit, k: number) => {
        const { instrument, parts } = slots[k];
        const shared = units.filter((u) => {
          const j = chosen.get(u);
          return j !== undefined && slots[j].instrument.id === instrument.id;
        });
        return shared.length === 1 &&
          !instrument.grand &&
          !labelNumerals(label(unit), fullNames).length
          ? instrument.parts.map((_, i) => i)
          : parts;
      };
      for (const unit of units) {
        const k = chosen.get(unit);
        if (k === undefined || unitName(named, page, unit)) continue;
        out.push({
          unit,
          instrument: slots[k].instrument.id,
          parts: partsOf(unit, k),
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
