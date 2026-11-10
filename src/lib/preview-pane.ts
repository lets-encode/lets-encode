// Which panes a score preview shows: the facsimile, the rendered encoding, or
// both side by side. The choice is a viewing preference rather than campaign
// data, so it is kept per browser and applies to every preview.

import { readLocal, writeLocal } from "./local-store.ts";

/** The pane layout a preview shows. */
export type PreviewPane = "facs" | "enc" | "both";

const KEY = "lets-encode:preview-pane";

/** The stored choice, or 'facs' when nothing valid is stored. */
export function readPreviewPane(): PreviewPane {
  const value = readLocal(KEY);
  return value === "enc" || value === "both" || value === "facs"
    ? value
    : "facs";
}

/** Store an explicit pick. A browser refusing the write leaves the choice unstored. */
export function writePreviewPane(pane: PreviewPane): void {
  writeLocal(KEY, pane);
}
