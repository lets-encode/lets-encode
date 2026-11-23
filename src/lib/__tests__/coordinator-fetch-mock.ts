// Loaded with `--import` before scripts/coordinator.ts by coordinator-run.test.ts:
// replaces fetch with a GitHub that holds campaign o/r with PR #5 from the
// fork bob/r. Each request is printed to stdout as `[mock] start|end METHOD
// path`, a commit's parents and base tree as `[mock] commit ...`/`[mock] tree
// ...`, a createCommitOnBranch mutation's expected head as `[mock] mutation
// ...`, and the first line of a pull request comment as `[mock] comment ...`.
// Each answer comes 20 ms after its request. A file of o/r is answered only at
// the head last read. MOCK_SCENARIO (JSON) varies the answers:
// - kind: the operation PR #5 carries, "claim" (default), "validation" (a
//   pass on T0001/S0001) or "encoding" (page task T0001, claimed by the
//   author).
// - graphqlError: the GraphQL read answers with an `errors` array and no data.
// - tablesFail: also the repository read through REST fails.
// - movedOnce: the first commit to main is refused because main moved.
// - mutationRefused: every mutation is refused as not permitted.
// - mutationLost: the first mutation commits its files, which later reads
//   return, and its answer is lost.
// - mutationEmpty: as mutationLost, but the answer is an empty object.
// - movedAlways: every mutation is refused because main moved; the pauses
//   between attempts are zero (Math.random returns 0).
// - prMissing: the pull request read answers 404.
// - prClosed: the pull request is closed.
// - slowGraphql: GraphQL answers after 300 ms.

const scenario: {
  kind?: "claim" | "validation" | "encoding";
  graphqlError?: boolean;
  tablesFail?: boolean;
  movedOnce?: boolean;
  mutationRefused?: boolean;
  mutationLost?: boolean;
  mutationEmpty?: boolean;
  movedAlways?: boolean;
  prMissing?: boolean;
  prClosed?: boolean;
  slowGraphql?: boolean;
} = JSON.parse(process.env.MOCK_SCENARIO ?? "{}");

if (scenario.movedAlways) Math.random = () => 0;

const STATE_HEADER =
  "task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n";
const LOCK_HEADER = "task_id,subtask_id,user_id,timestamp,kind,expires\n";
const REVIEW_ROW = "T0001,S0001,validation_required,,,";

const TABLES: Record<string, string> = {
  "tracking/task.csv":
    "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n" +
    `T0001,,sources/score.mei,${scenario.kind === "encoding" ? "surface-1" : ""},,,\nT0001,S0001,sources/score.mei,,,,\n`,
  "tracking/state.csv":
    STATE_HEADER +
    (scenario.kind === "validation"
      ? `T0001,,validation_required,99,2026-11-17T10:00:00Z,\n${REVIEW_ROW}\n`
      : "T0001,,encoding_required,,,\nT0001,S0001,pending,,,\n"),
  "tracking/lock.csv":
    LOCK_HEADER +
    (scenario.kind === "encoding"
      ? "T0001,,42,2026-11-18T09:00:00Z,encoding,2099-01-01T00:00:00Z\n"
      : ""),
  "tracking/history.csv":
    "timestamp,task_id,subtask_id,user_id,action,outcome,detail,command,version,input,pr\n",
  "tracking/comment.csv":
    "comment_id,task_id,subtask_id,kind,page,measure_start,measure_end,author_id,timestamp,resolved,parent_id,body,fragment\n",
  "config.yaml": "campaign:\n  title: Test\n",
};

// The changed files of PR #5.
const PR_FILES = {
  claim: [
    {
      filename: "tracking/lock.csv",
      status: "modified",
      patch: `@@ -1 +1,2 @@\n ${LOCK_HEADER}+T0001,,42,2026-11-18T10:00:00Z,encoding,`,
    },
  ],
  validation: [
    {
      filename: "tracking/state.csv",
      status: "modified",
      patch: `@@ -1,3 +1,3 @@\n ${STATE_HEADER} T0001,,validation_required,99,2026-11-17T10:00:00Z,\n-${REVIEW_ROW}\n+${REVIEW_ROW}pass`,
    },
  ],
  encoding: [
    { filename: "sources/score.mei", status: "modified", patch: "@@ -1 +1 @@" },
  ],
}[scenario.kind ?? "claim"];

let graphqlReads = 0;
let branchReads = 0;
let refUpdates = 0;
let mutations = 0;
// The head commit the last read of the branch head returned.
let lastHead = "";

// A thrown TypeError is a request that got no answer.
function answer(method: string, url: URL, body: unknown): Response {
  const path = url.pathname;
  if (
    method === "POST" &&
    path === "/graphql" &&
    (body as { query: string }).query.startsWith("mutation")
  ) {
    const { input } = (
      body as {
        variables: {
          input: {
            expectedHeadOid: string;
            fileChanges: { additions: { path: string; contents: string }[] };
          };
        };
      }
    ).variables;
    console.log(`[mock] mutation ${input.expectedHeadOid}`);
    const n = ++mutations;
    if (scenario.mutationRefused)
      return Response.json({
        data: { createCommitOnBranch: null },
        errors: [
          {
            type: "FORBIDDEN",
            path: ["createCommitOnBranch"],
            message: "Resource not accessible by integration",
          },
        ],
      });
    if (
      input.expectedHeadOid !== lastHead ||
      scenario.movedAlways ||
      (scenario.movedOnce && n === 1)
    )
      return Response.json({
        data: { createCommitOnBranch: null },
        errors: [
          {
            type: "STALE_DATA",
            path: ["createCommitOnBranch"],
            message: `Expected branch to point to "${input.expectedHeadOid}" but it did not.  Pull and try again.`,
          },
        ],
      });
    if ((scenario.mutationLost || scenario.mutationEmpty) && n === 1) {
      for (const { path, contents } of input.fileChanges.additions)
        TABLES[path] = new TextDecoder().decode(
          Uint8Array.from(atob(contents), (c) => c.charCodeAt(0)),
        );
      if (scenario.mutationEmpty) return Response.json({});
      throw new TypeError("fetch failed");
    }
    return Response.json({
      data: { createCommitOnBranch: { commit: { oid: `m${n}` } } },
    });
  }
  if (method === "POST" && path === "/graphql") {
    if (scenario.graphqlError || scenario.tablesFail)
      return Response.json({ data: null, errors: [{ message: "Timeout" }] });
    const n = ++graphqlReads;
    lastHead = `h${n}`;
    const { variables } = body as { variables: Record<string, string> };
    const fields: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(variables))
      if (name.startsWith("p"))
        fields[`f${name.slice(1)}`] = {
          object: { text: TABLES[value], isTruncated: false },
        };
    return Response.json({
      data: {
        r0: {
          isPrivate: false,
          viewerPermission: "ADMIN",
          defaultBranchRef: {
            name: "main",
            target: { oid: `h${n}`, tree: { oid: `t${n}` }, ...fields },
          },
        },
      },
    });
  }
  if (method === "GET" && path === "/repos/o/r")
    return scenario.tablesFail
      ? Response.json({ message: "Repo gone" }, { status: 404 })
      : Response.json({ default_branch: "main", permissions: { push: true } });
  if (method === "GET" && path === "/repos/o/r/branches/main") {
    const n = ++branchReads;
    lastHead = `rest${n}`;
    return Response.json({
      commit: { sha: `rest${n}`, commit: { tree: { sha: `resttree${n}` } } },
    });
  }
  const content = path.match(/^\/repos\/o\/r\/contents\/(.+)$/);
  if (method === "GET" && content && url.searchParams.get("ref") === lastHead)
    return Response.json({
      content: btoa(
        TABLES[decodeURIComponent(content[1])] ?? "<mei>base</mei>",
      ),
      encoding: "base64",
    });
  if (
    method === "GET" &&
    path === "/repos/bob/r/contents/sources/score.mei" &&
    url.searchParams.get("ref") === "head5"
  )
    return Response.json({ content: btoa("not mei"), encoding: "base64" });
  if (method === "GET" && path === "/repos/o/r/pulls/5/commits")
    return Response.json([]);
  if (method === "GET" && path === "/repos/o/r/pulls/5")
    return scenario.prMissing
      ? Response.json({ message: "Not Found" }, { status: 404 })
      : Response.json({
          body: null,
          changed_files: 1,
          commits: 1,
          created_at: "2026-11-18T10:00:00Z",
          state: scenario.prClosed ? "closed" : "open",
          head: { sha: "head5", repo: { full_name: "bob/r" } },
          base: { sha: "base5" },
        });
  if (method === "GET" && path === "/repos/o/r/pulls/5/files")
    return Response.json(PR_FILES);
  if (method === "GET" && path === "/repos/o/r/pulls") return Response.json([]);
  if (method === "POST" && path === "/repos/o/r/git/trees") {
    console.log(`[mock] tree ${(body as { base_tree: string }).base_tree}`);
    return Response.json({ sha: "newtree" });
  }
  if (method === "POST" && path === "/repos/o/r/git/commits") {
    console.log(`[mock] commit ${(body as { parents: string[] }).parents}`);
    return Response.json({ sha: "newcommit" });
  }
  if (method === "PATCH" && path === "/repos/o/r/git/refs/heads/main")
    return scenario.movedOnce && ++refUpdates === 1
      ? Response.json(
          { message: "Update is not a fast forward" },
          { status: 422 },
        )
      : Response.json({});
  if (method === "POST" && path === "/repos/o/r/issues/5/comments") {
    console.log(
      `[mock] comment ${(body as { body: string }).body.split("\n", 1)[0]}`,
    );
    return Response.json({ id: 1 });
  }
  if (method === "PATCH" && path === "/repos/o/r/pulls/5")
    return Response.json({ state: "closed" });
  console.log(`[mock] unexpected ${method} ${path}`);
  return Response.json({ message: "Unexpected" }, { status: 400 });
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  console.log(`[mock] start ${method} ${url.pathname}`);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const slow = scenario.slowGraphql && url.pathname === "/graphql";
  await new Promise((resolve) => setTimeout(resolve, slow ? 300 : 20));
  console.log(`[mock] end ${method} ${url.pathname}`);
  return answer(method, url, body);
};
