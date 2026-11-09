import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

import {
  commands,
  commentInput,
  invoke,
  resumeFollowing,
  setVerdictSink,
  type CommandContext,
} from "../commands.ts";
import { envelopeFromPrBody } from "../command-envelope.ts";
import { contractMarker } from "../coordinator-policy.ts";
import {
  buildFacsimileMei,
  initialFacsimileModel,
  parseFacsimileMei,
} from "../mei-facsimile.ts";
import { buildPieceHead, emptySourceMetadata } from "../source-metadata.ts";
import {
  HISTORY_COLUMNS,
  HISTORY_PATH,
  serializeTaskCsv,
  TASK_PATH,
} from "../campaign-tables.ts";
import type { ForgeClient, OpenedChangeRequest } from "../forge/types.ts";
import { fakeForge, type ForgeOverrides } from "./fake-forge.ts";

// A coordinator verdict comment as the coordinator posts it: with the contract
// line at its end.
const bot = (text: string): string => `${text}\n\n${contractMarker()}`;

function context(forge: ForgeClient): CommandContext {
  // viewer is the acting user's numeric id (written to the tables); viewerLogin
  // is their login (human-readable PR prose only).
  return {
    forge,
    repoId: 555,
    owner: "campaign-owner",
    repo: "campaign",
    viewer: "9001",
    viewerLogin: "volunteer",
    meiFriendUrl: "https://mei-friend.example",
    omr: {
      layoutModel: { name: "layout", version: "1" },
      staffPipeline: { name: "staff", version: "1" },
    },
    progress: () => {},
  };
}

async function withImmediateTimeouts<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
    queueMicrotask(callback);
    return 0;
  }) as typeof setTimeout;
  try {
    return await run();
  } finally {
    globalThis.setTimeout = original;
  }
}

const lockHeader = "task_id,subtask_id,user_id,timestamp,kind,expires\n";
// What an encoding submission reads before opening its PR: the task table for
// the fragment path, and the fragment itself from the encode branch.
const encodingFiles: Record<string, string> = {
  "tracking/task.csv":
    "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\nT0001,,sources/score.mei,,,,\n",
  "sources/score.mei":
    '<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.1"/>',
};
// Take the schema download away, so the browser-side pre-check reports itself
// unavailable and the submission proceeds to the automation's check.
function offline(t: TestContext): void {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("offline");
  });
}

// Capture the background settlement of an optimistic PR command: the promise
// resolves when the command's verdict lands in the sink.
function captureVerdict(): Promise<{ state: string; message: string }> {
  return new Promise((resolve) => {
    setVerdictSink({
      begin: () => "test",
      attachPr: () => {},
      settle: (_id, state, message) => resolve({ state, message }),
      recorded: () => {},
    });
  });
}

// The forge a claim on P0001 reads and writes: an empty lock table and a PR
// opened from the volunteer's fork with the given number. `pr` fields are
// merged into the opened PR.
function claimForge(
  number: number,
  { pr, ...overrides }: ForgeOverrides & { pr?: Partial<OpenedChangeRequest> },
): ForgeClient {
  return fakeForge({
    getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
    getRepoHead: async () => ({
      sha: "head1",
      treeSha: "tree1",
      branch: "main",
      canPush: false,
    }),
    getRepoFile: async () => lockHeader,
    getPullRequestHeadRepo: async () => ({
      owner: "volunteer",
      repo: "campaign",
    }),
    openChangePr: async () => ({
      number,
      html_url: `https://example.test/pr/${number}`,
      head: {
        owner: "volunteer",
        repo: "campaign",
        branch: "claim-P0001-abcd",
      },
      ...pr,
    }),
    ...overrides,
  });
}

// The forge with history.csv recording the coordinator's acceptance of pull
// request `pr`, which is how a processed PR's decision is read.
function withDecision(
  forge: ForgeClient,
  pr: number,
  earlier = "",
): ForgeClient {
  const history =
    `${HISTORY_COLUMNS.join(",")}\n` +
    earlier +
    `2026-01-01T00:00:00Z,T0001,,9001,claim_encoding,accepted,,,,,${pr}\n`;
  return new Proxy(forge, {
    get(target, property) {
      if (property !== "getRepoFile")
        return target[property as keyof ForgeClient];
      return (owner: string, repo: string, path: string, ref?: string) =>
        path === HISTORY_PATH
          ? Promise.resolve(history)
          : target.getRepoFile(owner, repo, path, ref);
    },
  });
}

// Submit T0001 as a volunteer encoding from a fork, with the schema download
// unavailable, and wait for the background settlement of its PR; `decided`
// is the PR the coordinator accepts.
function runEncoding(
  t: TestContext,
  overrides: ForgeOverrides,
  decided?: number,
) {
  offline(t);
  const forge = fakeForge({
    getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
    getRepoHead: async () => ({
      branch: "main",
      sha: "base-sha",
      treeSha: "base-sha-tree",
      canPush: false,
    }),
    ensureFork: async () => ({ owner: "volunteer", repo: "campaign" }),
    getPullRequestHeadRepo: async () => ({
      owner: "volunteer",
      repo: "campaign",
    }),
    getRepoFile: async (_owner, _repo, path) => encodingFiles[path] ?? null,
    ...overrides,
  });
  const settled = captureVerdict();
  return withImmediateTimeouts(async () => {
    const result = await invoke(
      commands.submitEncoding,
      { task_id: "T0001" },
      context(decided ? withDecision(forge, decided) : forge),
    );
    return { result, verdict: await settled };
  });
}

test("a verdict from a coordinator on another contract is reported as an error, not as its verdict", async () => {
  for (const comment of [
    "✅ Claim accepted.",
    "✅ Claim accepted.\n\n<!-- lets-encode-contract: 999 -->",
  ]) {
    const forge = claimForge(31, {
      getPullRequestState: async () => "closed",
      getLastIssueComment: async () => comment,
      deleteBranch: async () => {},
    });

    const result = await withImmediateTimeouts(() =>
      invoke(
        commands.claimTask,
        { task_id: "P0001" },
        context(withDecision(forge, 31)),
      ),
    );

    assert.equal(result.ok, undefined);
    assert.match(result.error ?? "", /campaign automation of another version/);
  }
});

test("a repeat measure correction follows the viewer's open pull request instead of opening another", async (t) => {
  offline(t);
  const score = buildFacsimileMei({
    ...initialFacsimileModel([
      {
        image: "img/01.jpg",
        width: 400,
        height: 200,
        measures: [{ ulx: 0, uly: 10, lrx: 90, lry: 90 }],
      },
    ]),
    headXml: buildPieceHead(
      { title: "Lied", composer: "" },
      emptySourceMetadata(),
      { date: "2026-11-09" },
    ),
  });
  const files: Record<string, string> = {
    [TASK_PATH]:
      "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n" +
      "P0001,,sources/score.mei,measure-zones,,,\n",
    "sources/score.mei": score,
  };
  let opened = 0;
  const forge = fakeForge({
    getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
    getRepoFile: async (_owner, _repo, path) => files[path] ?? null,
    findOpenChangeRequest: async (_owner, _repo, userId, branchPrefix) =>
      userId === "9001" && branchPrefix === "zones-P0001-"
        ? {
            number: 41,
            html_url: "https://example.test/pr/41",
            head: {
              owner: "volunteer",
              repo: "campaign",
              branch: "zones-P0001-abcd",
            },
          }
        : null,
    openChangePr: async () => {
      opened++;
      throw new Error("a second pull request was opened");
    },
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => bot("✅ Submission accepted."),
    getRepoHead: async () => ({
      sha: "head1",
      treeSha: "tree1",
      branch: "main",
      canPush: false,
    }),
    getPullRequestHeadRepo: async () => ({
      owner: "volunteer",
      repo: "campaign",
    }),
    deleteBranch: async () => {},
  });
  const verdict = captureVerdict();

  const result = await withImmediateTimeouts(async () => {
    const res = await invoke(
      commands.submitZones,
      { task_id: "P0001", pages: parseFacsimileMei(score).pages },
      context(withDecision(forge, 41)),
    );
    await verdict;
    return res;
  });

  assert.equal(result.background, true);
  assert.equal(opened, 0);
});

test("readTables decodes generated quoted config values", async () => {
  const files: Record<string, string> = {
    "tracking/task.csv":
      "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\nT0001,,sources/score.mei,,,,\n",
    "tracking/state.csv":
      "task_id,subtask_id,status,encoder,encoded_at,validate_status_1,validate_status_2\nT0001,,encoding_required,,,,\n",
    "tracking/lock.csv": lockHeader,
    "tracking/history.csv":
      "timestamp,task_id,subtask_id,user_id,action,outcome,detail,command,command_version,command_input\n",
    "config.yaml":
      'campaign:\n  title: "A \\"quoted\\" \\\\ title\\nsecond line"\n  license: "CC-BY-4.0"\nvalidation:\n  pass_threshold: 2\n',
  };
  const forge = fakeForge({
    getRepoFile: async (_owner, _repo, path, ref) =>
      ref?.startsWith("wip-") ? null : (files[path] ?? null),
    getRepoAccess: async () => ({ isPrivate: true, canPush: false }),
  });

  const result = await invoke(commands.readTables, {}, context(forge));

  assert.equal(result.title, 'A "quoted" \\ title\nsecond line');
  assert.equal(result.license, "CC-BY-4.0");
  assert.equal(result.passThreshold, 2);
  assert.equal(result.isPrivate, true);
});

test("readTables without a batch read reads every table at the head it reports", async () => {
  const refs = new Set<string | undefined>();
  const forge = fakeForge({
    getRepoHead: async () => ({
      sha: "head7",
      treeSha: "tree7",
      branch: "main",
      canPush: false,
    }),
    getRepoFile: async (_owner, _repo, path, ref) => {
      refs.add(ref);
      return path === "tracking/lock.csv" ? lockHeader : null;
    },
    getRepoAccess: async () => ({ isPrivate: false, canPush: false }),
  });

  const result = await invoke(commands.readTables, {}, context(forge));

  assert.equal(result.headSha, "head7");
  assert.deepEqual([...refs], ["head7"]);
});

test("table reads started together share one batch read", async () => {
  const files: Record<string, string> = {
    "tracking/task.csv":
      "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\nT0001,,sources/score.mei,,,,\n",
    "tracking/state.csv":
      "task_id,subtask_id,status,encoder,encoded_at\nT0001,,encoding_required,,\n",
    "tracking/lock.csv": lockHeader,
  };
  let batches = 0;
  const forge = fakeForge({
    getRepoFilesBatch: async (_repos, paths) => {
      batches++;
      return [
        {
          headSha: "head1",
          isPrivate: false,
          canPush: true,
          files: Object.fromEntries(paths.map((p) => [p, files[p] ?? null])),
        },
      ];
    },
    getUserLogin: async () => null,
  });

  const [first, second] = await Promise.all([
    invoke(commands.readTables, {}, context(forge)),
    invoke(commands.readTables, {}, context(forge)),
  ]);

  assert.equal(batches, 1);
  assert.equal(first.headSha, "head1");
  assert.equal(first.canPush, true);
  assert.deepEqual(second.taskDefs, first.taskDefs);
  await invoke(commands.readTables, {}, context(forge));
  assert.equal(batches, 2);
});

test("submitValidation rejects an invalid verdict before opening a PR", async () => {
  const result = await invoke(
    commands.submitValidation,
    { task_id: "T0001", subtask_id: "S0001", verdict: "passing" },
    context(fakeForge({})),
  );

  assert.equal(result.error, "Invalid review verdict: passing.");
});

test("a headless claim carries its envelope and cleans its fork branch after acceptance", async () => {
  let openedBody = "";
  let deleted: string[] = [];
  const opened: OpenedChangeRequest = {
    number: 12,
    html_url: "https://example.test/pr/12",
    head: { owner: "volunteer", repo: "campaign", branch: "claim-P0001-abcd" },
  };
  const forge = fakeForge({
    getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
    getRepoHead: async () => ({
      sha: "head1",
      treeSha: "tree1",
      branch: "main",
      canPush: false,
    }),
    getRepoFile: async (_owner, _repo, path) =>
      path === "tracking/lock.csv" ? lockHeader : null,
    openChangePr: async (_owner, _repo, options) => {
      openedBody = options.body;
      return opened;
    },
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => bot("✅ Claim accepted."),
    deleteBranch: async (owner, repo, branch) => {
      deleted = [owner, repo, branch];
    },
  });

  const result = await withImmediateTimeouts(() =>
    invoke(
      commands.claimTask,
      { task_id: "P0001" },
      context(withDecision(forge, 12)),
    ),
  );
  const envelope = envelopeFromPrBody(openedBody);

  assert.equal(result.ok, true);
  assert.equal(envelope?.command, "campaign.claimTask");
  assert.equal(envelope?.user_id, "9001");
  assert.deepEqual(envelope?.input, { task_id: "P0001" });
  assert.deepEqual(deleted, ["volunteer", "campaign", "claim-P0001-abcd"]);
});

test("a failed automation run surfaces as an error while the PR stays open", async () => {
  let polls = 0;
  const forge = claimForge(21, {
    pr: { headSha: "abc123" },
    // Open while the run fails; closed by the scheduled run later on.
    getPullRequestState: async () => (polls++ < 1 ? "open" : "closed"),
    listWorkflowRuns: async (_owner, _repo, _workflow, filter) => {
      assert.equal(filter?.headSha, "abc123");
      return [
        {
          id: 7,
          status: "completed",
          conclusion: "failure",
          created_at: new Date().toISOString(),
          html_url: "https://example.test/run/7",
        },
      ];
    },
  });

  const followed = captureVerdict();

  const result = await withImmediateTimeouts(() =>
    invoke(commands.claimTask, { task_id: "P0001" }, context(forge)),
  );

  assert.match(result.error ?? "", /automation run for submission #21 failed/);
  assert.match(result.error ?? "", /example\.test\/run\/7/);
  // The PR stays open after the failed run and is followed until it closes.
  assert.match(result.error ?? "", /next scheduled run processes it/);
  assert.equal((await withImmediateTimeouts(() => followed)).state, "rejected");
});

test("one failed read of the run does not end the watching", async () => {
  let polls = 0;
  let reads = 0;
  const forge = claimForge(24, {
    pr: { headSha: "abc125" },
    getPullRequestState: async () => (polls++ < 2 ? "open" : "closed"),
    listWorkflowRuns: async () => {
      if (reads++ === 0) throw new Error("502");
      return [
        {
          id: 9,
          status: "completed",
          conclusion: "failure",
          created_at: new Date().toISOString(),
          html_url: "https://example.test/run/9",
        },
      ];
    },
  });
  const followed = captureVerdict();

  const result = await withImmediateTimeouts(() =>
    invoke(commands.claimTask, { task_id: "P0001" }, context(forge)),
  );

  assert.match(result.error ?? "", /automation run for submission #24 failed/);
  await withImmediateTimeouts(() => followed);
});

test("a run from before the PR was opened is not taken for its own", async () => {
  let polls = 0;
  const forge = claimForge(25, {
    pr: { headSha: "abc126" },
    getPullRequestState: async () => (polls++ < 2 ? "open" : "closed"),
    getLastIssueComment: async () => bot("✅ Claim accepted."),
    // An earlier pull request's failed run for the same commit.
    listWorkflowRuns: async () => [
      {
        id: 10,
        status: "completed",
        conclusion: "failure",
        created_at: new Date(Date.now() - 3_600_000).toISOString(),
        html_url: "https://example.test/run/10",
      },
    ],
  });

  const result = await withImmediateTimeouts(() =>
    invoke(
      commands.claimTask,
      { task_id: "P0001" },
      context(withDecision(forge, 25)),
    ),
  );

  assert.equal(result.error, undefined);
  assert.equal(result.ok, true);
});

test("the run is looked for from the PR's creation on GitHub, not the browser's time", async () => {
  let polls = 0;
  const minutesAgo = (n: number) =>
    new Date(Date.now() - n * 60_000).toISOString();
  const forge = claimForge(28, {
    // A follow resumed long after the PR was opened, or a browser clock ahead.
    pr: { headSha: "abc127", createdAt: minutesAgo(10) },
    getPullRequestState: async () => (polls++ < 2 ? "open" : "closed"),
    listWorkflowRuns: async () => [
      {
        id: 13,
        status: "completed",
        conclusion: "failure",
        created_at: minutesAgo(9),
        html_url: "https://example.test/run/13",
      },
    ],
  });
  const followed = captureVerdict();

  const result = await withImmediateTimeouts(() =>
    invoke(commands.claimTask, { task_id: "P0001" }, context(forge)),
  );

  assert.match(result.error ?? "", /example\.test\/run\/13/);
  await withImmediateTimeouts(() => followed);
});

test("a cancelled run is followed by the run for the PR's new head", async () => {
  let polls = 0;
  const forge = claimForge(26, {
    pr: { headSha: "old-head" },
    getPullRequestState: async () => (polls++ < 3 ? "open" : "closed"),
    getPullRequestHead: async () => "new-head",
    listWorkflowRuns: async (_owner, _repo, _workflow, filter) => [
      {
        id: filter?.headSha === "new-head" ? 12 : 11,
        status: "completed",
        conclusion: filter?.headSha === "new-head" ? "failure" : "cancelled",
        created_at: new Date().toISOString(),
        html_url: `https://example.test/run/${filter?.headSha}`,
      },
    ],
  });
  const followed = captureVerdict();

  const result = await withImmediateTimeouts(() =>
    invoke(commands.claimTask, { task_id: "P0001" }, context(forge)),
  );

  assert.match(result.error ?? "", /example\.test\/run\/new-head/);
  await withImmediateTimeouts(() => followed);
});

test("a decided PR stands when its comment cannot be read", async () => {
  const forge = claimForge(27, {
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => {
      throw new Error("502");
    },
  });

  const result = await withImmediateTimeouts(() =>
    invoke(
      commands.claimTask,
      { task_id: "P0001" },
      context(withDecision(forge, 27)),
    ),
  );

  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
});

test("a decision recorded before its run failed stands", async () => {
  const forge = claimForge(23, {
    pr: { headSha: "abc124" },
    getPullRequestState: async () => "open",
    listWorkflowRuns: async () => [
      {
        id: 8,
        status: "completed",
        conclusion: "failure",
        created_at: new Date().toISOString(),
        html_url: "https://example.test/run/8",
      },
    ],
  });

  const result = await withImmediateTimeouts(() =>
    invoke(
      commands.claimTask,
      { task_id: "P0001" },
      context(withDecision(forge, 23)),
    ),
  );

  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
});

test("a skipped automation run is explained and its PR closed by the console", async () => {
  let closed = 0;
  const forge = claimForge(22, {
    pr: { headSha: "def456" },
    getPullRequestState: async () => "open",
    listWorkflowRuns: async () => [
      {
        id: 8,
        status: "completed",
        conclusion: "skipped",
        created_at: new Date().toISOString(),
        html_url: "https://example.test/run/8",
      },
    ],
    closePullRequest: async (_owner, _repo, number, comment) => {
      assert.equal(number, 22);
      // The closed PR says why on GitHub too, as the app's, not a verdict.
      assert.match(comment ?? "", /^Not processed: .*at most 50 files/);
      closed++;
    },
  });

  const result = await withImmediateTimeouts(() =>
    invoke(commands.claimTask, { task_id: "P0001" }, context(forge)),
  );

  assert.match(
    result.error ?? "",
    /did not run for submission #22: a submission must change at most 50 files/,
  );
  assert.match(result.error ?? "", /was closed/);
  assert.equal(closed, 1);
});

test("an accepted PR whose record is read late counts as accepted", async () => {
  let historyReads = 0;
  const refs: (string | undefined)[] = [];
  const forge = claimForge(29, {
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => bot("✅ Claim accepted."),
  });
  const decided = withDecision(forge, 29);
  const lagging = new Proxy(decided, {
    get(target, property) {
      if (property !== "getRepoFile")
        return target[property as keyof ForgeClient];
      return (owner: string, repo: string, path: string, ref?: string) => {
        if (path !== HISTORY_PATH)
          return target.getRepoFile(owner, repo, path, ref);
        refs.push(ref);
        // The first two reads do not show the row yet.
        return historyReads++ < 2
          ? Promise.resolve(`${HISTORY_COLUMNS.join(",")}\n`)
          : target.getRepoFile(owner, repo, path, ref);
      };
    },
  });

  const result = await withImmediateTimeouts(() =>
    invoke(commands.claimTask, { task_id: "P0001" }, context(lagging)),
  );

  assert.equal(result.error, undefined);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, undefined);
  // History is read at the head, not at the default branch.
  assert.ok(refs.every((ref) => ref === "head1"));
});

test("an accepted PR without a readable record is still being processed, not rejected", async () => {
  const forge = claimForge(30, {
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => bot("✅ Claim accepted."),
  });
  const followed = captureVerdict();

  const result = await withImmediateTimeouts(() =>
    invoke(commands.claimTask, { task_id: "P0001" }, context(forge)),
  );

  assert.equal(result.error, undefined);
  assert.equal(result.outcome, "pending");
  assert.equal((await withImmediateTimeouts(() => followed)).state, "timeout");
});

test("a closed PR without a recorded decision fails closed", async () => {
  const forge = claimForge(13, {
    pr: {
      head: {
        owner: "campaign-owner",
        repo: "campaign",
        branch: "claim-P0001-abcd",
      },
    },
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => null,
  });

  const result = await withImmediateTimeouts(() =>
    invoke(commands.claimTask, { task_id: "P0001" }, context(forge)),
  );

  assert.equal(result.error, "Submission #13 was rejected.");
  assert.equal(result.outcome, undefined);
});

test("a volunteer encoding submission cleans the encode branch in their fork", async (t) => {
  let pullHead = "";
  let deleted: string[] = [];
  const { result, verdict } = await runEncoding(
    t,
    {
      createPullRequest: async (_owner, _repo, options) => {
        pullHead = options.head;
        return { number: 14, html_url: "https://example.test/pr/14" };
      },
      getPullRequestState: async () => "closed",
      getLastIssueComment: async () =>
        bot("✅ Submission accepted (encoding)."),
      deleteBranch: async (owner, repo, branch) => {
        deleted = [owner, repo, branch];
      },
    },
    14,
  );

  assert.equal(result.ok, true);
  assert.equal(pullHead, "volunteer:encode-T0001");
  assert.equal(verdict.state, "accepted");
  assert.deepEqual(deleted, ["volunteer", "campaign", "encode-T0001"]);
});

test("an encoding submission comes from the repo the claim came from, whatever the push access now", async (t) => {
  let pullHead = "";
  const { result } = await runEncoding(
    t,
    {
      // Made a collaborator after claiming from the fork.
      getRepoHead: async () => ({
        branch: "main",
        sha: "base-sha",
        treeSha: "base-sha-tree",
        canPush: true,
      }),
      createPullRequest: async (_owner, _repo, options) => {
        pullHead = options.head;
        return { number: 15, html_url: "https://example.test/pr/15" };
      },
      getPullRequestState: async () => "closed",
      getLastIssueComment: async () =>
        bot("✅ Submission accepted (encoding)."),
      deleteBranch: async () => {},
    },
    15,
  );

  assert.equal(result.ok, true);
  assert.equal(pullHead, "volunteer:encode-T0001");
});

test("a poll failure settles a background submission as timeout, not rejection", async (t) => {
  const { result, verdict } = await runEncoding(t, {
    createPullRequest: async () => ({
      number: 16,
      html_url: "https://example.test/pr/16",
    }),
    getPullRequestState: async () => {
      throw new Error("network down");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(verdict.state, "timeout");
  assert.match(verdict.message, /still being processed/);
});

test("a poll failure leaves a claim as still-processing, not rejected", async () => {
  const forge = claimForge(17, {
    getPullRequestState: async () => {
      throw new Error("network down");
    },
  });
  const followed = captureVerdict();

  const result = await withImmediateTimeouts(() =>
    invoke(commands.claimTask, { task_id: "P0001" }, context(forge)),
  );

  assert.equal(result.error, undefined);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "pending");
  assert.match(result.message ?? "", /still being processed/);
  // The claim is followed on in the background, which fails the same way.
  assert.equal((await withImmediateTimeouts(() => followed)).state, "timeout");
});

test("a claim still pending is followed and its accepted verdict deletes the task branch", async () => {
  const deleted: string[] = [];
  let polls = 0;
  const forge = claimForge(18, {
    getPullRequestState: async () => {
      if (polls++ < 3) throw new Error("network down");
      return "closed";
    },
    getLastIssueComment: async () => bot("✅ Claim accepted."),
    getRepoHead: async () => ({
      sha: "head1",
      treeSha: "tree1",
      branch: "main",
      canPush: false,
    }),
    ensureFork: async () => ({ owner: "volunteer", repo: "campaign" }),
    deleteBranch: async (owner, _repo, branch) => {
      if (branch.startsWith("encode-")) deleted.push(`${owner}:${branch}`);
    },
  });
  const verdict = captureVerdict();

  const result = await withImmediateTimeouts(() =>
    invoke(
      commands.claimTask,
      { task_id: "T0001" },
      context(withDecision(forge, 18)),
    ),
  );

  assert.equal(result.outcome, "pending");
  assert.deepEqual(deleted, []);
  assert.equal((await verdict).state, "accepted");
  assert.deepEqual(deleted, ["volunteer:encode-T0001"]);
});

test("a late accepted release keeps the task branch of a claim made since", async () => {
  const deleted: string[] = [];
  const forge = claimForge(20, {
    // The viewer claimed T0001 again after the release was decided.
    getRepoFile: async (_owner, _repo, path) =>
      path === "tracking/lock.csv"
        ? lockHeader +
          "T0001,,9001,2026-01-01T00:05:00Z,encoding,2026-01-02T00:05:00Z\n"
        : null,
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => bot("✅ Release accepted."),
    ensureFork: async () => ({ owner: "volunteer", repo: "campaign" }),
    deleteBranch: async (_owner, _repo, branch) => {
      deleted.push(branch);
    },
  });
  const verdict = captureVerdict();

  resumeFollowing(
    context(withDecision(forge, 20)),
    "Release of T0001",
    { kind: "release", task: "T0001" },
    "entry-1",
    {
      number: 20,
      html_url: "https://example.test/pr/20",
      taskBranch: "T0001",
    },
    Date.now(),
  );

  assert.equal((await verdict).state, "accepted");
  assert.deepEqual(deleted, []);
});

test("a submission followed again after a reload settles with its verdict", async () => {
  const forge = claimForge(19, {
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => bot("✅ Claim accepted."),
  });
  const verdict = captureVerdict();

  resumeFollowing(
    context(withDecision(forge, 19)),
    "Encoding claim of T0001",
    { kind: "claim", task: "T0001" },
    "entry-1",
    { number: 19, html_url: "https://example.test/pr/19" },
    Date.now(),
  );

  assert.equal((await verdict).state, "accepted");
});

test("a submission still open past the follow's first wait is followed until it is decided", async () => {
  let polls = 0;
  const header = `${HISTORY_COLUMNS.join(",")}\n`;
  const forge = claimForge(21, {
    // Open for a while after the first wait has run out; the decision is
    // recorded when it closes.
    getPullRequestState: async () => (polls++ < 5 ? "open" : "closed"),
    getLastIssueComment: async () => bot("✅ Claim accepted."),
    getRepoFile: async (_owner, _repo, path) =>
      path !== HISTORY_PATH
        ? lockHeader
        : polls > 5
          ? `${header}2026-01-01T00:00:00Z,T0001,,9001,claim_encoding,accepted,,,,,21\n`
          : header,
  });
  const verdict = captureVerdict();

  await withImmediateTimeouts(async () => {
    resumeFollowing(
      context(forge),
      "Encoding claim of T0001",
      { kind: "claim", task: "T0001" },
      "entry-1",
      { number: 21, html_url: "https://example.test/pr/21" },
      Date.now() - 2 * 60 * 60_000,
    );
    assert.equal((await verdict).state, "accepted");
  });
  assert.ok(polls > 5);
});

test("resolving a comment flips its replies in the PR payload too", async () => {
  const commentCsv =
    "comment_id,task_id,subtask_id,kind,page,measure_start,measure_end,author_id,timestamp,resolved,parent_id,body\n" +
    "c1,T0001,,comment,,,,9001,t1,,,Answered?\n" +
    "c2,T0001,,reply,,,,7,t2,,c1,Yes\n" +
    "c3,T0001,,comment,,,,9001,t3,,,Other thread\n";
  let serialized = "";
  const forge = fakeForge({
    getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
    getRepoHead: async () => ({
      sha: "head1",
      treeSha: "tree1",
      branch: "main",
      canPush: false,
    }),
    getRepoFile: async () => commentCsv,
    openChangePr: async (_owner, _repo, options) => {
      serialized = options.files[0].content ?? "";
      return {
        number: 18,
        html_url: "https://example.test/pr/18",
        head: {
          owner: "campaign-owner",
          repo: "campaign",
          branch: "resolve-c1-abcd",
        },
      };
    },
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => bot("✅ Comment resolved."),
  });

  const settled = captureVerdict();
  const { result } = await withImmediateTimeouts(async () => {
    const result = await invoke(
      commands.resolveComment,
      { comment_id: "c1" },
      context(forge),
    );
    return { result, verdict: await settled };
  });

  assert.equal(result.ok, true);
  assert.match(serialized, /c1,T0001,,comment,,,,9001,t1,true,,Answered\?/);
  assert.match(serialized, /c2,T0001,,reply,,,,7,t2,true,c1,Yes/);
  assert.match(serialized, /c3,T0001,,comment,,,,9001,t3,,,Other thread/);
});

test("a comment PR starts at the head its comment table was read at", async () => {
  const header =
    "comment_id,task_id,subtask_id,kind,page,measure_start,measure_end,author_id,timestamp,resolved,parent_id,body\n";
  const atHead = header + "c1,T0001,,comment,,,,9001,t1,,,At the head\n";
  let opened: { content: string; baseSha?: string } | null = null;
  const forge = fakeForge({
    getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
    getRepoHead: async () => ({
      sha: "head1",
      treeSha: "tree1",
      branch: "main",
      canPush: false,
    }),
    // A read without a ref returns an older table than the head's.
    getRepoFile: async (_owner, _repo, _path, ref) =>
      ref === "head1" ? atHead : header,
    openChangePr: async (_owner, _repo, options) => {
      opened = {
        content: options.files[0].content ?? "",
        baseSha: options.baseSha,
      };
      return {
        number: 19,
        html_url: "https://example.test/pr/19",
        head: { owner: "volunteer", repo: "campaign", branch: "comment-x" },
      };
    },
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => bot("✅ Comment recorded."),
  });

  const settled = captureVerdict();
  await withImmediateTimeouts(async () => {
    await invoke(
      commands.submitComment,
      commentInput("T0001", "comment", "New", ""),
      context(forge),
    );
    return settled;
  });

  assert.equal(opened!.baseSha, "head1");
  assert.match(opened!.content, /c1,T0001,,comment,,,,9001,t1,,,At the head\n/);
  assert.match(opened!.content, /,New/);
});

test("a rejected volunteer encoding keeps its fork branch for correction", async (t) => {
  let deleted = false;
  const { result, verdict } = await runEncoding(t, {
    createPullRequest: async () => ({
      number: 15,
      html_url: "https://example.test/pr/15",
    }),
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () =>
      bot("❌ Submission rejected: `invalid_mei`."),
    deleteBranch: async () => {
      deleted = true;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(verdict.state, "rejected");
  assert.match(verdict.message, /invalid_mei/);
  assert.equal(deleted, false);
});

test("saveDraft saves nothing while the viewer holds no claim on the task", async () => {
  const files = editorFiles(
    lockHeader +
      "T0001,,4242,2026-09-01T00:00:00Z,encoding,2999-01-01T00:00:00Z\n",
  );
  let wrote = false;
  const forge = fakeForge({
    getRepoFile: async (_owner, _repo, path) => files[path] ?? null,
    createBranch: async () => {
      wrote = true;
    },
    commitFiles: async () => {
      wrote = true;
      return "c1";
    },
  });

  const result = await invoke(
    commands.saveDraft,
    { task_id: "T0001", pins: [] },
    context(forge),
  );

  assert.equal(
    result.error,
    "The draft was not saved: you hold no claim on T0001.",
  );
  assert.equal(wrote, false);
});

// What opening the editor reads: the task and its state, and the lock table.
function editorFiles(lockCsv: string): Record<string, string> {
  return {
    "tracking/task.csv":
      "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\nT0001,,sources/score.mei,,,,\n",
    "tracking/state.csv":
      "task_id,subtask_id,status,encoder,encoded_at,validate_status_1\nT0001,,encoding_required,,,\n",
    "tracking/lock.csv": lockCsv,
  };
}

test("openEditor claims first, then starts the task branch from the score as it stands after the claim", async () => {
  const files = editorFiles(lockHeader);
  const calls: string[] = [];
  const forge = fakeForge({
    getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
    getRepoFile: async (_owner, _repo, path, ref) =>
      ref?.startsWith("wip-") ? null : (files[path] ?? null),
    openChangePr: async () => {
      calls.push("claim");
      return {
        number: 3,
        html_url: "https://example.test/pr/3",
        head: { owner: "volunteer", repo: "campaign", branch: "claim-x" },
      };
    },
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => bot("✅ Claim accepted."),
    // A page is accepted while the claim is processed.
    getRepoHead: async () => ({
      sha: calls.includes("claim") ? "head2" : "head1",
      treeSha: "tree1",
      branch: "main",
      canPush: false,
    }),
    ensureFork: async () => ({ owner: "volunteer", repo: "campaign" }),
    getPullRequestHeadRepo: async () => ({
      owner: "volunteer",
      repo: "campaign",
    }),
    deleteBranch: async (_owner, _repo, branch) => {
      calls.push(`delete ${branch}`);
    },
    createBranch: async (owner, _repo, branch, sha) => {
      calls.push(`create ${owner}/${branch}@${sha}`);
    },
    getRepoFileDownloadUrl: async () => "https://raw.example/score.mei",
  });

  const result = await withImmediateTimeouts(() =>
    invoke(
      commands.openEditor,
      { task_id: "T0001", campaign: "my-campaign", base: "https://le.test" },
      context(withDecision(forge, 3)),
    ),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "claim",
    "delete claim-x",
    "delete encode-T0001",
    "create volunteer/encode-T0001@head2",
  ]);
  const url = new URL(result.meiFriendUrl!);
  assert.equal(url.origin, "https://mei-friend.example");
  assert.equal(url.searchParams.get("file"), "https://raw.example/score.mei");
  assert.equal(url.searchParams.get("le_campaignname"), "my-campaign");
  assert.equal(url.searchParams.get("le_taskid"), "T0001");
  assert.equal(url.searchParams.get("le_base"), "https://le.test");
  assert.equal(url.searchParams.get("select"), null);
  assert.equal(url.searchParams.get("speed"), null);
});

test("openEditor selects the first note of a page task's page", async () => {
  const files: Record<string, string> = {
    ...editorFiles(lockHeader),
    "tracking/task.csv":
      "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\nT0002,,sources/score.mei,surface-2,,,\n",
    "tracking/state.csv":
      "task_id,subtask_id,status,encoder,encoded_at,validate_status_1\nT0002,,encoding_required,,,\n",
    "sources/score.mei":
      '<section><pb xml:id="pb-1" n="1" facs="#surface-1"/><measure xml:id="m-1"/>' +
      '<pb xml:id="pb-2" n="2" facs="#surface-2"/><measure xml:id="m-2"><note xml:id="n-2"/></measure></section>',
  };
  const forge = fakeForge({
    getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
    getRepoFile: async (_owner, _repo, path, ref) =>
      ref?.startsWith("wip-") ? null : (files[path] ?? null),
    openChangePr: async () => ({
      number: 3,
      html_url: "https://example.test/pr/3",
      head: { owner: "volunteer", repo: "campaign", branch: "claim-x" },
    }),
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => bot("✅ Claim accepted."),
    getRepoHead: async () => ({
      sha: "head1",
      treeSha: "tree1",
      branch: "main",
      canPush: false,
    }),
    ensureFork: async () => ({ owner: "volunteer", repo: "campaign" }),
    deleteBranch: async () => {},
    createBranch: async () => {},
    getRepoFileDownloadUrl: async () => "https://raw.example/score.mei",
  });

  const result = await withImmediateTimeouts(() =>
    invoke(
      commands.openEditor,
      { task_id: "T0002", campaign: "my-campaign", base: "https://le.test" },
      context(withDecision(forge, 3)),
    ),
  );

  assert.equal(result.ok, true);
  const url = new URL(result.meiFriendUrl!);
  assert.equal(url.searchParams.get("select"), "n-2");
  assert.equal(url.searchParams.get("speed"), "false");
});

// Open T0001 in the editor with a kept-work branch `wip-T0001`; `earlier`
// are history rows before the viewer's claim. Returns the commits made.
async function openWithKeptWorkBranch(earlier: string) {
  const files = editorFiles(lockHeader);
  const commits: {
    owner: string;
    repo: string;
    paths: string[];
    branch?: string;
  }[] = [];
  const forge = fakeForge({
    getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
    getRepoFile: async (_owner, _repo, path, ref) =>
      ref === "wip-T0001" && path === "sources/score.mei"
        ? "<mei>kept</mei>"
        : ref?.startsWith("wip-")
          ? null
          : (files[path] ?? null),
    openChangePr: async () => ({
      number: 3,
      html_url: "https://example.test/pr/3",
      head: { owner: "volunteer", repo: "campaign", branch: "claim-x" },
    }),
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => bot("✅ Claim accepted."),
    getRepoHead: async () => ({
      sha: "head1",
      treeSha: "tree1",
      branch: "main",
      canPush: false,
    }),
    ensureFork: async () => ({ owner: "volunteer", repo: "campaign" }),
    getPullRequestHeadRepo: async () => ({
      owner: "volunteer",
      repo: "campaign",
    }),
    deleteBranch: async () => {},
    createBranch: async () => {},
    commitFiles: async (owner, repo, changes, _message, opts) => {
      commits.push({
        owner,
        repo,
        paths: changes.map((c) => c.path),
        branch: opts?.branch,
      });
      return "c1";
    },
    getRepoFileDownloadUrl: async () => "https://raw.example/score.mei",
  });

  const result = await withImmediateTimeouts(() =>
    invoke(
      commands.openEditor,
      { task_id: "T0001", campaign: "my-campaign", base: "https://le.test" },
      context(withDecision(forge, 3, earlier)),
    ),
  );

  assert.equal(result.ok, true);
  return commits;
}

test("openEditor starts a fresh task branch from the work kept from expired claims", async () => {
  const commits = await openWithKeptWorkBranch(
    "2025-12-31T00:00:00Z,T0001,,4242,reap,released_with_work,encoding,,,,\n",
  );
  assert.deepEqual(commits, [
    {
      owner: "volunteer",
      repo: "campaign",
      paths: ["sources/score.mei"],
      branch: "encode-T0001",
    },
  ]);
});

test("openEditor ignores a kept-work branch the history does not record", async () => {
  assert.deepEqual(await openWithKeptWorkBranch(""), []);
});

test("openEditor keeps the holder's work on an existing task branch", async () => {
  const files = editorFiles(
    lockHeader +
      "T0001,,9001,2026-09-01T00:00:00Z,encoding,2999-01-01T00:00:00Z\n",
  );
  const calls: string[] = [];
  const forge = fakeForge({
    getRepoFile: async (_owner, _repo, path, ref) =>
      ref?.startsWith("wip-") ? null : (files[path] ?? null),
    getRepoHead: async () => ({
      sha: "head1",
      treeSha: "tree1",
      branch: "main",
      canPush: true,
    }),
    createBranch: async () => {
      throw new Error("Reference already exists");
    },
    fastForwardBranch: async () => {
      calls.push("fast-forward");
      return false;
    },
    getRepoFileDownloadUrl: async () => "https://raw.example/score.mei",
  });

  const result = await withImmediateTimeouts(() =>
    invoke(
      commands.openEditor,
      { task_id: "T0001", campaign: "my-campaign", base: "https://le.test" },
      context(forge),
    ),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["fast-forward"]);
});

test("openEditor leaves the task branch alone while someone else holds the claim", async () => {
  const files = editorFiles(
    lockHeader +
      `T0001,,4242,${new Date().toISOString()},encoding,2999-01-01T00:00:00Z\n`,
  );
  const forge = fakeForge({
    getRepoFile: async (_owner, _repo, path, ref) =>
      ref?.startsWith("wip-") ? null : (files[path] ?? null),
  });

  const result = await invoke(
    commands.openEditor,
    { task_id: "T0001", campaign: "my-campaign", base: "https://le.test" },
    context(forge),
  );

  assert.equal(result.error, "Someone else holds the claim on T0001.");
});

test("openEditor without a configured mei-friend address fails before reading the campaign", async () => {
  let read = false;
  const forge = fakeForge({
    getRepoFile: async () => {
      read = true;
      return null;
    },
  });

  const result = await invoke(
    commands.openEditor,
    { task_id: "T0001", campaign: "my-campaign", base: "https://le.test" },
    { ...context(forge), meiFriendUrl: undefined },
  );

  assert.match(result.error ?? "", /no mei-friend address is configured/);
  assert.equal(read, false);
});

test("an encoding completed without changes gets a commit so its PR can open", async (t) => {
  const calls: string[] = [];
  const { verdict } = await runEncoding(
    t,
    {
      getRepoHead: async () => ({
        sha: "head1",
        treeSha: "tree1",
        branch: "main",
        canPush: true,
      }),
      createPullRequest: async () => {
        calls.push("pr");
        if (calls.length === 1)
          throw new Error(
            "Validation Failed: No commits between main and encode-T0001 (422 POST /pulls)",
          );
        return {
          number: 9,
          html_url: "https://example.test/pr/9",
          headSha: "c2",
        };
      },
      commitFiles: async (_owner, _repo, files, _message, opts) => {
        calls.push(`commit ${files[0].path} on ${opts?.branch}`);
        return "c2";
      },
      getPullRequestState: async () => "closed",
      getLastIssueComment: async () =>
        bot("✅ Submission accepted (encoding)."),
      listWorkflowRuns: async () => [],
      deleteBranch: async () => {},
    },
    9,
  );

  assert.deepEqual(calls, [
    "pr",
    "commit sources/score.mei on encode-T0001",
    "pr",
  ]);
  assert.equal(verdict.state, "accepted");
});

test("savePlan refuses a plan edited from a task table that has changed since", async () => {
  const row = (task_id: string, locator: string) => ({
    task_id,
    subtask_id: "",
    fragment: "sources/piece.mei",
    locator,
    allowlist: "",
    blocklist: "",
    depends_on: "",
  });
  const opened = [row("T0001", "surface-1"), row("T0002", "surface-2")];
  // A replan replaced T0002's page while the editor was open.
  const current = [row("T0001", "surface-1"), row("T0003", "surface-3")];
  const commits: string[] = [];
  const forge = fakeForge({
    getRepoHead: async () => ({
      sha: "head1",
      treeSha: "tree1",
      branch: "main",
      canPush: true,
    }),
    getRepoFile: async (_owner, _repo, path) =>
      path === TASK_PATH
        ? serializeTaskCsv(current)
        : path === "tracking/state.csv"
          ? "task_id,subtask_id,status,encoder,encoded_at\n"
          : null,
    commitFiles: async (_owner, _repo, _files, message) => {
      commits.push(message);
      return "commit1";
    },
  });

  const result = await invoke(
    commands.savePlan,
    { tasks: [...opened, row("T0004", "surface-4")], base: opened },
    context(forge),
  );

  assert.match(result.error ?? "", /changed while you were editing/);
  assert.ok(!commits.includes("Edit the task plan"));
});

test("saveDraft refuses to overwrite a draft saved from another tab", async () => {
  const files = editorFiles(
    lockHeader +
      "T0001,,9001,2026-09-01T00:00:00Z,encoding,2999-01-01T00:00:00Z\n",
  );
  let wrote = false;
  const forge = fakeForge({
    getRepoFile: async (_owner, _repo, path) => files[path] ?? null,
    getRepoHead: async () => ({
      sha: "head1",
      treeSha: "tree1",
      branch: "main",
      canPush: true,
    }),
    // Another tab saved since this editor loaded the branch at "draft1".
    getBranchHead: async () => "draft2",
    commitFiles: async () => {
      wrote = true;
      return "c1";
    },
  });

  const result = await invoke(
    commands.saveDraft,
    { task_id: "T0001", pins: [], base: "draft1" },
    context(forge),
  );

  assert.match(result.error ?? "", /changed in another tab/);
  assert.equal(wrote, false);
});
