/**
 * Which layout the wizard frame uses, read from the viewport.
 *
 * Navigation: the vertical step rail when the window is wide or landscape,
 * otherwise the horizontal step track above the card. Steps with a material
 * pane lay it out side by side with the card on wide, tall windows, stacked
 * above the card on tall portrait windows, and behind a two-tab switch inside
 * the card everywhere else.
 */
import { MediaQuery } from "svelte/reactivity";

const sidebarQuery = new MediaQuery(
  "(min-width: 1000px), (orientation: landscape) and (min-width: 640px)",
  true,
);
const shortQuery = new MediaQuery("(max-height: 500px)", false);
const sideBySideQuery = new MediaQuery(
  "(min-width: 1000px) and (min-height: 560px)",
  true,
);
const stackedQuery = new MediaQuery(
  "(min-width: 700px) and (min-height: 1000px)",
  false,
);
const coarseQuery = new MediaQuery("(pointer: coarse)", false);
// A mouse or trackpad is at hand, so files can be dragged onto a drop zone.
const dropQuery = new MediaQuery(
  "(any-pointer: fine) and (hover: hover)",
  true,
);

export type MaterialMode = "side" | "stacked" | "switch";

export const wizardLayout = {
  /** The step rail on the left rather than the step track on top. */
  get sidebar(): boolean {
    return sidebarQuery.current;
  },
  /** A window 500px tall or less: the compact rail. */
  get short(): boolean {
    return shortQuery.current;
  },
  get materialMode(): MaterialMode {
    if (sidebarQuery.current && sideBySideQuery.current) return "side";
    if (!sidebarQuery.current && stackedQuery.current) return "stacked";
    return "switch";
  },
  /** A mouse or trackpad is available: uploads offer a drop zone. */
  get dropZone(): boolean {
    return dropQuery.current;
  },
  /** The primary pointer is a finger. */
  get coarse(): boolean {
    return coarseQuery.current;
  },
};
