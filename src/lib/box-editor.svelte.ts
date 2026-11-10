// The box editor shared by the zone editor (measures, staves, grand staves)
// and the wizard's piece regions: the selection, the pointer gestures that
// draw, move, copy, resize and select boxes on page images, the keys that
// act on a box, and the undo history. The host owns the boxes and the
// markup; it hands them in through `BoxEditorHost` and wires its elements'
// events to the methods here.
//
// A mouse edits directly: drag on the page to draw (or click two corners),
// drag a box to move it (Cmd/Ctrl to copy), drag a handle to resize (a
// handle pressed without dragging is picked up and goes to the next press),
// Shift+click and Shift+drag to select several. On a touch screen a finger
// or pen edits only in draw mode: outside it a drag scrolls, a tap on a box
// marks the Draw toggle (drawHint) and a double tap turns draw mode on; in
// it a tap selects a box, the selected box drags, a drag on the page draws
// and a double tap turns it off. A second finger turns the touch into a
// pinch, which undoes the edit under way; no finger edits again until all
// have lifted.
//
// Constructed during a component's initialisation; `listen` is meant for an
// `$effect`, which removes the window listeners with the component.

import {
  arrowShift,
  boundingBox,
  boxesTouch,
  copyPlace,
  drawnBox,
  drawStarted,
  movedBox,
  movedBoxes,
  nudgedEdges,
  pagePoint,
  resizedBox,
  type Box,
  type PageSize,
} from "./box-geometry.ts";
import {
  DOUBLE_TAP_MS,
  DOUBLE_TAP_PX,
  isDoubleTap,
  MOVE_SLOP_PX,
  primaryOf,
  recorded,
  TAP_SLOP_PX,
  toggled,
  travelled,
} from "./box-editor-rules.ts";

export interface BoxEditorHost<T, S> {
  /** Page p's boxes the editor works on, in their current order. */
  items(p: number): T[];
  /** An item's box; edits write into it. */
  box(item: T): Box;
  /** Page p's size in page pixels. */
  page(p: number): PageSize | undefined;
  /** The element page p is drawn in; the pointer maps through its rectangle. */
  surface(p: number): Element | undefined;
  /** Page p's width on screen, in CSS pixels. */
  screenWidth(p: number): number;
  /** Whether boxes may be changed; without it a press only selects. */
  canEdit(): boolean;
  /** Whether a press on page p outside the boxes may draw a box. */
  canDraw(p: number): boolean;
  /** Whether the boxes are shown and take presses. */
  shown(): boolean;
  /** Whether the screen is a touch screen, which has draw mode. */
  touch(): boolean;
  /** What a new box belongs to (a layer, a piece); a box drawn by two
      clicks is made only when both are in the same. */
  scope(): unknown;
  /** Add a box to page p and return its item; `like` is the item a copy
      is made of. */
  add(p: number, box: Box, like?: T): T;
  /** Remove an item from page p. */
  remove(p: number, item: T): void;
  /** In page pixels: the least width and height of a box. */
  minSize(p: number): number;
  /** In page pixels: a drawn box narrower or lower than this is dropped. */
  dropBelow(p: number): number;
  /** In page pixels: the step of an arrow key, and with Shift. */
  nudge: { near: number; far: number };
  /** `box` moved to neighbouring boxes' edges; `own` are the items being
      edited. With `keepSize` the box shifts whole, else its edges snap one
      by one. */
  snap?(p: number, box: Box, own: T[], keepSize: boolean): Box;
  /** Whether the edited items may keep their new boxes; on false the edit
      is undone. */
  accept?(p: number, edited: T[]): boolean;
  /** Page p's boxes changed and the change stays: re-sort them and record
      the undo step (commit). */
  changed(p: number): void;
  /** The scrolling element a drag near its edge scrolls. */
  scroller?(): HTMLElement | null | undefined;
  /** A copy of the state the undo history restores. */
  snapshot(): S;
  /** Put back a snapshot (copying it). */
  restore(s: S): void;
}

type Drag<T> = {
  id: number;
  kind: "move" | "resize" | "draw";
  p: number;
  /** The box moved, resized or drawn; a draw makes it once it starts. */
  item: T | null;
  sx: number;
  sy: number;
  origin: Box;
  /** For a resize: the edges that follow the pointer, "n", "s", "e", "w"
      or a corner's pair ("nw", "se", …). */
  edges: string;
  /** A draw makes its box only once the pointer has travelled a few
      millimetres on screen, so a plain click leaves nothing behind. */
  started: boolean;
  /** The pointer has travelled past MOVE_SLOP_PX; before it, the box stays. */
  moved: boolean;
  /** A press on the page that cleared a selection only deselects; it never
      sets a corner. */
  deselected: boolean;
  /** A mouse, or any pointer without a touch screen. */
  fine: boolean;
  slop: number;
  /** A Cmd/Ctrl move drags copies: the box pressed, whose copy `item` is. */
  copyOf: T | null;
  /** A move of several boxes: each box and where it started. */
  members: { item: T; origin: Box }[] | null;
  /** A Cmd/Ctrl move of several boxes: the boxes copied. */
  copied: T[] | null;
};

/** A Shift+drag's rectangle, in page pixels: every box it touches joins the
    boxes selected when it began (base). A Shift+click without a drag adds
    the box it was on (hit) or takes it out. */
export type Marquee<T> = {
  id: number;
  p: number;
  sx: number;
  sy: number;
  x: number;
  y: number;
  moved: boolean;
  base: T[];
  hit: T | null;
};

export class BoxEditor<T, S> {
  #host: BoxEditorHost<T, S>;

  #sel = $state.raw<{ p: number; item: T } | null>(null);
  #group = $state.raw<T[]>([]);
  /** Select several (touch): a tap on a box adds it to the selection or
      takes it out. On only in draw mode; ends with an empty selection. */
  pickMode = $state(false);
  /** Draw mode (touch): a finger or pen edits. */
  drawMode = $state(false);
  /** A tap on a box outside draw mode marks the Draw toggle for a moment. */
  drawHint = $state(false);
  marquee = $state.raw<Marquee<T> | null>(null);
  /** The first corner of a box drawn by two clicks, in page pixels. */
  corner = $state.raw<{
    p: number;
    scope: unknown;
    x: number;
    y: number;
  } | null>(null);
  /** A handle pressed without dragging: the next press on its page puts
      those edges there. */
  armed = $state.raw<{ p: number; item: T; edges: string } | null>(null);
  /** While a finger or pen resizes or draws, the page point under it
      (x, y) and its screen point (cx, cy), for a magnifier. */
  loupe = $state.raw<{
    p: number;
    x: number;
    y: number;
    cx: number;
    cy: number;
  } | null>(null);
  /** A drag has moved and not yet ended. */
  dragging = $state(false);

  #drag: Drag<T> | null = null;
  // A finger or pen press that may become a tap: on a box (item) or on the
  // page (null). Travel past TAP_SLOP_PX or a scroll ends it.
  #press: {
    id: number;
    p: number;
    item: T | null;
    x: number;
    y: number;
  } | null = null;
  #lastTap: { on: T; t: number } | null = null;
  #lastPageTap: { p: number; x: number; y: number; t: number } | null = null;
  #hintTimer: ReturnType<typeof setTimeout> | undefined;
  // The element holding the pointer of the drag or Shift+drag under way.
  #captured: HTMLElement | SVGElement | null = null;
  // The last press a box took; the page behind it lets it pass.
  #boxPress: PointerEvent | null = null;
  // Fingers down on the pages; after a pinch none edits until all lifted.
  #fingers = new Set<number>();
  #held = false;
  #lastPointer: { clientX: number; clientY: number } | null = null;
  #edgeFrame = 0;

  #history = $state.raw<S[]>([]);
  #index = $state(-1);
  // The current entry as JSON, to tell an unchanged state.
  #current = "";

  constructor(host: BoxEditorHost<T, S>) {
    this.#host = host;
  }

  // ------------------------------------------------------------------
  // Selection

  /** The selected box with its page and index; null when none is
      selected or the box is gone. */
  readonly selected = $derived.by(() => {
    const s = this.#sel;
    if (!s) return null;
    const z = this.#host.items(s.p).indexOf(s.item);
    return z < 0 ? null : { p: s.p, z, item: s.item };
  });
  /** Several boxes of the selected box's page selected together, the
      selected box among them; empty while one box or none is selected. */
  readonly group = $derived.by(() => {
    const s = this.selected;
    if (!s || this.#group.length < 2) return [];
    const list = this.#host.items(s.p);
    const found = this.#group.filter((i) => list.includes(i));
    return found.length > 1 ? found : [];
  });

  inSelection = (item: T | undefined): boolean =>
    item !== undefined &&
    (this.selected?.item === item || this.group.includes(item));

  /** The selected boxes: the group, or the one box. */
  selection(): T[] {
    if (this.group.length) return this.group;
    return this.selected ? [this.selected.item] : [];
  }

  /** Select a box (null: none). A box outside the group ends the group;
      selecting none ends Select several; another box puts a picked-up
      handle down. */
  select(p: number, item: T | null) {
    this.#sel = item ? { p, item } : null;
    if (!item || !this.#group.includes(item)) this.#group = [];
    if (!item) this.pickMode = false;
    if (this.armed && this.armed.item !== item) this.armed = null;
  }

  /** Select the boxes `list` of page p; the selected box stays the one
      the keys start from where the list holds it. */
  selectItems(p: number, list: T[]) {
    const now = this.selected?.p === p ? this.selected.item : undefined;
    const primary = primaryOf(list, now);
    this.select(p, primary ?? null);
    this.#group = list.length > 1 ? list : [];
  }

  /** Add a box to the selection, or take it out. A selection holds the
      boxes of one page. */
  toggle(p: number, item: T) {
    const now = this.selected?.p === p ? this.selection() : [];
    this.selectItems(p, toggled(now, item));
  }

  /** Drop the selection, a set corner and a picked-up handle. */
  clear() {
    this.select(0, null);
    this.corner = null;
    this.armed = null;
  }

  /** Turn draw mode on or off; off, nothing stays selected, picked or set. */
  setDrawMode(on: boolean) {
    this.drawMode = on;
    this.drawHint = false;
    if (on) return;
    this.clear();
    this.pickMode = false;
    this.#lastTap = null;
  }

  // ------------------------------------------------------------------
  // Undo history

  readonly canUndo = $derived.by(() => this.#host.canEdit() && this.#index > 0);
  readonly canRedo = $derived.by(
    () => this.#host.canEdit() && this.#index < this.#history.length - 1,
  );

  /** Start the history again from the current state. */
  resetHistory() {
    const snap = this.#host.snapshot();
    this.#history = [snap];
    this.#index = 0;
    this.#current = JSON.stringify(snap);
  }

  /** Record the current state as an undo step, unless it is unchanged.
      Nothing is recorded while a drag is under way. */
  commit() {
    if (this.busy) return;
    const snap = this.#host.snapshot();
    const json = JSON.stringify(snap);
    if (json === this.#current) return;
    const next = recorded(this.#history, this.#index, snap);
    this.#history = next.history;
    this.#index = next.index;
    this.#current = json;
  }

  undo() {
    if (this.canUndo && !this.busy) this.#restore(this.#index - 1);
  }

  redo() {
    if (this.canRedo && !this.busy) this.#restore(this.#index + 1);
  }

  #restore(i: number) {
    this.#index = i;
    this.#current = JSON.stringify(this.#history[i]);
    this.#host.restore(this.#history[i]);
    this.clear();
  }

  // ------------------------------------------------------------------
  // Pointer

  /** A drag or a Shift+drag is under way. */
  get busy(): boolean {
    return this.#drag !== null || this.marquee !== null;
  }

  /** The window listeners the gestures need; returns their removal. */
  listen(): () => void {
    const move = (e: PointerEvent) => this.#move(e);
    const up = (e: PointerEvent) => this.#up(e);
    const cancel = (e: PointerEvent) => {
      this.#release(e);
      this.#lost(e.pointerId);
    };
    const lost = (e: PointerEvent) => {
      if (e.target === this.#captured) this.#lost(e.pointerId);
    };
    const blur = () => this.cancel();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("lostpointercapture", lost);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("lostpointercapture", lost);
      window.removeEventListener("blur", blur);
      this.#stop();
      clearTimeout(this.#hintTimer);
    };
  }

  /** A second finger landed: the edit under way is undone, and no finger
      edits until all have lifted. */
  hold() {
    this.#held = true;
    this.cancel();
  }

  /** Undo the gesture under way: a drawn box goes, a moved one returns, a
      Shift+drag's selection returns to what it was. */
  cancel() {
    this.#press = null;
    const m = this.marquee;
    if (m) {
      this.marquee = null;
      this.selectItems(m.p, m.base);
    }
    const d = this.#drag;
    this.#stop();
    if (d) this.#undoDrag(d);
  }

  /** A press on a box's body, or on one of its handles (`edges`). */
  boxDown(e: PointerEvent, p: number, item: T, edges = "") {
    this.#boxPress = e;
    if (!this.#mayPress(e)) return;
    const host = this.#host;
    const resize = edges !== "";
    // A finger or pen on a box not selected may scroll the page; lifted
    // without travelling, it taps the box (#tap).
    if (!this.#fine(e) && !this.inSelection(item)) {
      this.#press = { id: e.pointerId, p, item, x: e.clientX, y: e.clientY };
      return;
    }
    const edit = host.canEdit();
    // With Shift a click adds the box to the selection or takes it out, and
    // a drag selects with a rectangle; in Select several a click adds a box.
    if (
      !resize &&
      edit &&
      (e.shiftKey || (this.pickMode && !this.inSelection(item)))
    ) {
      this.corner = null;
      if (e.shiftKey) this.#startMarquee(e, p, item);
      else this.toggle(p, item);
      return;
    }
    this.corner = null;
    this.select(p, item);
    if (!edit) return;
    const { x, y } = this.#point(e, p);
    // Cmd (Mac) or Ctrl drags a copy; the original stays. A box of a group
    // moves the whole group, or a copy of it.
    const copy = !resize && copyKey(e);
    const together = !resize && this.group.includes(item) ? this.group : null;
    let at = item;
    let members: Drag<T>["members"] = null;
    if (together) {
      const moving = copy
        ? together.map((i) => host.add(p, { ...host.box(i) }, i))
        : together;
      members = moving.map((m, i) => ({
        item: m,
        origin: { ...host.box(together[i]) },
      }));
      at = moving[together.indexOf(item)];
      this.select(p, at);
      this.#group = moving;
    } else if (copy) {
      at = host.add(p, { ...host.box(item) }, item);
      this.select(p, at);
    }
    const d: Drag<T> = {
      id: e.pointerId,
      kind: resize ? "resize" : "move",
      p,
      item: at,
      sx: x,
      sy: y,
      origin: { ...host.box(item) },
      edges,
      started: true,
      moved: false,
      deselected: false,
      fine: this.#fine(e),
      slop: e.pointerType === "mouse" ? MOVE_SLOP_PX.mouse : MOVE_SLOP_PX.touch,
      copyOf: copy ? item : null,
      members,
      copied: copy && together ? together : null,
    };
    this.#drag = d;
    this.#capture(e, p);
    if (resize) this.#loupeAt(e, d, x, y);
  }

  /** A press on page p outside the boxes. */
  pageDown(e: PointerEvent, p: number) {
    if (e === this.#boxPress || !this.#mayPress(e)) return;
    const host = this.#host;
    // A finger or pen outside draw mode, or with the boxes hidden, scrolls
    // the page; lifted without travelling, it deselects (#tap).
    if (!this.#fine(e) && (!this.drawMode || !host.shown())) {
      this.#press = {
        id: e.pointerId,
        p,
        item: null,
        x: e.clientX,
        y: e.clientY,
      };
      return;
    }
    // A Shift+drag selects the boxes it touches, adding them to the
    // selection.
    if (e.shiftKey && host.canEdit() && host.shown()) {
      this.#startMarquee(e, p, null);
      return;
    }
    const deselected = this.selected !== null;
    this.select(p, null);
    if (!host.canDraw(p)) return;
    const { x, y } = this.#point(e, p);
    this.#drag = {
      id: e.pointerId,
      kind: "draw",
      p,
      item: null,
      sx: x,
      sy: y,
      origin: { ulx: x, uly: y, lrx: x, lry: y },
      edges: "",
      started: false,
      moved: false,
      deselected,
      fine: this.#fine(e),
      slop: 0,
      copyOf: null,
      members: null,
      copied: null,
    };
    this.#capture(e, p);
  }

  /** The capture-phase press on page p: a picked-up handle's edges go to
      it, and the press does nothing else. Elements marked data-control
      keep their press. */
  placeArmed(e: PointerEvent, p: number) {
    const a = this.armed;
    if (!a || (e.target as Element).closest("[data-control]")) return;
    this.armed = null;
    const host = this.#host;
    if (a.p !== p || !host.items(p).includes(a.item) || !host.canEdit()) return;
    e.stopPropagation();
    e.preventDefault();
    const { x, y } = this.#point(e, p);
    const box = host.box(a.item);
    const before = { ...box };
    const next = resizedBox(before, a.edges, x, y, host.minSize(p));
    Object.assign(box, host.snap ? host.snap(p, next, [a.item], false) : next);
    this.#settle(p, [a.item], () => Object.assign(box, before));
  }

  // ------------------------------------------------------------------
  // Keys

  /** The editor's keys on the window: while a drag or a Shift+drag is
      under way Esc undoes it and the other keys do nothing; Cmd/Ctrl+Z
      undoes, with Shift (or Ctrl+Y) redoes; Esc puts a picked-up handle
      down, then clears a set corner. Text fields keep their keys. Returns
      whether the key was taken. */
  keydown(e: KeyboardEvent): boolean {
    if (
      (e.target as Element).closest(
        "input, textarea, select, [contenteditable]",
      )
    )
      return false;
    if (this.busy) {
      if (e.key === "Escape") this.cancel();
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && /^[zy]$/i.test(e.key)) {
      e.preventDefault();
      if (e.shiftKey || e.key.toLowerCase() === "y") this.redo();
      else this.undo();
      return true;
    }
    if (e.key !== "Escape") return false;
    if (this.armed) this.armed = null;
    else if (this.corner) this.corner = null;
    else return false;
    return true;
  }

  /** A key on a focused box: Enter or Space selects it (with Shift adds it
      to the selection or takes it out), Delete removes it, the arrows move
      it; a box of the group takes the group along. Returns whether the key
      was taken. */
  boxKeydown(e: KeyboardEvent, p: number, item: T): boolean {
    const edit = this.#host.canEdit();
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (e.shiftKey && edit) this.toggle(p, item);
      else this.selectItems(p, [item]);
      return true;
    }
    if (!edit) return false;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      this.#delete(p, this.group.includes(item) ? this.group : [item]);
      return true;
    }
    if (!arrowShift(e.key, 1)) return false;
    this.nudge(e, p, item);
    return true;
  }

  /** Arrow keys on a focused handle move its edges. Returns whether the key
      was taken. */
  edgeKeydown(e: KeyboardEvent, p: number, item: T, edges: string): boolean {
    const host = this.#host;
    const page = host.page(p);
    const shift = arrowShift(
      e.key,
      e.shiftKey ? host.nudge.far : host.nudge.near,
    );
    if (!shift || !page || !host.canEdit()) return false;
    e.preventDefault();
    const box = host.box(item);
    const before = { ...box };
    Object.assign(
      box,
      nudgedEdges(box, edges, shift.dx, shift.dy, host.minSize(p), page),
    );
    this.#settle(p, [item], () => Object.assign(box, before));
    return true;
  }

  /** Move a box, or the group it belongs to, by an arrow key's step. */
  nudge(e: KeyboardEvent, p: number, item: T) {
    const host = this.#host;
    const page = host.page(p);
    const shift = arrowShift(
      e.key,
      e.shiftKey ? host.nudge.far : host.nudge.near,
    );
    if (!shift || !page || !host.canEdit()) return;
    e.preventDefault();
    const list = this.group.includes(item) ? this.group : [item];
    this.select(p, item);
    const boxes = list.map((i) => host.box(i));
    const before = boxes.map((b) => ({ ...b }));
    const moved = movedBoxes(before, shift.dx, shift.dy, page);
    boxes.forEach((b, i) => Object.assign(b, moved[i]));
    this.#settle(p, list, () =>
      boxes.forEach((b, i) => Object.assign(b, before[i])),
    );
  }

  /** Remove the selected boxes. */
  deleteSelection() {
    const s = this.selected;
    if (s && this.#host.canEdit()) this.#delete(s.p, this.selection());
  }

  /** Copies of the group beside it (copyPlace), selected in its place. */
  duplicate() {
    const host = this.#host;
    const s = this.selected;
    const page = s && host.page(s.p);
    if (!s || !page || !this.group.length || !host.canEdit()) return;
    const originals = this.group;
    const boxes = copyPlace(
      originals.map((i) => host.box(i)),
      page,
    );
    const copies = originals.map((i, n) => host.add(s.p, boxes[n], i));
    if (
      this.#settle(s.p, copies, () =>
        copies.forEach((c) => host.remove(s.p, c)),
      )
    )
      this.selectItems(s.p, copies);
  }

  // ------------------------------------------------------------------
  // Internals

  #fine = (e: PointerEvent) => e.pointerType === "mouse" || !this.#host.touch();

  /** Whether a press may start anything, keeping count of the fingers. */
  #mayPress(e: PointerEvent): boolean {
    if (e.pointerType === "touch") this.#fingers.add(e.pointerId);
    return !this.#held && e.button === 0;
  }

  #release(e: PointerEvent) {
    if (e.pointerType !== "touch") return;
    this.#fingers.delete(e.pointerId);
    if (!this.#fingers.size) this.#held = false;
  }

  #point(e: { clientX: number; clientY: number }, p: number) {
    const el = this.#host.surface(p);
    const page = this.#host.page(p);
    if (!el || !page) return { x: 0, y: 0 };
    return pagePoint(e, el.getBoundingClientRect(), page);
  }

  // Page p's element takes the pointer, so its release reaches the editor
  // wherever it happens. The element holding a pointer gives the cursor, so
  // it shows the pressed element's cursor until the drag ends.
  #capture(e: PointerEvent, p: number) {
    const el = this.#host.surface(p) as HTMLElement | SVGElement | undefined;
    try {
      el?.setPointerCapture(e.pointerId);
      this.#captured = el ?? null;
    } catch {
      this.#captured = null;
    }
    if (this.#captured)
      this.#captured.style.cursor = getComputedStyle(
        e.target as Element,
      ).cursor;
  }

  // The pointer of the gesture under way is gone without a release.
  #lost(id: number) {
    if (this.#press?.id === id) this.#press = null;
    if (this.#drag?.id === id || this.marquee?.id === id) this.cancel();
  }

  #startMarquee(e: PointerEvent, p: number, hit: T | null) {
    const { x, y } = this.#point(e, p);
    this.marquee = {
      id: e.pointerId,
      p,
      sx: x,
      sy: y,
      x,
      y,
      moved: false,
      base: this.selected?.p === p ? this.selection() : [],
      hit,
    };
    this.#capture(e, p);
  }

  #marqueeTo(e: PointerEvent, m: Marquee<T>) {
    const host = this.#host;
    const page = host.page(m.p);
    if (!page) return;
    const { x, y } = this.#point(e, m.p);
    if (
      !m.moved &&
      !drawStarted(
        x - m.sx,
        y - m.sy,
        page,
        host.screenWidth(m.p) || page.width,
      )
    )
      return;
    this.marquee = { ...m, x, y, moved: true };
    const area = drawnBox(m.sx, m.sy, x, y, 0);
    const hits = host
      .items(m.p)
      .filter((i) => boxesTouch(area, host.box(i)) && !m.base.includes(i));
    this.selectItems(m.p, [...m.base, ...hits]);
  }

  #move(e: PointerEvent) {
    const press = this.#press;
    if (
      press?.id === e.pointerId &&
      Math.hypot(e.clientX - press.x, e.clientY - press.y) >= TAP_SLOP_PX
    )
      this.#press = null;
    const m = this.marquee;
    if (m?.id === e.pointerId) this.#marqueeTo(e, m);
    const d = this.#drag;
    if (d?.id !== e.pointerId) return;
    this.#lastPointer = { clientX: e.clientX, clientY: e.clientY };
    this.#apply(this.#lastPointer, e);
    if (!this.#edgeFrame && this.#host.scroller)
      this.#edgeFrame = requestAnimationFrame(this.#scrollAtEdge);
  }

  // The drag at the pointer `at`; `e` is the pointer event for a magnifier.
  #apply(at: { clientX: number; clientY: number }, e?: PointerEvent) {
    const d = this.#drag;
    const host = this.#host;
    const page = d && host.page(d.p);
    if (!d || !page) return;
    const { x, y } = this.#point(at, d.p);
    const dx = x - d.sx;
    const dy = y - d.sy;
    const sw = host.screenWidth(d.p) || page.width;
    if (!d.started) {
      if (!drawStarted(dx, dy, page, sw)) return;
      this.corner = null;
      d.item = host.add(d.p, { ...d.origin });
      d.started = true;
      this.select(d.p, d.item);
    }
    if (!d.moved) {
      if (d.kind !== "draw" && !travelled(dx, dy, page, sw, d.slop)) return;
      d.moved = true;
      this.dragging = true;
    }
    if (d.members) {
      const moved = movedBoxes(
        d.members.map((m) => m.origin),
        dx,
        dy,
        page,
      );
      const s = this.#shift(
        d.p,
        boundingBox(moved),
        d.members.map((m) => m.item),
      );
      d.members.forEach((m, i) =>
        Object.assign(host.box(m.item), movedBox(moved[i], s.dx, s.dy, page)),
      );
      return;
    }
    const item = d.item!;
    const box = host.box(item);
    if (d.kind === "move") {
      const moved = movedBox(d.origin, dx, dy, page);
      const s = this.#shift(d.p, moved, [item]);
      Object.assign(box, movedBox(moved, s.dx, s.dy, page));
      return;
    }
    const min = host.minSize(d.p);
    const next =
      d.kind === "draw"
        ? drawnBox(d.sx, d.sy, x, y, min)
        : resizedBox(d.origin, d.edges, x, y, min);
    Object.assign(box, host.snap ? host.snap(d.p, next, [item], false) : next);
    if (e) this.#loupeAt(e, d, x, y);
  }

  // How far snapping shifts a moved box (or a group's bounding box).
  #shift(p: number, box: Box, own: T[]) {
    if (!this.#host.snap) return { dx: 0, dy: 0 };
    const to = this.#host.snap(p, box, own, true);
    return { dx: to.ulx - box.ulx, dy: to.uly - box.uly };
  }

  // A magnifier for a finger or pen, or any pointer on a touch screen. A
  // resize centres on the dragged edge or corner, which can sit a few
  // pixels from the finger when the press starts.
  #loupeAt(e: PointerEvent, d: Drag<T>, x: number, y: number) {
    if (e.pointerType === "mouse" && !this.#host.touch()) return;
    if (d.kind === "resize" && d.item) {
      const b = this.#host.box(d.item);
      if (d.edges.includes("w")) x = b.ulx;
      else if (d.edges.includes("e")) x = b.lrx;
      if (d.edges.includes("n")) y = b.uly;
      else if (d.edges.includes("s")) y = b.lry;
    }
    this.loupe = { p: d.p, x, y, cx: e.clientX, cy: e.clientY };
  }

  // A drag near the scroller's edge scrolls it, so a box can be drawn or
  // moved past what is in view; the drag follows the pointer as it scrolls.
  #scrollAtEdge = () => {
    this.#edgeFrame = 0;
    const el = this.#host.scroller?.();
    const at = this.#lastPointer;
    if (!this.#drag || !at || !el) return;
    const EDGE = 40;
    const box = el.getBoundingClientRect();
    const step = (inside: number) => Math.ceil((EDGE - inside) / 4);
    const { clientX: x, clientY: y } = at;
    const dy =
      y < box.top + EDGE
        ? -step(y - box.top)
        : y > box.bottom - EDGE
          ? step(box.bottom - y)
          : 0;
    const dx =
      x < box.left + EDGE
        ? -step(x - box.left)
        : x > box.right - EDGE
          ? step(box.right - x)
          : 0;
    const top = el.scrollTop;
    const left = el.scrollLeft;
    el.scrollTop += dy;
    el.scrollLeft += dx;
    if (el.scrollTop !== top || el.scrollLeft !== left) this.#apply(at);
    this.#edgeFrame = requestAnimationFrame(this.#scrollAtEdge);
  };

  // The drag under way ends, kept or undone by the caller.
  #stop() {
    this.#drag = null;
    this.dragging = false;
    this.loupe = null;
    this.#lastPointer = null;
    cancelAnimationFrame(this.#edgeFrame);
    this.#edgeFrame = 0;
    // The capture ends with the pointer's release; until then its loss
    // concerns no gesture.
    if (this.#captured) this.#captured.style.cursor = "";
    this.#captured = null;
  }

  #up(e: PointerEvent) {
    this.#release(e);
    const press = this.#press;
    if (press?.id === e.pointerId) {
      this.#press = null;
      this.#tap(press.p, press.item);
    }
    const m = this.marquee;
    if (m?.id === e.pointerId) {
      this.marquee = null;
      if (!m.moved && m.hit && this.#host.items(m.p).includes(m.hit))
        this.toggle(m.p, m.hit);
    }
    const d = this.#drag;
    if (d?.id !== e.pointerId) return;
    this.#stop();
    this.#end(d);
  }

  // A finger or pen tap: on a box (item) or on the page (null).
  #tap(p: number, item: T | null) {
    const host = this.#host;
    if (!item) {
      this.select(p, null);
      return;
    }
    if (!host.items(p).includes(item)) return;
    if (this.pickMode) {
      this.toggle(p, item);
      return;
    }
    // Outside draw mode a tap marks the Draw toggle; a double tap turns
    // draw mode on and selects the box.
    if (host.canEdit() && !this.drawMode) {
      if (this.#doubleTap(item)) {
        this.drawMode = true;
        this.drawHint = false;
        this.corner = null;
        this.select(p, item);
        return;
      }
      this.drawHint = true;
      clearTimeout(this.#hintTimer);
      this.#hintTimer = setTimeout(() => (this.drawHint = false), 1600);
      return;
    }
    this.corner = null;
    this.select(p, item);
    if (host.canEdit()) this.#doubleTap(item);
  }

  // Whether a tap on `item` is the second of a double tap; any other tap
  // is recorded as a first.
  #doubleTap(item: T): boolean {
    const t = performance.now();
    const double = isDoubleTap(this.#lastTap, item, t);
    this.#lastTap = double ? null : { on: item, t };
    return double;
  }

  #end(d: Drag<T>) {
    const host = this.#host;
    // A handle pressed and released without moving is picked up (armed);
    // pressed again it is put down.
    if (d.kind === "resize" && !d.moved) {
      const a = this.armed;
      this.armed =
        a?.item === d.item && a.edges === d.edges
          ? null
          : { p: d.p, item: d.item!, edges: d.edges };
      return;
    }
    // A box pressed without moving: a Cmd/Ctrl click leaves no copy; in
    // Select several it leaves the selection; in draw mode on a touch
    // screen the second tap of a double tap ends draw mode; a box of a
    // group is selected alone.
    if (d.kind === "move" && !d.moved) {
      if (d.copyOf) this.#dropCopies(d);
      else if (this.pickMode) this.toggle(d.p, d.item!);
      else if (!d.fine && this.drawMode && this.#doubleTap(d.item!))
        this.setDrawMode(false);
      else if (d.members) this.selectItems(d.p, [d.item!]);
      return;
    }
    // A draw that never started was a plain click: it sets the first corner
    // or completes the box. On a touch screen a second tap close to the
    // first within DOUBLE_TAP_MS ends draw mode.
    if (d.kind === "draw" && !d.started) {
      if (!d.fine) {
        const page = host.page(d.p);
        const k = page ? (host.screenWidth(d.p) || page.width) / page.width : 1;
        const t = performance.now();
        const last = this.#lastPageTap;
        if (
          last?.p === d.p &&
          t - last.t < DOUBLE_TAP_MS &&
          Math.hypot(d.sx - last.x, d.sy - last.y) * k < DOUBLE_TAP_PX
        ) {
          this.#lastPageTap = null;
          this.setDrawMode(false);
          return;
        }
        this.#lastPageTap = { p: d.p, x: d.sx, y: d.sy, t };
      }
      if (!d.deselected) this.#cornerClick(d.p, d.sx, d.sy);
      return;
    }
    if (d.kind === "draw") {
      const b = host.box(d.item!);
      const drop = host.dropBelow(d.p);
      // A tiny drawn box was a click on the page.
      if (b.lrx - b.ulx < drop || b.lry - b.uly < drop) {
        host.remove(d.p, d.item!);
        this.select(d.p, null);
        return;
      }
    }
    const edited = d.members ? d.members.map((m) => m.item) : [d.item!];
    this.#settle(d.p, edited, () => this.#undoDrag(d));
  }

  // Put back what a drag changed.
  #undoDrag(d: Drag<T>) {
    const host = this.#host;
    if (d.copyOf) this.#dropCopies(d);
    else if (d.members)
      d.members.forEach((m) => Object.assign(host.box(m.item), m.origin));
    else if (d.kind === "draw") {
      if (d.started && d.item) {
        host.remove(d.p, d.item);
        this.select(d.p, null);
      }
    } else if (d.item) Object.assign(host.box(d.item), d.origin);
  }

  // Undo a Cmd/Ctrl move: its copies go, and the boxes copied are selected
  // again, the one pressed first.
  #dropCopies(d: Drag<T>) {
    const host = this.#host;
    if (d.members) {
      d.members.forEach((m) => host.remove(d.p, m.item));
      this.select(d.p, d.copyOf);
      this.#group = d.copied ?? [];
    } else {
      if (d.item) host.remove(d.p, d.item);
      this.select(d.p, d.copyOf);
    }
  }

  // A plain click on the page: the first sets a corner, the second on the
  // same page and in the same scope completes the box spanning the two. A
  // second click on the same spot makes no box.
  #cornerClick(p: number, x: number, y: number) {
    const host = this.#host;
    const first = this.corner;
    const scope = host.scope();
    this.corner = null;
    if (!first || first.p !== p || first.scope !== scope) {
      this.corner = { p, scope, x, y };
      return;
    }
    let box = drawnBox(first.x, first.y, x, y, host.minSize(p));
    const drop = host.dropBelow(p);
    if (box.lrx - box.ulx < drop || box.lry - box.uly < drop) return;
    if (host.snap) box = host.snap(p, box, [], false);
    const item = host.add(p, box);
    if (this.#settle(p, [item], () => host.remove(p, item)))
      this.select(p, item);
  }

  #delete(p: number, list: T[]) {
    list.forEach((i) => this.#host.remove(p, i));
    this.select(p, null);
    this.#host.changed(p);
  }

  // Keep an edit the host accepts and record it; undo one it refuses.
  #settle(p: number, edited: T[], undo: () => void): boolean {
    if (this.#host.accept && !this.#host.accept(p, edited)) {
      undo();
      return false;
    }
    this.#host.changed(p);
    return true;
  }
}

// Cmd on a Mac, Ctrl elsewhere.
const copyKey = (e: PointerEvent) =>
  /Mac|iPhone|iPad/.test(navigator.userAgent) ? e.metaKey : e.ctrlKey;
