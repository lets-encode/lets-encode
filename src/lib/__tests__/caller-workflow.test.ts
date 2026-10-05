import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RUN_REQUIREMENTS } from "../commands.ts";

// The campaign repos' workflow runs on pull_request_target with a write token,
// so its safety rests on never executing anything from the fork: the PR head
// may be passed to the coordinator as data (env), but no step may check it out
// or expand it into a command. These checks pin that invariant, which the
// workflow otherwise states only in comments. The steps live in this repo's
// campaign.yml and the coordinator action it uses from the central checkout;
// each campaign's caller.yml carries only the triggers and is
// read from the template repository on GitHub, so the test does not depend on
// a local checkout of the template.
const workflow = readFileSync(
  new URL("../../../.github/workflows/campaign.yml", import.meta.url),
  "utf8",
);
const action = readFileSync(
  new URL("../../../.github/actions/coordinator/action.yml", import.meta.url),
  "utf8",
);
const callerUrl =
  "https://raw.githubusercontent.com/lets-encode/campaign-template/main/.github/workflows/caller.yml";
const response = await fetch(callerUrl);
assert.ok(response.ok, `fetching ${callerUrl}: ${response.status}`);
const caller = await response.text();
const files = { "campaign.yml": workflow, "action.yml": action };
const indentOf = (line: string) => line.length - line.trimStart().length;

// Lines inside an `env:` mapping (of any step), where PR head values may appear.
function isInEnv(lines: string[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (indentOf(line) >= indentOf(lines[index])) continue;
    return /^\s*env:\s*$/.test(line);
  }
  return false;
}

// Each step's lines in both files, split at the list items under `steps:`.
function steps(): string[][] {
  const out: string[][] = [];
  for (const text of Object.values(files)) {
    let current: string[] | null = null;
    for (const line of text.split("\n")) {
      if (/^\s+- name:/.test(line)) {
        current = [line];
        out.push(current);
      } else if (current) current.push(line);
    }
  }
  return out;
}

test("caller.yml runs on pull_request_target, so the invariant applies", () => {
  assert.match(caller, /^\s*pull_request_target:/m);
});

test("the PR head is passed to the coordinator only as env data", () => {
  const offenders = Object.entries(files).flatMap(([name, text]) => {
    const lines = text.split("\n");
    return lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) =>
        /pull_request\.head|github\.head_ref|github\.event\.pull_request\.head/.test(
          line,
        ),
      )
      .filter(({ i }) => !isInEnv(lines, i))
      .map(({ line, i }) => `${name}:${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(offenders, []);
});

test("no step checks out the fork", () => {
  for (const step of steps()) {
    if (!step.some((l) => /uses:\s*actions\/checkout/.test(l))) continue;
    const withBlock = step
      .filter((l) => /^\s*(ref|repository|token):/.test(l))
      .join("\n");
    assert.doesNotMatch(
      withBlock,
      /head|pull_request|fork/,
      `checkout reads the fork:\n${step.join("\n")}`,
    );
  }
});

// The central pointer (repository, ref, entry point) is base-controlled data
// read from config.yaml. It reaches the checkout as action inputs and the run
// step as a quoted environment variable, never as an expansion inside a
// command line.
test("run steps do not expand PR head values or the central pointer into commands", () => {
  const expansions: Array<[RegExp, string]> = [
    [/\$\{\{[^}]*head\.(sha|ref|repo)/, "the PR head"],
    [/\$\{\{[^}]*steps\.cfg\.outputs/, "the central pointer"],
    [/\$\{\{[^}]*inputs\./, "the central pointer"],
  ];
  for (const step of steps()) {
    const runStart = step.findIndex((l) => /^\s*run:/.test(l));
    if (runStart < 0) continue;
    const runBlock = step.slice(runStart).join("\n");
    for (const [pattern, label] of expansions) {
      assert.doesNotMatch(
        runBlock,
        pattern,
        `a run step expands ${label}:\n${runBlock}`,
      );
    }
  }
});

test("the cfg step validates the pointer fields before exporting them", () => {
  const cfg = steps().find((s) => s.some((l) => /^\s*id:\s*cfg\s*$/.test(l)));
  assert.ok(cfg, "no step with id cfg");
  const block = cfg!.join("\n");
  assert.match(
    block,
    /\[\[ "\$repo" =~ \^\[A-Za-z0-9_.-\]\+\/\[A-Za-z0-9_.-\]\+\$ \]\]/,
  );
  assert.match(block, /"\$path" != "scripts\/coordinator\.ts"/);
});

// Each pull request queues its own runs; runs for different pull requests
// never wait on or cancel each other.
test("pull request runs get a concurrency group of their own", () => {
  const concurrency = /^\s*concurrency:\n((?:[ ]+.*\n)+)/m.exec(workflow);
  assert.ok(concurrency, "no concurrency block");
  assert.match(concurrency![1], /github\.event\.pull_request\.number/);
});

test("pull request runs are gated on the event payload before a runner is assigned", () => {
  const job = /^  run:\n((?:[ ]{4}.*\n)+?)[ ]{4}steps:/m.exec(workflow);
  assert.ok(job, "no run job");
  const guard = job![1].split("\n").find((l) => /^[ ]{4}if:/.test(l)) ?? "";
  assert.match(guard, /pull_request\.changed_files <= 3/);
  assert.match(guard, /pull_request\.draft == false/);
  assert.match(guard, /pull_request\.user\.type == 'User'/);
  // The console names the same requirements when a run was skipped.
  assert.match(RUN_REQUIREMENTS, /three files/);
  assert.match(RUN_REQUIREMENTS, /draft/);
  assert.match(RUN_REQUIREMENTS, /user account/);
});

// The coordinator step comes from the central checkout at automation.ref, so
// its steps follow the campaign's instance branch rather than caller.yml's ref.
test("the coordinator action is used from the central checkout", () => {
  assert.match(
    workflow,
    /uses:\s*\.\/central\/\.github\/actions\/coordinator\s*$/m,
  );
  assert.match(action, /node "central\/\$CENTRAL_PATH"/);
});
