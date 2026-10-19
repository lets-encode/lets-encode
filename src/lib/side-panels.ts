// The side panel of the campaign views (SidePanel.svelte): its width when it
// sits beside the content, kept per browser.

export interface SidePanelState {
  width: number;
}

const WIDTH_KEY = "lets-encode:side-panel-width";

export const PANEL_MIN = 280;
/** The width beside the panel kept for the content: the campaign board's
    narrowest stacked-lanes width (420px; narrower, it shows one lane at a
    time with lane tabs) plus its row's 40px padding and 14px gap. */
export const CONTENT_BESIDE_MIN = 474;

/** Where the panel docks below the content instead of beside it: portrait
    windows up to 1100px wide, phones and tablets held upright (a 13-inch iPad
    is 1032px). Narrower than PANEL_MIN beside CONTENT_BESIDE_MIN the panel
    cannot sit beside the content at all; up to 1100px it would take the width
    the page images need. ui.css, ScoreView.svelte, DraftBubble.svelte and the
    campaign page repeat the width in their media queries. */
export const DOCKED_QUERY = "(orientation: portrait) and (max-width: 1100px)";
/** The widest default panel beside the content (defaultPanelWidth). */
export const DEFAULT_PANEL_WIDTH = 400;
const DEFAULT_WIDTH_SHARE = 0.38;
/** The window height a docked panel leaves for the content above it. */
const DOCKED_GAP = 160;
/** The docked panel's highest height as CSS, following the dynamic viewport
    so a mobile browser's address bar showing or hiding resizes it. */
export const DOCKED_MAX_CSS = `calc(100dvh - ${DOCKED_GAP}px)`;
/** A closed docked sheet's highest height as CSS: half the dynamic viewport,
    so a long selection scrolls inside the sheet and leaves the other half to
    the content above it. */
export const SHEET_PEEK_MAX_CSS = "50dvh";

/** A dragged docked height, kept between 120px and DOCKED_MAX_CSS. */
export function clampPanelHeight(h: number, viewport: number): number {
  return Math.round(
    Math.min(Math.max(h, 120), Math.max(120, viewport - DOCKED_GAP)),
  );
}

// Storage is read through this so the module can be used where there is none.
const store = () => (typeof localStorage === "undefined" ? null : localStorage);

function readStored(key: string): unknown {
  try {
    const raw = store()?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** The default width beside the content: half a short window (a phone in
    landscape), else 38% of the viewport between PANEL_MIN and
    DEFAULT_PANEL_WIDTH; never more than clampPanelWidth allows. */
export const defaultPanelWidth = (width: number, height: number): number =>
  Math.round(
    Math.min(
      clampPanelWidth(Infinity, width),
      height <= 500
        ? width / 2
        : Math.min(
            DEFAULT_PANEL_WIDTH,
            Math.max(PANEL_MIN, width * DEFAULT_WIDTH_SHARE),
          ),
    ),
  );

/** The stored panel state, or its defaults where nothing valid is stored. */
export function readSidePanel(): SidePanelState {
  const w = readStored(WIDTH_KEY);
  const viewport = typeof window === "undefined" ? 800 : window.innerHeight;
  const viewportWidth =
    typeof window === "undefined" ? 1280 : window.innerWidth;
  return {
    width:
      finite(w) && w >= PANEL_MIN
        ? Math.round(w)
        : defaultPanelWidth(viewportWidth, viewport),
  };
}

/** Whether the viewer has set a width (by dragging) in this browser. */
export const hasStoredPanelWidth = (): boolean => {
  const w = readStored(WIDTH_KEY);
  return finite(w) && w >= PANEL_MIN;
};

/** Store the width the viewer set beside the content. A browser refusing
    the write leaves it unstored. */
export function writeSidePanel(state: SidePanelState): void {
  try {
    store()?.setItem(WIDTH_KEY, JSON.stringify(state.width));
  } catch {
    /* full or blocked storage only costs the preference */
  }
}

// The task the panel showed last, kept per campaign so the board reopens it.
const lastTaskKey = (campaign: string) => `lets-encode:last-task:${campaign}`;

/** The task the panel showed last in this campaign, or null. */
export function readLastTask(campaign: string): string | null {
  try {
    return store()?.getItem(lastTaskKey(campaign)) ?? null;
  } catch {
    return null;
  }
}

/** Store the task the panel shows; null clears it. */
export function writeLastTask(campaign: string, task: string | null): void {
  try {
    if (task === null) store()?.removeItem(lastTaskKey(campaign));
    else store()?.setItem(lastTaskKey(campaign), task);
  } catch {
    /* full or blocked storage only costs the preference */
  }
}

/** A panel width, kept between the minimum (PANEL_MIN unless a view sets
    its own) and half the viewport, and leaving CONTENT_BESIDE_MIN beside it
    where the viewport allows. */
export function clampPanelWidth(
  w: number,
  viewport: number,
  min = PANEL_MIN,
): number {
  const max = Math.min(viewport / 2, viewport - CONTENT_BESIDE_MIN);
  return Math.round(Math.min(Math.max(w, min), Math.max(min, max)));
}
