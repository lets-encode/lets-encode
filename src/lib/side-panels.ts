// The side panel of the campaign views (SidePanel.svelte): its width when it
// sits beside the content and its snap height when it is docked below it,
// kept per browser.

/** The docked panel's heights, lowest first (SNAP_CSS). */
export const PANEL_SNAPS = ["peek", "half", "full"] as const;
export type PanelSnap = (typeof PANEL_SNAPS)[number];

export interface SidePanelState {
  width: number;
  snap: PanelSnap;
}

const WIDTH_KEY = "lets-encode:side-panel-width";
const SNAP_KEY = "lets-encode:side-panel-snap";

export const PANEL_MIN = 280;
/** The width beside the panel kept for the content: the campaign board's
    narrowest stacked-lanes width (420px; narrower, it shows one lane at a
    time with lane tabs) plus its row's 40px padding and 14px gap. */
export const CONTENT_BESIDE_MIN = 474;

/** Where the panel docks below the content instead of beside it: portrait
    windows too narrow for the panel at PANEL_MIN beside CONTENT_BESIDE_MIN.
    ui.css, ScoreView.svelte and the campaign page repeat the width in their
    media queries. */
export const DOCKED_QUERY = "(orientation: portrait) and (max-width: 753px)";
/** The widest default panel beside the content (defaultPanelWidth). */
export const DEFAULT_PANEL_WIDTH = 400;
const DEFAULT_WIDTH_SHARE = 0.38;
/** The docked height a panel opens at. */
export const DEFAULT_PANEL_SNAP: PanelSnap = "half";
/** The window height the full snap leaves for the content above it. */
const FULL_GAP = 160;
const PEEK_MIN = 180;
const PEEK_SHARE = 0.32;
const HALF_SHARE = 0.55;

/** Each snap's height as CSS, following the dynamic viewport so a mobile
    browser's address bar showing or hiding resizes the panel with it. */
export const SNAP_CSS: Record<PanelSnap, string> = {
  peek: `max(${PEEK_MIN}px, ${PEEK_SHARE * 100}dvh)`,
  half: `${HALF_SHARE * 100}dvh`,
  full: `calc(100dvh - ${FULL_GAP}px)`,
};

/** A snap's height in pixels in a window `viewport` pixels tall. */
export function snapHeight(snap: PanelSnap, viewport: number): number {
  if (snap === "peek") return Math.max(PEEK_MIN, viewport * PEEK_SHARE);
  if (snap === "half") return viewport * HALF_SHARE;
  return viewport - FULL_GAP;
}

/** The snap nearest a dragged height. */
export function nearestSnap(height: number, viewport: number): PanelSnap {
  let best: PanelSnap = PANEL_SNAPS[0];
  for (const s of PANEL_SNAPS)
    if (
      Math.abs(snapHeight(s, viewport) - height) <
      Math.abs(snapHeight(best, viewport) - height)
    )
      best = s;
  return best;
}

/** The snap one step higher (1) or lower (-1), held at the ends. */
export function stepSnap(snap: PanelSnap, dir: 1 | -1): PanelSnap {
  const i = PANEL_SNAPS.indexOf(snap) + dir;
  return PANEL_SNAPS[Math.min(Math.max(i, 0), PANEL_SNAPS.length - 1)];
}

/** A dragged docked height, kept between 120px and the height of the full
    snap. */
export function clampPanelHeight(h: number, viewport: number): number {
  return Math.round(
    Math.min(Math.max(h, 120), Math.max(120, viewport - FULL_GAP)),
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
  const snap = readStored(SNAP_KEY);
  const viewport = typeof window === "undefined" ? 800 : window.innerHeight;
  const viewportWidth =
    typeof window === "undefined" ? 1280 : window.innerWidth;
  return {
    width:
      finite(w) && w >= PANEL_MIN
        ? Math.round(w)
        : defaultPanelWidth(viewportWidth, viewport),
    snap: PANEL_SNAPS.includes(snap as PanelSnap)
      ? (snap as PanelSnap)
      : DEFAULT_PANEL_SNAP,
  };
}

/** Whether the viewer has set a width (by dragging) in this browser. */
export const hasStoredPanelWidth = (): boolean => {
  const w = readStored(WIDTH_KEY);
  return finite(w) && w >= PANEL_MIN;
};

/** Store the dimension the viewer set: the width beside the content, or
    the snap docked below it. A browser refusing the write leaves it
    unstored. */
export function writeSidePanel(
  state: SidePanelState,
  dimension: "width" | "snap",
): void {
  try {
    if (dimension === "width")
      store()?.setItem(WIDTH_KEY, JSON.stringify(state.width));
    else store()?.setItem(SNAP_KEY, JSON.stringify(state.snap));
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

/** A panel width, kept between the minimum and half the viewport, and
    leaving CONTENT_BESIDE_MIN beside it where the viewport allows. */
export function clampPanelWidth(w: number, viewport: number): number {
  const max = Math.min(viewport / 2, viewport - CONTENT_BESIDE_MIN);
  return Math.round(Math.min(Math.max(w, PANEL_MIN), Math.max(PANEL_MIN, max)));
}
