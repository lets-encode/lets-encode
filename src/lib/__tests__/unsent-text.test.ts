import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { keepUnsent, reloadKeepingUnsent, takeUnsent } from "../unsent-text.ts";

let reloads = 0;
beforeEach(() => {
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    },
  });
  reloads = 0;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { reload: () => void reloads++ },
  });
});

test("unsent text comes back once, for the account it was typed under", () => {
  const stop = keepUnsent("comment:7/T0001", () => ({ text: "half a note" }));
  reloadKeepingUnsent("ada");
  stop();
  assert.equal(reloads, 1);
  assert.equal(takeUnsent("comment:7/T0001", "grace"), null);
  assert.deepEqual(takeUnsent("comment:7/T0001", "ada"), {
    text: "half a note",
  });
  assert.equal(takeUnsent("comment:7/T0001", "ada"), null);
});

test("nothing is kept for a form with nothing typed or without an account", () => {
  const stopEmpty = keepUnsent("comment:7/T0002", () => null);
  const stopTyped = keepUnsent("comment:7/T0003", () => ({ text: "kept" }));
  reloadKeepingUnsent(null);
  stopEmpty();
  stopTyped();
  assert.equal(takeUnsent("comment:7/T0002", "ada"), null);
  assert.equal(takeUnsent("comment:7/T0003", "ada"), null);
});
