import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Runs scripts/coordinator.ts for PR #5 on o/r in a child process, against
// the GitHub of coordinator-fetch-mock.ts.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MOCK = new URL("./coordinator-fetch-mock.ts", import.meta.url).href;

function runCoordinator(scenario: Record<string, boolean | string> = {}): {
  status: number | null;
  mock: string[];
  /** The endpoints of the run's `[github-api-requests]` log. */
  logged: string[];
  stderr: string;
} {
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", MOCK, "scripts/coordinator.ts"],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        GH_TOKEN: "token",
        BASE_REPO: "o/r",
        EVENT_NAME: "pull_request_target",
        PR_NUMBER: "5",
        PR_AUTHOR: "42",
        PR_AUTHOR_LOGIN: "bob",
        HEAD_REPO: "bob/r",
        HEAD_SHA: "head5",
        HEAD_REF: scenario.kind === "encoding" ? "encode-T0001" : "claim-T0001",
        MOCK_SCENARIO: JSON.stringify(scenario),
      },
    },
  );
  const log = /\[github-api-requests\] (.*)/.exec(run.stdout);
  return {
    status: run.status,
    logged: log
      ? (JSON.parse(log[1]) as unknown[][]).map((r) => `${r[2]} ${r[4]}`)
      : [],
    mock: run.stdout
      .split("\n")
      .filter((line) => line.startsWith("[mock] "))
      .map((line) => line.slice("[mock] ".length)),
    stderr: run.stderr,
  };
}

const started = (mock: string[], prefix: string) =>
  mock.filter((line) => line.startsWith(`start ${prefix}`));

// The commits of a run: mutations by expected head, REST trees and commits.
const commits = (mock: string[]) =>
  mock.filter((line) => /^(mutation|tree|commit) /.test(line));

test("a claim reads the head and its tables in one query, started with the pull request read, and commits on that head in one mutation", () => {
  const { status, mock, logged } = runCoordinator();
  assert.equal(status, 0);
  assert.deepEqual(started(mock, "POST /graphql").length, 2);
  assert.deepEqual(started(mock, "GET /repos/o/r/contents"), []);
  assert.deepEqual(started(mock, "GET /repos/o/r/branches"), []);
  assert.ok(
    mock.indexOf("start POST /graphql") <
      mock.indexOf("end GET /repos/o/r/pulls/5"),
  );
  assert.deepEqual(commits(mock), ["mutation h1"]);
  assert.deepEqual(started(mock, "POST /repos/o/r/git"), []);
  assert.deepEqual(started(mock, "PATCH /repos/o/r/git"), []);
  // Reads of the tables and the pull request, the mutation, comment and close.
  assert.equal(logged.length, 7);
  assert.ok(mock.includes("end PATCH /repos/o/r/pulls/5"));
  assert.deepEqual(
    mock.filter((line) => line.startsWith("unexpected")),
    [],
  );
});

test("a claim whose commit lost the race reads the tables again and commits on the new head", () => {
  const { status, mock } = runCoordinator({ movedOnce: true });
  assert.equal(status, 0);
  assert.equal(started(mock, "POST /graphql").length, 4);
  // The list of open pull requests is read once.
  assert.equal(
    mock.filter((line) => line === "start GET /repos/o/r/pulls").length,
    1,
  );
  assert.deepEqual(commits(mock), ["mutation h1", "mutation h2"]);
});

test("a refused mutation commits through the Git Data API with a warning", () => {
  const { status, mock, stderr } = runCoordinator({ mutationRefused: true });
  assert.equal(status, 0);
  assert.deepEqual(commits(mock), ["mutation h1", "tree t1", "commit h1"]);
  assert.match(
    stderr,
    /The one-request commit failed; committing through the Git Data API: FORBIDDEN: Resource not accessible by integration/,
  );
  assert.ok(mock.includes("end PATCH /repos/o/r/pulls/5"));
});

test("a refused mutation that lost the race reads the tables again", () => {
  const { status, mock } = runCoordinator({
    mutationRefused: true,
    movedOnce: true,
  });
  assert.equal(status, 0);
  assert.deepEqual(commits(mock), [
    "mutation h1",
    "tree t1",
    "commit h1",
    "mutation h2",
    "tree t2",
    "commit h2",
  ]);
});

for (const [answer, scenario] of [
  ["was lost", { mutationLost: true }],
  ["was empty", { mutationEmpty: true }],
] as const)
  test(`a mutation whose answer ${answer} after it committed is not committed again, and the committed decision is posted`, () => {
    const { status, mock } = runCoordinator(scenario);
    assert.equal(status, 0);
    assert.deepEqual(commits(mock), ["mutation h1"]);
    assert.equal(started(mock, "POST /graphql").length, 3);
    const comments = mock.filter((line) => line.startsWith("comment "));
    assert.equal(comments.length, 1);
    assert.match(comments[0], /Claim accepted/);
    assert.ok(mock.includes("end PATCH /repos/o/r/pulls/5"));
  });

test("a claim whose every commit finds main moved is closed as not recorded", () => {
  const { status, mock } = runCoordinator({ movedAlways: true });
  assert.equal(status, 0);
  assert.equal(commits(mock).length, 10);
  assert.deepEqual(
    mock.filter((line) => line.startsWith("comment ")),
    [mock.find((line) => line.startsWith("comment ❌ Not recorded"))],
  );
  assert.ok(mock.includes("end PATCH /repos/o/r/pulls/5"));
});

test("a GraphQL error leaves the table read to REST at the head it reads", () => {
  const { status, mock } = runCoordinator({ graphqlError: true });
  assert.equal(status, 0);
  assert.equal(started(mock, "GET /repos/o/r/branches/main").length, 1);
  assert.equal(started(mock, "GET /repos/o/r/contents").length, 6);
  assert.deepEqual(commits(mock), ["mutation rest1"]);
});

test("a failed pull request read fails the run while the table read fails after it", () => {
  const { status, mock, stderr } = runCoordinator({
    prMissing: true,
    tablesFail: true,
  });
  assert.equal(status, 1);
  assert.match(stderr, /Not Found \(404 GET \/repos\/o\/r\/pulls\/5\)/);
  // The table read's rejection is handled, not reported as unhandled.
  assert.ok(mock.includes("end GET /repos/o/r"));
  assert.doesNotMatch(stderr, /Repo gone/);
  assert.equal(started(mock, "POST /repos/o/r/git").length, 0);
});

test("a closed pull request is left as is although the table read failed", () => {
  const { status, mock, stderr } = runCoordinator({
    prClosed: true,
    tablesFail: true,
  });
  assert.equal(status, 0);
  assert.doesNotMatch(stderr, /Repo gone/);
  assert.equal(started(mock, "POST /repos/o/r/issues").length, 0);
});

test("a failed table read fails the run as the decision's error", () => {
  const { status, stderr } = runCoordinator({ tablesFail: true });
  assert.equal(status, 1);
  assert.match(stderr, /Repo gone \(404 GET repo\)/);
});

test("the table read of a pull request left alone is in the run's request log", () => {
  const { status, logged } = runCoordinator({
    prClosed: true,
    slowGraphql: true,
  });
  assert.equal(status, 0);
  assert.ok(logged.includes("POST /graphql"));
});

test("a review verdict takes config and comments from the table read", () => {
  const { status, mock } = runCoordinator({ kind: "validation" });
  assert.equal(status, 0);
  assert.equal(started(mock, "POST /graphql").length, 2);
  assert.deepEqual(started(mock, "GET /repos/o/r/contents"), []);
  assert.deepEqual(commits(mock), ["mutation h1"]);
});

test("an encoding of a page task takes config from the table read", () => {
  const { status, mock } = runCoordinator({ kind: "encoding" });
  assert.equal(status, 0);
  assert.deepEqual(started(mock, "GET /repos/o/r/contents"), [
    "start GET /repos/o/r/contents/sources/score.mei",
  ]);
  assert.ok(mock.includes("start GET /repos/bob/r/contents/sources/score.mei"));
  assert.deepEqual(
    mock.filter((line) => line.startsWith("unexpected")),
    [],
  );
});
