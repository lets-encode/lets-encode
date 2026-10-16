import { test } from "node:test";
import assert from "node:assert/strict";

import { startAutoRefresh, type RefreshEnv } from "../auto-refresh.ts";
import { RateLimitError } from "../forge/github-rest.ts";

// A manual clock: timers fire only when advance() passes their due time.
function fakeEnv() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let visibility: (() => void) | null = null;
  const env = {
    hidden: false,
    pointer: false,
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(nextId, { at: now + ms, fn });
      return nextId++;
    },
    clearTimeout: (id: unknown) => void timers.delete(id as number),
    watchVisibility: (fn: () => void) => {
      visibility = fn;
      return () => (visibility = null);
    },
  };
  const surface: RefreshEnv = {
    ...env,
    hidden: () => env.hidden,
    pointerDown: () => env.pointer,
  };
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    env,
    surface,
    pending: () => timers.size,
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = until;
    },
    async setHidden(hidden: boolean) {
      env.hidden = hidden;
      visibility?.();
      await flush();
    },
  };
}

const rateLimit = (resetAt: number | null) =>
  new RateLimitError({
    source: "github",
    anonymous: false,
    resource: "core",
    limit: 5000,
    remaining: 0,
    used: 5000,
    resetAt,
    retryAfterSeconds: null,
  });

test("polls once per interval while visible", async () => {
  const clock = fakeEnv();
  const polls: boolean[] = [];
  startAutoRefresh(
    { interval: () => 10_000, poll: async (r) => void polls.push(r) },
    clock.surface,
  );
  await clock.advance(9_999);
  assert.equal(polls.length, 0);
  await clock.advance(1);
  await clock.advance(10_000);
  assert.deepEqual(polls, [false, false]);
});

test("a slow poll delays the next one instead of overlapping it", async () => {
  const clock = fakeEnv();
  let active = 0;
  let maxActive = 0;
  let release: () => void = () => {};
  startAutoRefresh(
    {
      interval: () => 10_000,
      poll: () => {
        maxActive = Math.max(maxActive, ++active);
        return new Promise<void>((r) => (release = r)).then(() => {
          active--;
        });
      },
    },
    clock.surface,
  );
  await clock.advance(10_000);
  await clock.setHidden(true);
  await clock.setHidden(false);
  await clock.advance(30_000);
  release();
  await clock.advance(0);
  assert.equal(maxActive, 1);
});

test("stops while hidden and polls once on becoming visible", async () => {
  const clock = fakeEnv();
  const polls: boolean[] = [];
  startAutoRefresh(
    { interval: () => 10_000, poll: async (r) => void polls.push(r) },
    clock.surface,
  );
  await clock.setHidden(true);
  await clock.advance(60_000);
  assert.deepEqual(polls, []);
  await clock.setHidden(false);
  assert.deepEqual(polls, [true]);
  await clock.advance(10_000);
  assert.deepEqual(polls, [true, false]);
});

test("a null interval polls only on becoming visible", async () => {
  const clock = fakeEnv();
  const polls: boolean[] = [];
  startAutoRefresh(
    { interval: () => null, poll: async (r) => void polls.push(r) },
    clock.surface,
  );
  await clock.advance(3_600_000);
  assert.deepEqual(polls, []);
  await clock.setHidden(true);
  await clock.setHidden(false);
  assert.deepEqual(polls, [true]);
  assert.equal(clock.pending(), 0);
});

test("a held poll waits and keeps its resumed flag", async () => {
  const clock = fakeEnv();
  const polls: boolean[] = [];
  let held = true;
  startAutoRefresh(
    {
      interval: () => null,
      held: () => held,
      poll: async (r) => void polls.push(r),
    },
    clock.surface,
  );
  await clock.setHidden(true);
  await clock.setHidden(false);
  await clock.advance(5_000);
  assert.deepEqual(polls, []);
  held = false;
  await clock.advance(1_000);
  assert.deepEqual(polls, [true]);
});

test("a held pointer delays the poll until it is released", async () => {
  const clock = fakeEnv();
  let polls = 0;
  startAutoRefresh(
    { interval: () => 10_000, poll: async () => void polls++ },
    clock.surface,
  );
  clock.env.pointer = true;
  await clock.advance(15_000);
  assert.equal(polls, 0);
  clock.env.pointer = false;
  await clock.advance(1_000);
  assert.equal(polls, 1);
});

test("a rate-limit error pauses polling until the reset time", async () => {
  const clock = fakeEnv();
  let polls = 0;
  startAutoRefresh(
    {
      interval: () => 10_000,
      poll: async () => {
        if (++polls === 1) throw rateLimit(120);
      },
    },
    clock.surface,
  );
  await clock.advance(10_000);
  assert.equal(polls, 1);
  await clock.setHidden(true);
  await clock.setHidden(false);
  await clock.advance(100_000);
  assert.equal(polls, 1);
  await clock.advance(10_000);
  assert.equal(polls, 2);
});

test("other poll errors keep polling", async () => {
  const clock = fakeEnv();
  let polls = 0;
  const warn = console.warn;
  console.warn = () => {};
  try {
    startAutoRefresh(
      {
        interval: () => 10_000,
        poll: async () => {
          polls++;
          throw new Error("offline");
        },
      },
      clock.surface,
    );
    await clock.advance(20_000);
  } finally {
    console.warn = warn;
  }
  assert.equal(polls, 2);
});

test("the returned function stops polling", async () => {
  const clock = fakeEnv();
  let polls = 0;
  const stop = startAutoRefresh(
    { interval: () => 10_000, poll: async () => void polls++ },
    clock.surface,
  );
  stop();
  await clock.setHidden(true);
  await clock.setHidden(false);
  await clock.advance(60_000);
  assert.equal(polls, 0);
  assert.equal(clock.pending(), 0);
});
