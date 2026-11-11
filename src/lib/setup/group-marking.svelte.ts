// The score setup's staff groups, step 2.
//
// A group is made in step 2 by marking its staves in the preview (the
// first staff, then the last: a click or tap on each, or a mouse drag from
// one to the other) and choosing its symbol. Its values are edited in its
// row in the panel, opened from its line or from a marked staff.

import type { StaffGroupModel } from "../mei-facsimile.ts";
import { spanProblem } from "../staff-groups.ts";
import { newGroup } from "./score-def.ts";
import type { SetupModel } from "./setup-model.svelte.ts";
import type { SetupPreview } from "./setup-preview.svelte.ts";
import { symbolName } from "./setup-text.ts";

export interface GroupMarkingHost {
  /** Whether groups are marked in the preview: in step 2, by the volunteer
      holding the task. */
  markable: () => boolean;
  step: () => 1 | 2;
  /** Whether a click on a staff names it in a reviewer's change request. */
  picking: () => boolean;
  pickStaff: (i: number) => void;
}

export class GroupMarking {
  #model: SetupModel;
  #preview: SetupPreview;
  #host: GroupMarkingHost;
  // The marked staves, 0-based: the first, then the last (null until marked).
  markFrom = $state<number | null>(null);
  markTo = $state<number | null>(null);
  openGroup = $state<StaffGroupModel | null>(null);
  hoveredGroup = $state<StaffGroupModel | null>(null);
  announce = $state("");
  #dragFrom: number | null = null;
  #dragMoved = false;

  openG = $derived.by(() =>
    this.openGroup && this.#model.groups.includes(this.openGroup)
      ? this.openGroup
      : null,
  );
  marked = $derived(
    this.markFrom === null
      ? null
      : {
          start: Math.min(this.markFrom, this.markTo ?? this.markFrom) + 1,
          end: Math.max(this.markFrom, this.markTo ?? this.markFrom) + 1,
        },
  );
  markSpan = $derived(this.markTo === null ? null : this.marked);
  sameGroup = $derived.by(() =>
    this.markSpan
      ? this.#model.groups.find(
          (g) =>
            g.start === this.markSpan!.start && g.end === this.markSpan!.end,
        )
      : undefined,
  );
  markProblem = $derived.by(() =>
    this.markSpan && !this.sameGroup
      ? spanProblem(this.#model.groups, this.markSpan.start, this.markSpan.end)
      : null,
  );
  liveText = $derived(this.markProblem ?? this.announce);

  // "Add group", the path without the preview: the first two neighbouring
  // staves a new group can join.
  freePair = $derived.by(() => {
    for (let n = 1; n < this.#model.staves.length; n++) {
      const taken = this.#model.groups.some(
        (g) => g.start === n && g.end === n + 1,
      );
      if (!taken && !spanProblem(this.#model.groups, n, n + 1)) return n;
    }
    return null;
  });

  // The staves coloured in the preview: the marked staves, else the hovered
  // group's or the open group's, else the staff a row points at.
  lit = $derived.by(() => {
    if (this.#host.markable() && this.marked) return this.marked;
    const g =
      this.hoveredGroup ?? (this.#host.step() === 2 ? this.openG : null);
    if (g) return { start: g.start, end: g.end };
    return this.#preview.pointedStaff === null
      ? null
      : {
          start: this.#preview.pointedStaff + 1,
          end: this.#preview.pointedStaff + 1,
        };
  });

  constructor(
    model: SetupModel,
    preview: SetupPreview,
    host: GroupMarkingHost,
  ) {
    this.#model = model;
    this.#preview = preview;
    this.#host = host;
  }

  /** The groups holding staff `n` (1-based), outer first. */
  containing = (n: number) =>
    this.#model.ordered.filter((g) => g.start <= n && n <= g.end);

  clearMark() {
    this.markFrom = null;
    this.markTo = null;
  }

  addMarked(symbol: string) {
    if (!this.markSpan || this.markProblem || this.sameGroup) return;
    const { start, end } = this.markSpan;
    this.#model.groups = [
      ...this.#model.groups,
      newGroup(start, end, symbol, this.#model.staves),
    ];
    this.openGroup = this.#model.groups[this.#model.groups.length - 1];
    this.announce = `${symbolName(symbol)} added over staves ${start}–${end}.`;
    this.clearMark();
  }

  toggleRow(g: StaffGroupModel) {
    this.openGroup = this.openG === g ? null : g;
    this.clearMark();
  }

  addGroup() {
    if (this.freePair === null) return;
    this.#model.groups = [
      ...this.#model.groups,
      newGroup(this.freePair, this.freePair + 1, "brace", this.#model.staves),
    ];
    this.openGroup = this.#model.groups[this.#model.groups.length - 1];
    this.clearMark();
  }

  removeGroup(g: StaffGroupModel) {
    this.#model.groups = this.#model.groups.filter((h) => h !== g);
    this.announce = `${symbolName(g.symbol)} over staves ${g.start}–${g.end} removed.`;
  }

  // A click or tap marks the first staff, then the last; a mouse drag marks
  // both at once. On touch a drag scrolls the preview.
  sheetDown(e: PointerEvent) {
    if (!this.#host.markable() || e.pointerType !== "mouse" || e.button !== 0)
      return;
    this.#dragFrom = this.#preview.staffAt(e.clientY);
    this.#dragMoved = false;
  }

  sheetMove(e: PointerEvent) {
    if (this.#dragFrom === null || !(e.buttons & 1)) return;
    const i = this.#preview.staffAt(e.clientY);
    if (i === null || (i === this.#dragFrom && !this.#dragMoved)) return;
    this.#dragMoved = true;
    this.markFrom = this.#dragFrom;
    this.markTo = i;
    this.openGroup = null;
  }

  sheetClick(e: MouseEvent) {
    this.#dragFrom = null;
    if (this.#host.picking()) {
      const i = this.#preview.staffAt(e.clientY);
      if (i !== null) this.#host.pickStaff(i);
      return;
    }
    if (!this.#host.markable()) return;
    if (this.#dragMoved) {
      this.#dragMoved = false;
      return;
    }
    const i = this.#preview.staffAt(e.clientY);
    if (i === null) return;
    this.openGroup = null;
    if (this.markFrom === null || this.markTo !== null) {
      this.markFrom = i;
      this.markTo = null;
    } else if (i === this.markFrom) this.clearMark();
    else this.markTo = i;
  }
}
