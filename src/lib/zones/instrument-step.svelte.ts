// The instruments step of a layout task whose piece names its instruments:
// the pages as the step reads them, the instruments some staff box shows,
// the first system where the instruments are defined, the step's edits as
// undoable steps, and the names read from the printed labels when a part of
// the step first opens for the claim holder.

import { forge } from "../auth.svelte.ts";
import type { FacsimileTaskData } from "../commands.ts";
import type { CommandRunner } from "../command-runner.svelte.ts";
import type { LayoutGroup } from "../omr-layout.ts";
import {
  assignUnit,
  mergeInstrument,
  firstNamingSystem,
  dropParts,
  inSystem,
  nameUnit,
  namingProblem,
  namingUnits,
  pruneInstruments,
  suggestFirstSystem,
  suggestFromList,
  unitBoxes,
  unitName,
  type DoubleNaming,
  type NamingUnit,
} from "../instrument-naming.ts";
import { readStaffLabels } from "../ocr.ts";
import { resolveRepoRelativeTarget } from "../facsimile-images.ts";
import { toPageModels } from "./edit-pages.ts";
import type { ZonePages } from "./zone-pages.svelte.ts";

export interface InstrumentStepHost {
  model: ZonePages;
  runner: CommandRunner;
  omr(): boolean;
  /** The layout task names the instruments. */
  naming(): boolean;
  layoutStep(): number;
  canEdit(): boolean;
  taskId(): string;
  data(): FacsimileTaskData | null;
  owner(): string;
  repo(): string;
  /** Record the change as one undoable step. */
  commit(): void;
}

export class InstrumentStep {
  // The printed labels OCR read in this session, by page (unitBoxes order).
  printedLabels = $state<string[][][]>([]);
  #prefilledFor = $state<string | null>(null);
  #host: InstrumentStepHost;

  constructor(host: InstrumentStepHost) {
    this.#host = host;
    // When a part of the instruments step first opens for the claim holder, its
    // staves nobody has named yet are named from what is printed in front of
    // them (OCR, in the browser): in the first system as new instruments with
    // their parts (suggestFirstSystem), in the other systems from the
    // instruments so far and the systems before them (followSystems). One
    // undoable step.
    $effect(() => {
      const key = `${this.#host.taskId()}:${this.#host.model.named.fixed}`;
      if (
        this.#host.naming() &&
        this.#host.layoutStep() === 4 &&
        this.#host.canEdit() &&
        !this.#host.runner.busy &&
        this.#prefilledFor !== key
      ) {
        this.#prefilledFor = key;
        this.prefillNames();
      }
    });
  }

  #toPageModels = () => toPageModels(this.#host.model.pages, this.#host.omr());

  // The pages as the instruments step reads them; empty outside it.
  namingModels = $derived.by(() =>
    this.#host.naming() ? this.#toPageModels() : [],
  );
  // The instruments with only those some staff box shows. `named` keeps
  // every instrument named in the session, so an undo can return to one.
  shownNamed = $derived.by(() =>
    this.#host.naming()
      ? pruneInstruments(this.#host.model.named, this.namingModels)
      : this.#host.model.named,
  );

  // The first system with staves, where the instruments are defined.
  firstSystem = $derived.by(() =>
    this.#host.naming() ? firstNamingSystem(this.namingModels) : null,
  );
  // Why the first system's instruments cannot be confirmed yet.
  firstBlock = $derived.by(() =>
    this.#host.naming()
      ? namingProblem(this.shownNamed, this.namingModels, (u) =>
          inSystem(this.firstSystem, u),
        )
      : null,
  );

  // Give a unit's boxes the score staves a naming returned.
  #setStaves(unit: NamingUnit, staves: (string | undefined)[]) {
    unit.staves.forEach((k, j) => {
      const staff = this.#host.model.pages[unit.page].staves[k];
      if (staves[j]) staff.staff = staves[j];
      else delete staff.staff;
    });
  }

  // Name a unit by instrument name and parts; an instrument added after the
  // first system's instruments were confirmed carries its page. A unit of
  // the first system named without parts takes the parts away from an
  // instrument no other unit there shows (dropParts).
  #applyName(unit: NamingUnit, name: string, parts: string, added?: number) {
    const m = this.#host.model;
    if (!parts.trim() && inSystem(this.firstSystem, unit)) {
      const d = dropParts(m.named, this.namingModels, unit, name, (u) =>
        inSystem(this.firstSystem, u),
      );
      if (d) {
        for (const pg of m.pages)
          for (const box of pg.staves) {
            const to = box.staff ? d.staves.get(box.staff) : undefined;
            if (to) box.staff = to;
          }
        m.named = d.named;
      }
    }
    const r = nameUnit(m.named, unit.staves.length, name, parts, added);
    this.#setStaves(unit, r.staves);
    m.named = r.named;
  }

  // Show an instrument of the list on a unit.
  #applyAssign(unit: NamingUnit, instrument: string, parts: number[]) {
    const m = this.#host.model;
    const r = assignUnit(m.named, unit.staves.length, instrument, parts);
    this.#setStaves(unit, r.staves);
    m.named = r.named;
  }

  // Name the staves nobody named in the systems after the first from the
  // instruments named so far and the systems before them (suggestFromList),
  // once the first system's instruments are confirmed; with `below`, only in
  // the systems after that unit's. Returns how many units were named.
  #followSystems(below?: NamingUnit): number {
    if (!this.#host.model.named.fixed) return 0;
    const models = this.#toPageModels();
    const after = (u: NamingUnit) =>
      !below ||
      u.page > below.page ||
      (u.page === below.page && u.system > below.system);
    const suggestions = suggestFromList(
      models,
      this.#host.model.named,
      this.printedLabels,
    ).filter((s) => after(s.unit));
    for (const s of suggestions)
      this.#applyAssign(s.unit, s.instrument, s.parts);
    return suggestions.length;
  }

  // The instruments step's edits, each recorded as one step with the staves
  // it lets the systems below follow.
  readonly naming4 = {
    define: (unit: NamingUnit, name: string, parts: string, added?: number) => {
      this.#applyName(unit, name, parts, added);
      this.#followSystems(unit);
      this.#host.commit();
    },
    assign: (unit: NamingUnit, instrument: string, parts: number[]) => {
      this.#applyAssign(unit, instrument, parts);
      this.#followSystems(unit);
      this.#host.commit();
    },
    abbr: (id: string, abbr: string) => {
      const m = this.#host.model;
      m.named = {
        ...m.named,
        instruments: m.named.instruments.map((i) =>
          i.id === id ? { ...i, abbr: abbr.trim() } : i,
        ),
      };
      this.#host.commit();
    },
    groups: (groups: LayoutGroup[]) => {
      const m = this.#host.model;
      m.named = { ...m.named, groups };
      this.#host.commit();
    },
    fix: (fixed: boolean) => {
      const m = this.#host.model;
      m.named = { ...m.named, fixed };
      this.#host.commit();
    },
    // An instrument named a second time becomes a part of the one it looks
    // like: every box showing one of its staves shows the staff that
    // replaces it. One undoable step.
    merge: (double: DoubleNaming) => {
      const m = this.#host.model;
      const r = mergeInstrument(m.named, double);
      if (!r) return;
      for (const pg of m.pages)
        for (const box of pg.staves) {
          const to = box.staff ? r.staves.get(box.staff) : undefined;
          if (to) box.staff = to;
        }
      m.named = r.named;
      this.#host.commit();
    },
  };

  async prefillNames() {
    const f = forge();
    const data = this.#host.data();
    if (!f || !data) return;
    const m = this.#host.model;
    const runner = this.#host.runner;
    const fragment = data.fragment;
    const models = this.#toPageModels();
    const first = firstNamingSystem(models);
    const open = [
      ...new Set(
        namingUnits(models)
          .filter((u) => m.named.fixed !== inSystem(first, u))
          .filter((u) => !unitName(m.named, models[u.page], u))
          .map((u) => u.page),
      ),
    ];
    if (!open.length) return;
    await runner.run(async () => {
      try {
        const labels: string[][][] = models.map(() => []);
        // Pages whose image could not be read, 1-based.
        const unread: number[] = [];
        for (const p of open) {
          runner.log.step(
            `Reading the instrument names on page ${p + 1} of ${m.pages.length}`,
          );
          const path = resolveRepoRelativeTarget(fragment, m.pages[p].image);
          const image = path
            ? await f.getRepoFileBytes(
                this.#host.owner(),
                this.#host.repo(),
                path,
              )
            : null;
          if (!image) {
            runner.log.detail("The page image could not be read.");
            unread.push(p + 1);
            continue;
          }
          labels[p] = await readStaffLabels(image, unitBoxes(models)[p]);
        }
        this.printedLabels = models.map((_, p) =>
          labels[p].length ? labels[p] : (this.printedLabels[p] ?? []),
        );
        if (unread.length === open.length)
          return {
            error:
              "Reading the instrument names failed: the page images could not be read.",
          };
        let count = 0;
        if (!m.named.fixed) {
          for (const s of suggestFirstSystem(
            models,
            m.named,
            this.printedLabels,
          )) {
            this.#applyName(s.unit, s.name, s.parts);
            count++;
          }
        }
        count += this.#followSystems();
        if (count) this.#host.commit();
        const summary = `${count} of the unnamed staves and grand staves were named from the printed names and the systems before them. Check every name.`;
        return unread.length
          ? {
              ok: true,
              outcome: "partial" as const,
              message:
                unread.length === 1
                  ? `${summary} The image of page ${unread[0]} could not be read.`
                  : `${summary} The images of pages ${unread.join(", ")} could not be read.`,
            }
          : { ok: true, message: summary };
      } catch (e) {
        return {
          error: `Reading the instrument names failed: ${(e as Error).message}`,
        };
      }
    });
  }
}
