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
const setupNode = readFileSync(
  new URL("../../../.github/actions/setup-node/action.yml", import.meta.url),
  "utf8",
);
const callerUrl =
  "https://raw.githubusercontent.com/lets-encode/campaign-template/main/.github/workflows/caller.yml";
const response = await fetch(callerUrl);
assert.ok(response.ok, `fetching ${callerUrl}: ${response.status}`);
const caller = await response.text();
const files = {
  "campaign.yml": workflow,
  "action.yml": action,
  "setup-node/action.yml": setupNode,
};
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

// The central code is fetched by git (below), so neither file runs the
// checkout action, which could be pointed at the fork.
test("no step uses the checkout action", () => {
  for (const [name, text] of Object.entries(files))
    assert.doesNotMatch(text, /uses:\s*actions\/checkout/, name);
});

// An action from another repository is pinned to a full commit hash; a tag
// or branch can be moved to other code.
test("every action from another repository is pinned to a commit", () => {
  for (const [name, text] of Object.entries(files))
    for (const line of text.split("\n")) {
      const uses = /^\s*(?:- )?uses:\s*(\S+)/.exec(line)?.[1];
      if (!uses || uses.startsWith("./")) continue;
      assert.match(
        uses,
        /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/,
        `${name}: ${line}`,
      );
    }
});

// The runner downloads an action from another repository when it prepares
// the composite action that names it, also for a skipped step, and downloads
// the actions named by a local composite action only when its step runs.
// setup-node therefore sits in a local action of its own, used only when the
// runner has no suitable Node.
test("actions/setup-node is downloaded only when no suitable Node is found", () => {
  assert.doesNotMatch(action, /uses:\s*actions\//);
  const setup = steps().find((s) =>
    s.some((l) =>
      /uses:\s*\.\/central\/\.github\/actions\/setup-node\s*$/.test(l),
    ),
  );
  assert.ok(setup, "the coordinator action does not use the setup-node action");
  assert.ok(
    setup!.some((l) =>
      /^\s*if: steps\.node\.outputs\.found != 'true'\s*$/.test(l),
    ),
    "the setup-node step has no condition on the Node step",
  );
  assert.match(setupNode, /^\s*using: composite\s*$/m);
  assert.match(setupNode, /uses: actions\/setup-node@[0-9a-f]{40} /);
  assert.match(action, /node-version-file: central\/\.nvmrc/);
});

// The central code is fetched by git in a run step. The step gets the pointer
// and nothing else: no token and no value of the pull request.
test("the central fetch takes only the central pointer", () => {
  const fetch = steps().find((s) =>
    s.some((l) => /git -C central fetch/.test(l)),
  );
  assert.ok(fetch, "no step fetches the central code");
  const env = fetch!.filter((_, i) => isInEnv(fetch!, i)).map((l) => l.trim());
  assert.deepEqual(env, [
    "CENTRAL_REPO: ${{ steps.cfg.outputs.repo }}",
    "CENTRAL_REF: ${{ steps.cfg.outputs.ref }}",
  ]);
  const block = fetch!.join("\n");
  assert.doesNotMatch(
    block,
    /pull_request|head_(ref|sha|repo)|token|secrets\./i,
  );
  // The ref cannot be read as an option of git.
  assert.match(
    block,
    /git -C central fetch -q --depth=1 --no-tags --end-of-options "\$url" "\$1"/,
  );
  assert.match(block, /url="\$GITHUB_SERVER_URL\/\$CENTRAL_REPO"/);
  // No environment reaches the steps from outside their own env blocks.
  assert.doesNotMatch(workflow, /^ {0,4}env:/m);
  for (const text of Object.values(files))
    assert.doesNotMatch(text, /GITHUB_ENV/);
});

// The central pointer (repository, ref, entry point) is base-controlled data
// read from config.yaml. It reaches the fetch and the run step as quoted
// environment variables, never as an expansion inside a command line.
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
  assert.match(block, /\[\[ "\$ref" == -\* \]\]/);
  // The entry point is checked by the action, from the same checkout.
  assert.match(action, /"\$CENTRAL_PATH" != "scripts\/coordinator\.ts"/);
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
  assert.match(guard, /pull_request\.changed_files <= 50/);
  assert.match(guard, /pull_request\.draft == false/);
  assert.match(guard, /pull_request\.user\.type == 'User'/);
  // The app names the same requirements when a run was skipped.
  assert.match(RUN_REQUIREMENTS, /file limit/);
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
