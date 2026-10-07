// Zoom by gesture on a scrolling page view (the zone editor's desk, the score
// preview): a scroll with Ctrl (Windows, Linux) or Cmd (Mac) held, and a
// two-finger pinch on a touch screen. A trackpad pinch reaches the page as a
// Ctrl + scroll in Chromium and Firefox and as gesture events in Safari; both
// are handled. All set the same zoom level the view's slider sets.

/** Pixels per line for a wheel event that scrolls by lines (deltaMode 1). */
const LINE_PX = 16;
/** A wheel step's delta is capped here, so a mouse notch zooms by about a
    fifth while a trackpad's small deltas zoom smoothly. */
const MAX_DELTA = 50;
/** Zoom change per pixel of wheel delta, as an exponent. */
const PER_PX = 0.004;

/** The factor one Ctrl/Cmd + scroll event multiplies the zoom by: below 1
    scrolling down, above 1 scrolling up. */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * LINE_PX : deltaY;
  const capped = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, px));
  return Math.exp(-capped * PER_PX);
}

export interface ZoomGestureOptions {
  /** The current zoom level. */
  get: () => number;
  /** Set a new zoom level; the view clamps and rounds it. */
  set: (zoom: number) => void;
  /** A second finger touched down: the view drops a drag the first one
      started. */
  onpinchstart?: () => void;
}

const distance = (t: TouchList): number =>
  Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

/**
 * An attachment (`{@attach zoomGestures({...})}`) for the scrolling element.
 * The element needs `touch-action: pan-x pan-y` (or `none` on content that
 * handles its own drags) so the browser leaves the pinch to this handler.
 */
export function zoomGestures(opts: ZoomGestureOptions) {
  return (node: HTMLElement) => {
    // The touch pointers down on the element; a second one starts a pinch
    // and does not reach the content under it.
    const touches = new Set<number>();
    let pinch: { dist: number; zoom: number } | null = null;

    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      opts.set(opts.get() * wheelZoomFactor(e.deltaY, e.deltaMode));
    };
    const pointerDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      if (touches.size > 0) {
        opts.onpinchstart?.();
        e.stopPropagation();
      }
      touches.add(e.pointerId);
    };
    const pointerGone = (e: PointerEvent) => touches.delete(e.pointerId);
    const touchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      pinch = { dist: distance(e.touches), zoom: opts.get() };
    };
    const touchMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const dist = distance(e.touches);
      if (pinch.dist > 0) opts.set((pinch.zoom * dist) / pinch.dist);
    };
    const touchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    // Safari's trackpad pinch: `scale` is relative to the gesture's start.
    // Safari on iOS also sends these for a touch pinch, which the touch
    // handlers already cover, so they act only when no touch pinch is on.
    let gestureZoom = 0;
    const gestureStart = (e: Event) => {
      e.preventDefault();
      gestureZoom = opts.get();
    };
    const gestureChange = (e: Event) => {
      e.preventDefault();
      const scale = (e as Event & { scale?: number }).scale;
      if (!pinch && gestureZoom > 0 && scale) opts.set(gestureZoom * scale);
    };

    node.addEventListener("wheel", wheel, { passive: false });
    node.addEventListener("pointerdown", pointerDown, { capture: true });
    window.addEventListener("pointerup", pointerGone);
    window.addEventListener("pointercancel", pointerGone);
    node.addEventListener("touchstart", touchStart, { passive: true });
    node.addEventListener("touchmove", touchMove, { passive: false });
    node.addEventListener("touchend", touchEnd);
    node.addEventListener("touchcancel", touchEnd);
    node.addEventListener("gesturestart", gestureStart);
    node.addEventListener("gesturechange", gestureChange);
    return () => {
      node.removeEventListener("wheel", wheel);
      node.removeEventListener("pointerdown", pointerDown, { capture: true });
      window.removeEventListener("pointerup", pointerGone);
      window.removeEventListener("pointercancel", pointerGone);
      node.removeEventListener("touchstart", touchStart);
      node.removeEventListener("touchmove", touchMove);
      node.removeEventListener("touchend", touchEnd);
      node.removeEventListener("touchcancel", touchEnd);
      node.removeEventListener("gesturestart", gestureStart);
      node.removeEventListener("gesturechange", gestureChange);
    };
  };
}
