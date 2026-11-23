import { test } from "node:test";
import assert from "node:assert/strict";

import {
  filterCampaigns,
  isOwned,
  matchesSearch,
  openToClaim,
  queryString,
  readQuery,
} from "../campaign-list/list-query.ts";
import {
  attentionItems,
  contributingSince,
  doneTasks,
  toDoOrder,
  claimEndsSoon,
  doneGroups,
  viewerTasks,
  workSummary,
} from "../campaign-list/my-work.ts";
import type { CampaignStats, MyTask } from "../campaign-stats.ts";
import {
  parseLockCsv,
  parseStateCsv,
  parseTaskCsv,
} from "../campaign-tables.ts";

const campaign = (over: Partial<CampaignStats>): CampaignStats =>
  ({
    owner: "org",
    name: "c",
    title: "C",
    composer: "",
    pieceNames: {},
    done: 0,
    total: 0,
    ready: 0,
    toValidate: 0,
    nearlyDone: false,
    lastActivity: "",
    createdAt: "",
    history: [],
    taskDefs: [],
    rows: [],
    validationColumns: [],
    locks: [],
    piecePreparations: {},
    passThreshold: 2,
    allowSelfValidation: false,
    ...over,
  }) as CampaignStats;

const nobody = { viewer: "", user: null };

test("readQuery falls back to the defaults for unknown values", () => {
  assert.deepEqual(readQuery(new URLSearchParams("filter=x&sort=y")), {
    search: "",
    filter: "all",
    sort: "active",
  });
  assert.deepEqual(
    readQuery(new URLSearchParams("q=bach&filter=nearly&sort=newest")),
    { search: "bach", filter: "nearly", sort: "newest" },
  );
});

test("queryString leaves the defaults out", () => {
  assert.equal(queryString({ search: "", filter: "all", sort: "active" }), "");
  assert.equal(
    queryString({ search: "a b", filter: "open", sort: "progress" }),
    "q=a+b&filter=open&sort=progress",
  );
});

test("matchesSearch looks in name, title, composer and pieces", () => {
  const s = campaign({
    composer: "Clara Schumann",
    pieceNames: { P1: "Lied" },
  });
  assert.ok(matchesSearch(s, "  "));
  assert.ok(matchesSearch(s, "SCHUMANN"));
  assert.ok(matchesSearch(s, "lied"));
  assert.ok(!matchesSearch(s, "bach"));
});

test("openToClaim logged out counts open and reviewable tasks", () => {
  assert.ok(!openToClaim(campaign({}), ""));
  assert.ok(openToClaim(campaign({ ready: 1 }), ""));
  assert.ok(openToClaim(campaign({ toValidate: 2 }), ""));
});

test("isOwned needs a login matching the owner", () => {
  assert.ok(!isOwned(campaign({ owner: "me" }), null));
  assert.ok(isOwned(campaign({ owner: "me" }), { login: "me" }));
  assert.ok(!isOwned(campaign({ owner: "org" }), { login: "me" }));
});

test("filterCampaigns filters, then sorts by the chosen order", () => {
  const a = campaign({
    name: "a",
    createdAt: "2026-01-01",
    lastActivity: "2026-05-01",
    done: 1,
    total: 4,
  });
  const b = campaign({
    name: "b",
    createdAt: "2026-02-01",
    done: 3,
    total: 4,
    nearlyDone: true,
    owner: "me",
  });
  const c = campaign({ name: "c", createdAt: "2026-03-01" });
  const names = (l: CampaignStats[]) => l.map((s) => s.name);
  const q = { search: "", filter: "all" as const };
  assert.deepEqual(
    names(filterCampaigns([a, b, c], { ...q, sort: "active" }, nobody)),
    ["a", "c", "b"],
  );
  assert.deepEqual(
    names(filterCampaigns([a, b, c], { ...q, sort: "newest" }, nobody)),
    ["c", "b", "a"],
  );
  assert.deepEqual(
    names(filterCampaigns([a, b, c], { ...q, sort: "progress" }, nobody)),
    ["b", "a", "c"],
  );
  assert.deepEqual(
    names(
      filterCampaigns(
        [a, b, c],
        { search: "", filter: "nearly", sort: "active" },
        nobody,
      ),
    ),
    ["b"],
  );
  assert.deepEqual(
    names(
      filterCampaigns(
        [a, b, c],
        { search: "", filter: "yours", sort: "active" },
        { viewer: "1", user: { login: "me" } },
      ),
    ),
    ["b"],
  );
});

test("filterCampaigns by activity puts held work, then claims, then tasks open to others first", () => {
  const TASKS =
    "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n" +
    "T0001,,sources/a.mei,surface-1,,,\n" +
    "T0001,S0001,sources/a.mei,surface-1,,,\n";
  const STATE =
    "task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n";
  const LOCKS = "task_id,subtask_id,user_id,timestamp,kind,expires\n";
  const withTask = (name: string, state: string, locks = "") =>
    campaign({
      name,
      lastActivity: "2026-01-01",
      taskDefs: parseTaskCsv(TASKS),
      ...((t) => ({ rows: t.rows, validationColumns: t.validationColumns }))(
        parseStateCsv(STATE + state),
      ),
      locks: parseLockCsv(LOCKS + locks),
    });
  const encoding = "T0001,,encoding_required,,,\nT0001,S0001,pending,,,\n";
  const none = campaign({ name: "none", lastActivity: "2026-05-01" });
  // 7 encoded the task; another volunteer has to review it.
  const others = withTask(
    "others",
    "T0001,,validation_required,7,2026-01-01T00:00:00Z,\n" +
      "T0001,S0001,validation_required,,,\n",
  );
  const claim = withTask("claim", encoding);
  const held = withTask(
    "held",
    encoding,
    "T0001,,7,2026-01-01T00:00:00Z,encoding,2099-01-01T00:00:00.000Z\n",
  );
  const me = { viewer: "7", user: { login: "me" } };
  const q = { search: "", filter: "all" as const };
  const list = [none, others, claim, held];
  assert.deepEqual(
    filterCampaigns(list, { ...q, sort: "active" }, me).map((s) => s.name),
    ["held", "claim", "others", "none"],
  );
  // The other sorts ignore the next task.
  assert.deepEqual(
    filterCampaigns(list, { ...q, sort: "progress" }, me).map((s) => s.name),
    ["none", "others", "claim", "held"],
  );
});

const task = (over: Partial<MyTask>): MyTask =>
  ({
    group: "encoding",
    campaignSlug: "c",
    task: "T1",
    claimedAt: "",
    submittedAt: "",
    ...over,
  }) as MyTask;

test("toDoOrder lists encoding, then reviews, newest claim first", () => {
  const order = toDoOrder(
    [
      task({ task: "E1", claimedAt: "2026-01-01" }),
      task({ task: "E2", claimedAt: "2026-02-01" }),
    ],
    [task({ group: "validating", task: "V1" })],
  );
  assert.deepEqual(
    order.map((t) => t.task),
    ["E2", "E1", "V1"],
  );
});

test("claimEndsSoon names a claim in its last 48 hours", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(
    claimEndsSoon(task({ expiresAt: "2026-01-01T05:00:00Z" }), now),
    "claim expires in 5 h",
  );
  assert.equal(
    claimEndsSoon(task({ expiresAt: "2026-01-04T00:00:00Z" }), now),
    "",
  );
  assert.equal(claimEndsSoon(task({ expiresAt: "" }), now), "");
});

test("doneGroups groups by campaign in list order and filters", () => {
  const done = [
    task({
      task: "D1",
      campaignSlug: "a",
      campaign: "Alpha",
      title: "Encode p. 1",
    }),
    task({
      task: "D2",
      campaignSlug: "b",
      campaign: "Beta",
      title: "Score setup",
    }),
    task({
      task: "D3",
      campaignSlug: "a",
      campaign: "Alpha",
      title: "Encode p. 2",
    }),
  ];
  assert.deepEqual(
    doneGroups(done).map((g) => [g.campaign, g.tasks.map((t) => t.task)]),
    [
      ["Alpha", ["D1", "D3"]],
      ["Beta", ["D2"]],
    ],
  );
  assert.deepEqual(
    doneGroups(done, " P. 2 ").map((g) => g.tasks.map((t) => t.task)),
    [["D3"]],
  );
  assert.deepEqual(
    doneGroups(done, "beta").map((g) => g.campaign),
    ["Beta"],
  );
  assert.deepEqual(
    doneGroups(done, "", "b").map((g) => g.tasks.length),
    [1],
  );
});

test("doneTasks keeps the done group, latest submission first", () => {
  const done = doneTasks([
    task({ group: "done", task: "D1", submittedAt: "2026-01-01" }),
    task({ group: "encoding", task: "E1" }),
    task({ group: "done", task: "D2", submittedAt: "2026-03-01" }),
  ]);
  assert.deepEqual(
    done.map((t) => t.task),
    ["D2", "D1"],
  );
});

test("workSummary leads with an incomplete listing and always counts done", () => {
  assert.equal(
    workSummary({ incomplete: false, awaiting: 0, done: 0 }),
    "0 done",
  );
  assert.equal(
    workSummary({ incomplete: true, awaiting: 3, done: 4 }),
    "Incomplete · 3 waiting · 4 done",
  );
});

test("logged out there is no work, attention or contribution date", () => {
  const stats = [campaign({ owner: "me" })];
  assert.deepEqual(viewerTasks(stats, "", 0), []);
  assert.deepEqual(attentionItems(stats, null, []), []);
  assert.equal(contributingSince(stats, ""), "");
});
