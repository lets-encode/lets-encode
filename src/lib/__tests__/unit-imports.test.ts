import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The editor units: files that are given a document and report a changed
// one, and import nothing of campaigns, tasks, GitHub or the login.
const LIB = new URL("..", import.meta.url).pathname;
const UNITS = [
  "editor-units.ts",
  "components/ScorePreview.svelte",
  "align",
  "components/align",
  "zones",
  "components/zones",
  "box-editor.svelte.ts",
  "components/BoxHandles.svelte",
  "components/BoxModeToggles.svelte",
];
const PLATFORM =
  /\/(commands|forge|auth\.svelte|pre-task-session\.svelte|campaign-[\w.-]+|command-runner\.svelte)(\.ts|\/|")/;

const files = (path: string): string[] =>
  statSync(path).isDirectory()
    ? readdirSync(path).flatMap((name) => files(join(path, name)))
    : [path];

test("the editor units import no platform code", () => {
  const found = UNITS.flatMap((unit) => files(join(LIB, unit))).flatMap(
    (file) =>
      [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)]
        .map((m) => m[1])
        .filter((source) => PLATFORM.test(`${source}"`))
        .map((source) => `${file.slice(LIB.length)} imports ${source}`),
  );
  assert.deepEqual(found, []);
});
