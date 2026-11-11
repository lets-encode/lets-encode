/**
 * Where the wizard frame's popups (other setups, the discard question, the
 * step's info) open, placed against the window.
 */

export type PopupKind = "others" | "discard" | "info";

/** A box's edges in window coordinates, as getBoundingClientRect gives them. */
export interface Edges {
  left: number;
  right: number;
  bottom: number;
}

/**
 * The popup's inline style. Beside the compact rail (`besideRail`) the
 * other setups and the discard question open right of the rail, level with
 * the anchor's foot; otherwise a popup opens under its anchor, the info
 * popup from the anchor's left edge and the others ending at its right edge,
 * kept 8px inside the window.
 */
export function popupStyle(opts: {
  kind: PopupKind;
  anchor: Edges;
  rail: Edges | null;
  width: number;
  viewportWidth: number;
  viewportHeight: number;
  besideRail: boolean;
}): string {
  const { kind, anchor: box, viewportWidth: vw } = opts;
  const w = Math.min(opts.width, vw - 16);
  let place: string;
  if (opts.besideRail && kind !== "info") {
    const rail = opts.rail ?? box;
    place = `left: ${rail.right + 8}px; bottom: ${opts.viewportHeight - box.bottom}px`;
  } else {
    const start = kind === "info" ? box.left - 8 : box.right - w;
    const left = Math.max(8, Math.min(start, vw - w - 8));
    place = `left: ${left}px; top: ${box.bottom + 4}px`;
  }
  return `${place}; width: ${w}px`;
}
