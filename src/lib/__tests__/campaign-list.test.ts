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
  openWorkOrder,
  viewerTasks,
  workSummary,
} from "../campaign-list/my-work.ts";
import type { CampaignStats, MyTask } from "../campaign-stats.ts";

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

const task = (over: Partial<MyTask>): MyTask =>
  ({
    group: "encoding",
    campaignSlug: "c",
    task: "T1",
    claimedAt: "",
    submittedAt: "",
    ...over,
  }) as MyTask;

test("openWorkOrder lists encoding, reviewing, then awaiting, newest first", () => {
  const order = openWorkOrder(
    [
      task({ task: "E1", claimedAt: "2026-01-01" }),
      task({ task: "E2", claimedAt: "2026-02-01" }),
    ],
    [task({ group: "validating", task: "V1" })],
    [
      task({ group: "awaiting", task: "A2", campaignSlug: "b" }),
      task({ group: "awaiting", task: "A1", campaignSlug: "a" }),
    ],
  );
  assert.deepEqual(
    order.map((t) => t.task),
    ["E2", "E1", "V1", "A1", "A2"],
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
    workSummary({
      incomplete: false,
      encoding: 0,
      validating: 0,
      awaiting: 0,
      done: 0,
    }),
    "0 done",
  );
  assert.equal(
    workSummary({
      incomplete: true,
      encoding: 2,
      validating: 1,
      awaiting: 3,
      done: 4,
    }),
    "Incomplete · 2 encoding · 1 reviewing · 3 awaiting review · 4 done",
  );
});

test("logged out there is no work, attention or contribution date", () => {
  const stats = [campaign({ owner: "me" })];
  assert.deepEqual(viewerTasks(stats, "", 0), []);
  assert.deepEqual(attentionItems(stats, null, []), []);
  assert.equal(contributingSince(stats, ""), "");
});
