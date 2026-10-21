// Background polling for pages that show the campaign tables. Polls run one at
// a time, stop while the tab is hidden and run once when it becomes visible
// again. A due poll waits while the page is held (a command running, an open
// editor) or a pointer button is down (a drag or a pan). A rate-limit error
// stops polling until the limit resets. Each poll's outcome is reported
// through `onStatus`, for the page to show.

import { RateLimitError } from "./forge/github-rest.ts";

/** Delay before a held poll is tried again. */
const HELD_RETRY_MS = 1000;
/** Pause after a rate-limit error that reports no reset time. */
const RATE_LIMIT_FALLBACK_MS = 60_000;

export interface AutoRefreshOptions {
  /** Milliseconds between polls while the tab is visible; null polls only when the tab becomes visible. */
  interval: () => number | null;
  /** One poll; `resumed` is true when it runs because the tab became visible. */
  poll: (resumed: boolean) => Promise<void>;
  /** While true, a due poll waits. */
  held?: () => boolean;
  /** Called with the status after every poll. */
  onStatus?: (status: RefreshStatus) => void;
}

/** Where polling stands after its latest poll. */
export interface RefreshStatus {
  /** Epoch milliseconds polling waits until after a rate limit; null when it does not wait. */
  pausedUntil: number | null;
  /** Whose limit paused polling: GitHub's for logged-out requests, GitHub's for the account, or the broker's. */
  limit: "anonymous" | "account" | "broker" | null;
  /** Epoch milliseconds of the first of the failed polls in a row; null after a success. */
  failingSince: number | null;
  /** Failed polls in a row, rate limits not counted. */
  failures: number;
}

/** The status before any poll, and after a successful one. */
export const REFRESH_OK: RefreshStatus = {
  pausedUntil: null,
  limit: null,
  failingSince: null,
  failures: 0,
};

/** The browser surface the scheduler uses. */
export interface RefreshEnv {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  hidden(): boolean;
  pointerDown(): boolean;
  /** Calls `fn` on every visibility change; returns the unsubscribe. */
  watchVisibility(fn: () => void): () => void;
}

let pointerHeld = false;
let trackingPointer = false;

function trackPointer(): void {
  if (trackingPointer) return;
  trackingPointer = true;
  const down = () => (pointerHeld = true);
  const up = () => (pointerHeld = false);
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  window.addEventListener("blur", up);
}

export function browserEnv(): RefreshEnv {
  trackPointer();
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    hidden: () => document.visibilityState === "hidden",
    pointerDown: () => pointerHeld,
    watchVisibility(fn) {
      document.addEventListener("visibilitychange", fn);
      return () => document.removeEventListener("visibilitychange", fn);
    },
  };
}

/** The time polling may resume after `err`, in epoch milliseconds. */
function resumeAt(err: RateLimitError, now: number): number {
  if (err.retryAfterSeconds) return now + err.retryAfterSeconds * 1000;
  if (err.resetAt) return Math.max(now, err.resetAt * 1000);
  return now + RATE_LIMIT_FALLBACK_MS;
}

/** Start polling; returns the function that stops it. */
export function startAutoRefresh(
  opts: AutoRefreshOptions,
  env: RefreshEnv = browserEnv(),
): () => void {
  let timer: unknown = null;
  let running = false;
  let stopped = false;
  let pausedUntil = 0;
  let status = REFRESH_OK;
  // Ends the reported pause on time, also while polls are held.
  let pauseTimer: unknown = null;

  const clear = () => {
    if (timer !== null) env.clearTimeout(timer);
    timer = null;
  };

  const schedule = (delay?: number, resumed = false) => {
    clear();
    if (stopped || env.hidden()) return;
    const interval = delay ?? opts.interval();
    if (interval === null) return;
    timer = env.setTimeout(
      () => void tick(resumed),
      Math.max(interval, pausedUntil - env.now()),
    );
  };

  async function tick(resumed: boolean): Promise<void> {
    clear();
    if (stopped || env.hidden() || running) return;
    if (env.now() < pausedUntil) return schedule();
    if (opts.held?.() || env.pointerDown())
      return schedule(HELD_RETRY_MS, resumed);
    running = true;
    try {
      await opts.poll(resumed);
      status = REFRESH_OK;
    } catch (err) {
      if (err instanceof RateLimitError) {
        pausedUntil = resumeAt(err, env.now());
        status = {
          ...status,
          pausedUntil,
          limit:
            err.source === "broker"
              ? "broker"
              : err.anonymous
                ? "anonymous"
                : "account",
        };
        if (pauseTimer !== null) env.clearTimeout(pauseTimer);
        pauseTimer = env.setTimeout(() => {
          pauseTimer = null;
          if (stopped || status.pausedUntil === null) return;
          status = { ...status, pausedUntil: null, limit: null };
          opts.onStatus?.(status);
        }, pausedUntil - env.now());
      } else {
        console.warn("[auto-refresh] poll failed:", (err as Error).message);
        status = {
          pausedUntil: null,
          limit: null,
          failingSince: status.failingSince ?? env.now(),
          failures: status.failures + 1,
        };
      }
    } finally {
      running = false;
      if (!stopped) opts.onStatus?.(status);
      schedule();
    }
  }

  const unwatch = env.watchVisibility(() => {
    if (env.hidden()) clear();
    else void tick(true);
  });
  schedule();
  return () => {
    stopped = true;
    clear();
    if (pauseTimer !== null) env.clearTimeout(pauseTimer);
    unwatch();
  };
}
