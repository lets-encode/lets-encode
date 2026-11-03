// The rules of the shared box editor (box-editor.svelte.ts) that need no
// component: when a press became a drag, when two taps are a double tap,
// how a selection of several boxes changes, and how the undo history grows.
// Pure functions.

import type { PageSize } from "./box-geometry.ts";

/** Milliseconds within which a second tap makes a double tap. */
export const DOUBLE_TAP_MS = 350;
/** Screen pixels within which a second tap on the page makes a double tap. */
export const DOUBLE_TAP_PX = 24;
/** Screen pixels a finger may travel and still tap. */
export const TAP_SLOP_PX = 10;
/** Screen pixels a press on a box must travel before the box follows it:
    a mouse, and a finger or pen. */
export const MOVE_SLOP_PX = { mouse: 3, touch: 8 };
/** Undo steps kept; older ones are dropped. */
export const HISTORY_LIMIT = 100;

/**
 * Whether a pointer has travelled `px` screen pixels. `dx`/`dy` are in page
 * pixels; `screenWidth` is the page's width on screen.
 */
export const travelled = (
  dx: number,
  dy: number,
  page: PageSize,
  screenWidth: number,
  px: number,
): boolean => Math.hypot(dx, dy) * (screenWidth / page.width) >= px;

/** Whether a tap on `on` at time `t` (ms) follows the tap `last` on the same thing within DOUBLE_TAP_MS. */
export const isDoubleTap = <K>(
  last: { on: K; t: number } | null,
  on: K,
  t: number,
): boolean => !!last && last.on === on && t - last.t < DOUBLE_TAP_MS;

/** `list` with `item` taken out, or added at the end. */
export const toggled = <T>(list: T[], item: T): T[] =>
  list.includes(item) ? list.filter((i) => i !== item) : [...list, item];

/** The box a selection of `list` starts from: `now` where the list holds it, else the list's last. */
export const primaryOf = <T>(list: T[], now: T | undefined): T | undefined =>
  now !== undefined && list.includes(now) ? now : list[list.length - 1];

/**
 * The history with `snap` recorded after entry `index`: the entries after
 * `index` (the redo steps) are dropped and the oldest fall off beyond
 * HISTORY_LIMIT.
 */
export function recorded<S>(
  history: S[],
  index: number,
  snap: S,
  limit = HISTORY_LIMIT,
): { history: S[]; index: number } {
  const next = [
    ...history.slice(Math.max(0, index + 2 - limit), index + 1),
    snap,
  ];
  return { history: next, index: next.length - 1 };
}
