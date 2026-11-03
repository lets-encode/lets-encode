// Reordering a list by its rows' handles: dragged, an item takes the place of
// each row the pointer crosses, and the list scrolls near its scroller's
// edges. A click picks an item and a click on another item's handle moves it
// there; the arrow keys move an item by one.

import { tick } from "svelte";

export interface HandleReorderOptions {
  /** The rows the pointer is tested against, in list order. */
  rows: () => HTMLElement[];
  /** The element scrolled while a drag nears its top or bottom edge. */
  scroller: () => HTMLElement | null;
  /** The handle of item `i`, focused again after a key move. */
  handle: (i: number) => HTMLElement | undefined;
  count: () => number;
  /** A key naming item `i`: a picked item is found again by it. */
  keyOf: (i: number) => string;
  /** Move item `from` to `to`, by a click or a key. */
  move: (from: number, to: number) => void;
  /** A drag begins on item `i`. */
  dragStart?: (i: number) => void;
  /** A drag moves its item from `from` to `to`, `origin` being the row it
      began on; `move` when absent. */
  dragMove?: (origin: number, from: number, to: number) => void;
}

/** A press that moves this many pixels is a drag. */
const DRAG_SLOP = 4;
/** A drag this close to the scroller's edge scrolls it, by SCROLL_STEP. */
const EDGE = 40;
const SCROLL_STEP = 10;

export class HandleReorder {
  /** The index of the item being dragged; null while none is. */
  dragging = $state<number | null>(null);
  #picked = $state<string | null>(null);
  #gesture: { x: number; y: number; moved: boolean; origin: number } | null =
    null;
  #swallowClick = false;
  #o: HandleReorderOptions;

  constructor(options: HandleReorderOptions) {
    this.#o = options;
  }

  /** The picked item's index; -1 while none is picked. */
  picked = $derived.by(() => {
    const key = this.#picked;
    if (key === null) return -1;
    for (let i = 0; i < this.#o.count(); i++)
      if (this.#o.keyOf(i) === key) return i;
    return -1;
  });

  /** Let go of a picked item. */
  drop() {
    this.#picked = null;
  }

  down(i: number, e: PointerEvent) {
    if (e.button !== 0) return;
    this.#gesture = { x: e.clientX, y: e.clientY, moved: false, origin: i };
    this.dragging = i;
    this.#o.dragStart?.(i);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  pointerMove(e: PointerEvent) {
    const g = this.#gesture;
    if (!g || this.dragging === null) return;
    if (!g.moved) {
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < DRAG_SLOP) return;
      g.moved = true;
      this.#picked = null;
    }
    const over = this.#o.rows().findIndex((row) => {
      const box = row.getBoundingClientRect();
      return e.clientY >= box.top && e.clientY < box.bottom;
    });
    if (over >= 0 && over !== this.dragging) {
      (this.#o.dragMove ?? ((_, from, to) => this.#o.move(from, to)))(
        g.origin,
        this.dragging,
        over,
      );
      this.dragging = over;
    }
    const scroller = this.#o.scroller();
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    if (e.clientY < box.top + EDGE) scroller.scrollTop -= SCROLL_STEP;
    else if (e.clientY > box.bottom - EDGE) scroller.scrollTop += SCROLL_STEP;
  }

  up() {
    this.#swallowClick = !!this.#gesture?.moved;
    this.#gesture = null;
    this.dragging = null;
  }

  click(i: number) {
    if (this.#swallowClick) {
      this.#swallowClick = false;
      return;
    }
    const picked = this.picked;
    if (picked < 0) this.#picked = this.#o.keyOf(i);
    else {
      this.#o.move(picked, i);
      this.#picked = null;
    }
  }

  async key(i: number, e: KeyboardEvent) {
    const to =
      e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : null;
    if (e.key === "Escape") this.#picked = null;
    if (to === null || to < 0 || to >= this.#o.count()) return;
    e.preventDefault();
    this.#o.move(i, to);
    await tick();
    this.#o.handle(to)?.focus();
  }
}
