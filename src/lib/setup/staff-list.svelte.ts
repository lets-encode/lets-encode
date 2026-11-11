// The score setup's staff list: adding, removing and moving staves, the
// groups following each move. Reordering is by a staff's handle, its number
// (HandleReorder).

import { HandleReorder } from "../handle-reorder.svelte.ts";
import type { StaffGroupModel } from "../mei-facsimile.ts";
import { moveStaffInGroups, removeStaffFromGroups } from "../staff-groups.ts";
import type { GroupMarking } from "./group-marking.svelte.ts";
import { MAX_STAVES, plainStaff } from "./score-def.ts";
import type { SetupModel } from "./setup-model.svelte.ts";

export class StaffListEditor {
  /** The staff list's element, whose rows the handles reorder. */
  list = $state<HTMLOListElement | null>(null);
  readonly reorder: HandleReorder;
  #model: SetupModel;
  #marking: GroupMarking;
  // A drag's groups follow one move from the row it began on, as a click
  // move would: each row crossed starts again from the groups' ranges then.
  #dragGroups: { g: StaffGroupModel; start: number; end: number }[] = [];

  constructor(model: SetupModel, marking: GroupMarking) {
    this.#model = model;
    this.#marking = marking;
    this.reorder = new HandleReorder({
      rows: () => [...(this.list?.children ?? [])] as HTMLElement[],
      scroller: () => {
        let scroller = this.list?.parentElement ?? null;
        while (
          scroller &&
          !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
        )
          scroller = scroller.parentElement;
        return scroller;
      },
      handle: (i) => this.list?.querySelectorAll<HTMLElement>(".staffgrip")[i],
      count: () => this.#model.staves.length,
      keyOf: (i) => String(i),
      move: (from, to) => this.moveStaff(from, to),
      dragStart: () =>
        (this.#dragGroups = this.#model.groups.map((g) => ({
          g,
          start: g.start,
          end: g.end,
        }))),
      dragMove: (origin, from, to) => {
        for (const { g, start, end } of this.#dragGroups) {
          g.start = start;
          g.end = end;
        }
        this.#model.groups = moveStaffInGroups(
          this.#dragGroups.map(({ g }) => g),
          this.#model.staves.length,
          origin,
          to,
        );
        this.#marking.clearMark();
        this.#reorderStaves(from, to);
      },
    });
  }

  addStaff() {
    if (this.#model.staves.length >= MAX_STAVES) return;
    this.#model.staves = [...this.#model.staves, plainStaff()];
  }

  // Removing or moving a staff by other means drops a staff picked to move.
  removeStaff(i: number) {
    if (this.#model.staves.length <= 1) return;
    this.reorder.drop();
    this.#model.groups = removeStaffFromGroups(this.#model.groups, i);
    this.#marking.clearMark();
    this.#model.staves = this.#model.staves.filter((_, n) => n !== i);
  }

  moveStaff(from: number, to: number) {
    if (from === to || to < 0 || to >= this.#model.staves.length) return;
    this.reorder.drop();
    this.#model.groups = moveStaffInGroups(
      this.#model.groups,
      this.#model.staves.length,
      from,
      to,
    );
    this.#marking.clearMark();
    this.#reorderStaves(from, to);
  }

  #reorderStaves(from: number, to: number) {
    const next = [...this.#model.staves];
    const [staff] = next.splice(from, 1);
    next.splice(to, 0, staff);
    this.#model.staves = next;
  }

  handleTitle = (i: number) =>
    this.reorder.picked < 0
      ? "Drag to move this staff. Or click it, then click the staff whose place it takes. The arrow keys move it up and down."
      : this.reorder.picked === i
        ? "Click again to leave this staff where it is."
        : `Click to move staff ${this.reorder.picked + 1} here.`;
}
