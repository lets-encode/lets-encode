// Compares two campaigns over the same pages, made with copy-campaign.ts with
// different preparations, as a Markdown report on stdout: per piece the
// staves of each score, then one table per page.
//
//   Staff placement   a campaign whose layout task names the instruments
//                     places each staff box on a score staff of a named
//                     instrument; the other campaign's placement, as its page
//                     drafts compute it from omr.xml, is matched box by box
//                     (by position), and a box counts as misplaced when the
//                     score staff it is placed on mostly shows another named
//                     staff
//   Draft             the page task's transcription draft, the first draft
//                     commit of its latest encoding pull request or branch:
//                     measures; staff measures with notes, only mRest, only
//                     mSpace or nothing; key, meter and clefs at the page
//                     start, and where they change on the page
//   Encoded           the same from the default branch, once the page's
//                     encoding was accepted
//   Musibot runs      with --relay-db (the broker's relay.db): the OMR runs
//                     per login and UTC day, for every day from the claim of
//                     one of the campaign's pre-tasks to its accepted
//                     submission or release, or its expiry. The database counts
//                     per login and day, not per campaign: a day shared with
//                     other work counts that work too.
//
// Runs at any stage: what a campaign does not have yet is reported as missing.
//
// Env: GH_TOKEN — a token that can read both campaign repos.
// Usage: GH_TOKEN=... node scripts/compare-campaigns.ts <owner>/<repo> <owner>/<repo> [--relay-db <path>] > report.md

import { DatabaseSync } from "node:sqlite";
import {
  CONFIG_PATH,
  HISTORY_PATH,
  TASK_PATH,
  configPieces,
  parseHistoryCsv,
  parseTaskCsv,
  type HistoryRow,
  type PieceRef,
  type TaskRow,
} from "../src/lib/campaign-tables.ts";
import {
  parseFacsimileMei,
  type MeasureBox,
  type PageModel,
  type ParsedFacsimile,
} from "../src/lib/mei-facsimile.ts";
import { pageSpan } from "../src/lib/mei-page-splice.ts";
import { tagsIn } from "../src/lib/mei-xml.ts";
import {
  correctedLayoutPath,
  layoutInstruments,
  withCorrectedLayout,
} from "../src/lib/omr-layout.ts";
import { omrRecordPath, parseOmrRecord } from "../src/lib/omr-record.ts";
import { pieceStaves, scoreStaves } from "../src/lib/omr-timeline.ts";
import { staffPlan, type PlannedStaff } from "../src/lib/instrument-naming.ts";
import * as gh from "../src/lib/forge/github-rest.ts";

// The GitHub client logs every request with console.info, which writes to
// stdout.
console.info = () => {};

const API = "https://api.github.com";
const DRAFT_MESSAGE = /^Transcription draft of page /;

const token = process.env.GH_TOKEN ?? "";
const args = process.argv.slice(2);
const dbAt = args.indexOf("--relay-db");
const relayDb = dbAt < 0 ? undefined : args.splice(dbAt, 2)[1];
if (
  !token ||
  args.length !== 2 ||
  !args.every((a) => /^[^/]+\/[^/]+$/.test(a))
) {
  console.error(
    "Usage: GH_TOKEN=<token> node scripts/compare-campaigns.ts <owner>/<repo> <owner>/<repo> [--relay-db <path>] > report.md",
  );
  process.exit(1);
}

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  Authorization: `Bearer ${token}`,
};

async function api<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API}${path}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok)
    throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as T;
}

interface PullRequest {
  number: number;
  head: { ref: string };
}

interface Campaign {
  slug: string;
  owner: string;
  repo: string;
  head: string;
  config: string;
  pieces: PieceRef[];
  tasks: TaskRow[];
  history: HistoryRow[];
  pulls: PullRequest[];
}

async function loadCampaign(slug: string): Promise<Campaign> {
  const [owner, repo] = slug.split("/");
  const read = (path: string) => gh.getRepoFile(token, owner, repo, path);
  const [config, tasks, history, head] = await Promise.all([
    read(CONFIG_PATH),
    read(TASK_PATH),
    read(HISTORY_PATH),
    gh.getRepoHead(token, owner, repo),
  ]);
  if (!config) throw new Error(`${slug} has no ${CONFIG_PATH}.`);
  const pulls: PullRequest[] = [];
  for (let page = 1; ; page++) {
    const batch =
      (await api<PullRequest[]>(
        `/repos/${owner}/${repo}/pulls?state=all&per_page=100&page=${page}`,
      )) ?? [];
    pulls.push(...batch);
    if (batch.length < 100) break;
  }
  return {
    slug,
    owner,
    repo,
    head: head.sha,
    config,
    pieces: configPieces(config),
    tasks: parseTaskCsv(tasks ?? ""),
    history: parseHistoryCsv(history ?? ""),
    pulls,
  };
}

// ------------------------------------------------------------ staff placement

/** A piece's score at the head with its corrected layout in place, its recognition record, and its named instruments. */
interface PieceState {
  parsed: ParsedFacsimile | null;
  pages: PageModel[];
  record: ReturnType<typeof parseOmrRecord>;
  named: ReturnType<typeof layoutInstruments>;
}

async function loadPiece(c: Campaign, path: string): Promise<PieceState> {
  const read = (p: string) => gh.getRepoFile(token, c.owner, c.repo, p, c.head);
  const [score, corrected, record] = await Promise.all([
    read(path),
    read(correctedLayoutPath(path)),
    read(omrRecordPath(path)),
  ]);
  const parsed = score ? parseFacsimileMei(score) : null;
  const boxed = parsed?.pages.some((pg) => pg.zones.length) ?? false;
  return {
    parsed,
    pages:
      parsed && corrected && boxed
        ? withCorrectedLayout(parsed.pages, corrected)
        : (parsed?.pages ?? []),
    record: parseOmrRecord(record),
    named: corrected ? layoutInstruments(corrected) : null,
  };
}

/**
 * Per page, per staff box index: the score staff the named instruments place
 * it on (its staffDef xml:id, and the staff by name) and what it shows.
 */
function namedBoxes(
  state: PieceState,
): Map<number, { staff: string; staffName: string; shown: string }>[] {
  const plan = staffPlan(state.named!, state.pages);
  const name = (staff: PlannedStaff, parts: number[]) => {
    const { instrument } = staff;
    const printed = parts.map((i) => instrument.parts[i].name).join(".");
    const several = plan.staves.some(
      (other) => other.instrument === instrument && other.position > 1,
    );
    return {
      staff: staff.id,
      staffName: several
        ? `${instrument.name}, staff ${staff.position}`
        : instrument.name,
      shown: printed ? `${instrument.name} ${printed}` : instrument.name,
    };
  };
  return state.pages.map(
    (_, p) =>
      new Map(
        plan.systems
          .filter((s) => s.page === p)
          .flatMap((s) =>
            [...s.boxes].map(([box, at]) => [
              box,
              name(plan.staves[at.n - 1], at.parts),
            ]),
          ),
      ),
  );
}

const overlap = (a: MeasureBox, b: MeasureBox): number => {
  const w = Math.min(a.lrx, b.lrx) - Math.max(a.ulx, b.ulx);
  const h = Math.min(a.lry, b.lry) - Math.max(a.uly, b.uly);
  if (w <= 0 || h <= 0) return 0;
  const area = (r: MeasureBox) => (r.lrx - r.ulx) * (r.lry - r.uly);
  return (w * h) / (area(a) + area(b) - w * h);
};

/** The index of the box in `boxes` that overlaps `box` most, by at least half; -1 for none. */
function matchingBox(box: MeasureBox, boxes: MeasureBox[]): number {
  let best = -1;
  let score = 0.5;
  boxes.forEach((other, i) => {
    const o = overlap(box, other);
    if (o >= score) [best, score] = [i, o];
  });
  return best;
}

interface Placement {
  boxes: number;
  /** Boxes on no system or no score staff. */
  unplaced: number;
  /** Boxes the named campaign has no box for. */
  unmatched: number;
  misplaced: string[];
}

/**
 * Per page, the placement of `guess`'s staff boxes measured against the
 * instruments `truth` names. Null when `guess` has no recognition record.
 */
function placements(guess: PieceState, truth: PieceState): Placement[] | null {
  if (!guess.parsed || !guess.record) return null;
  const named = namedBoxes(truth);
  const staves = pieceStaves(
    { pages: guess.pages },
    guess.record,
    scoreStaves(guess.parsed),
  );
  // Each guessed box with its score staff n and the named staff it shows.
  const boxes = staves.map((page, p) =>
    page.systems.flatMap((system, s) =>
      system.map((box, k) => {
        const index = matchingBox(box, truth.pages[p]?.staves ?? []);
        return {
          system: s + 1,
          position: k + 1,
          n: page.assigned[s][k],
          truth: index < 0 ? undefined : named[p].get(index),
        };
      }),
    ),
  );
  // Each score staff's named staff: the one most of its boxes show.
  const counts = new Map<number, Map<string, number>>();
  const staffNames = new Map<string, string>();
  for (const box of boxes.flat()) {
    if (!box.n || !box.truth) continue;
    const forStaff = counts.get(box.n) ?? new Map<string, number>();
    forStaff.set(box.truth.staff, (forStaff.get(box.truth.staff) ?? 0) + 1);
    counts.set(box.n, forStaff);
    staffNames.set(box.truth.staff, box.truth.staffName);
  }
  const namedStaff = (n: number) =>
    [...(counts.get(n) ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0];
  const label = (n: number) =>
    guess.parsed!.scoreDef.staves[n - 1]?.label || `staff ${n}`;
  return boxes.map((page, p) => ({
    boxes: page.length + staves[p].unplaced,
    unplaced: page.filter((b) => !b.n).length + staves[p].unplaced,
    unmatched: page.filter((b) => b.n && !b.truth).length,
    misplaced: page.flatMap((b) =>
      b.n && b.truth && namedStaff(b.n) !== b.truth.staff
        ? [
            `system ${b.system}, staff box ${b.position}: ${b.truth.shown} (${b.truth.staffName}), placed on ${b.n} ${label(b.n)} (mostly ${staffNames.get(namedStaff(b.n)!)})`,
          ]
        : [],
    ),
  }));
}

// ----------------------------------------------------------- page notation

interface PageNotation {
  measures: number;
  notes: number;
  mRest: number;
  mSpace: number;
  empty: number;
  start: string;
  changes: string[];
}

const clefOf = (shape?: string, line?: string, dis?: string, place?: string) =>
  shape
    ? `${shape}${shape === "perc" || shape === "TAB" ? "" : (line ?? "")}` +
      (dis ? `${place === "below" ? "-" : "+"}${dis}` : "")
    : undefined;

const NOTATION = new Set([
  "note",
  "rest",
  "chord",
  "space",
  "mRpt",
  "beatRpt",
  "halfmRpt",
  "multiRpt",
  "bTrem",
  "fTrem",
]);

/**
 * What `mei` holds on page `page` (1-based): the measures of its `<pb>` span,
 * each staff of each measure by content, the key, meter and clefs in force
 * at its first measure (after the score definitions before it), and every
 * change on the page by the measure it holds for: a change between measures
 * by the measure after it. Null when the page has
 * no `<pb>`.
 */
function pageNotation(mei: string, page: number): PageNotation | null {
  const span = pageSpan(mei, `surface-${page}`);
  if (!span) return null;
  let key = "";
  let meter = "";
  // Per staff n its clef and its own key signature ('' for the score's).
  const staves = new Map<string, { clef: string; key: string }>();
  const changes: string[] = [];
  const counts = { measures: 0, notes: 0, mRest: 0, mSpace: 0, empty: 0 };
  let start = "";
  let measure = "";
  let inMeasure = false;
  // Changes between measures, given the measure that follows them.
  let pending: string[] = [];
  let staffDef: string | null = null;
  let staff: string | null = null;
  let cell = new Set<string>();
  const inPage = (at: number) => at >= span.from && at < span.to;
  const changed = (at: number, what: string) => {
    if (!inPage(at)) return;
    if (inMeasure) changes.push(`m. ${measure}: ${what}`);
    else pending.push(what);
  };
  const staffState = (n: string) =>
    staves.get(n) ?? staves.set(n, { clef: "?", key: "" }).get(n)!;
  const setKey = (at: number, sig: string | undefined, n: string | null) => {
    if (!sig) return;
    if (n === null) {
      if (sig !== key) changed(at, `key ${sig}`);
      key = sig;
    } else if (sig !== staffState(n).key) {
      changed(at, `staff ${n} key ${sig}`);
      staffState(n).key = sig;
    }
  };
  const setMeter = (
    at: number,
    count?: string,
    unit?: string,
    sym?: string,
  ) => {
    const m = sym ?? (count && unit ? `${count}/${unit}` : undefined);
    if (!m || m === meter) return;
    changed(at, `meter ${m}`);
    meter = m;
  };
  const setClef = (at: number, n: string | null, clef?: string) => {
    if (!n || !clef || staffState(n).clef === clef) return;
    changed(at, `staff ${n} clef ${clef}`);
    staffState(n).clef = clef;
  };
  const snapshot = () =>
    `key ${key || "none"}, meter ${meter || "none"}; clefs ` +
    [...staves]
      .map(
        ([n, s]) =>
          `${n} ${s.clef}${s.key && s.key !== key ? ` (key ${s.key})` : ""}`,
      )
      .join(", ");
  for (const tag of tagsIn(mei)) {
    if (tag.start >= span.to) break;
    const a = (name: string) => tag.attributes?.get(name);
    const opens = tag.kind !== "end";
    switch (tag.name) {
      case "scoreDef":
        if (!opens) break;
        setKey(tag.start, a("keysig") ?? a("key.sig"), null);
        setMeter(tag.start, a("meter.count"), a("meter.unit"), a("meter.sym"));
        break;
      case "staffDef":
        if (!opens) {
          staffDef = null;
          break;
        }
        staffDef = a("n") ?? null;
        setClef(
          tag.start,
          staffDef,
          clefOf(
            a("clef.shape"),
            a("clef.line"),
            a("clef.dis"),
            a("clef.dis.place"),
          ),
        );
        setKey(tag.start, a("keysig") ?? a("key.sig"), staffDef);
        setMeter(tag.start, a("meter.count"), a("meter.unit"), a("meter.sym"));
        if (tag.kind === "empty") staffDef = null;
        break;
      case "keySig":
        if (opens) setKey(tag.start, a("sig"), staffDef);
        break;
      case "meterSig":
        if (opens) setMeter(tag.start, a("count"), a("unit"), a("sym"));
        break;
      case "clef":
        if (opens)
          setClef(
            tag.start,
            staffDef ?? staff,
            clefOf(a("shape"), a("line"), a("dis"), a("dis.place")),
          );
        break;
      case "measure":
        inMeasure = tag.kind === "start";
        if (!inMeasure) break;
        measure = a("n") ?? "?";
        if (inPage(tag.start)) {
          counts.measures++;
          if (!start) start = snapshot();
          changes.push(...pending.map((what) => `m. ${measure}: ${what}`));
        }
        pending = [];
        break;
      case "staff":
        if (tag.kind === "start") {
          staff = a("n") ?? null;
          cell = new Set();
        } else {
          if (tag.kind === "empty") cell = new Set();
          if (inPage(tag.start)) {
            if ([...cell].some((n) => NOTATION.has(n))) counts.notes++;
            else if (cell.has("mSpace") && !cell.has("mRest")) counts.mSpace++;
            else if (cell.size) counts.mRest++;
            else counts.empty++;
          }
          staff = null;
        }
        break;
      default:
        if (
          staff &&
          opens &&
          (NOTATION.has(tag.name) ||
            tag.name === "mRest" ||
            tag.name === "mSpace" ||
            tag.name === "multiRest")
        )
          cell.add(tag.name === "multiRest" ? "mRest" : tag.name);
    }
  }
  changes.push(...pending.map((what) => `end of page: ${what}`));
  return { ...counts, start: start || snapshot(), changes };
}

// ------------------------------------------------------------------- drafts

/** The draft commit of `task`'s latest encoding pull request, else of its branch; null for none. */
async function draftCommit(
  c: Campaign,
  task: string,
): Promise<{ sha: string; where: string } | null> {
  const branch = `encode-${task}`;
  const pull = c.pulls
    .filter((p) => p.head.ref === branch)
    .sort((a, b) => b.number - a.number)[0];
  const commits = pull
    ? await api<{ sha: string; commit: { message: string } }[]>(
        `/repos/${c.owner}/${c.repo}/pulls/${pull.number}/commits?per_page=100`,
      )
    : await api<{ sha: string; commit: { message: string } }[]>(
        `/repos/${c.owner}/${c.repo}/commits?sha=${branch}&per_page=100`,
      );
  const ordered = pull ? commits : [...(commits ?? [])].reverse();
  const draft = (ordered ?? []).find((x) =>
    DRAFT_MESSAGE.test(x.commit.message),
  );
  if (!draft) return null;
  return {
    sha: draft.sha,
    where: pull ? `pull request ${pull.number}` : `branch ${branch}`,
  };
}

const accepted = (c: Campaign, task: string) =>
  c.history.some(
    (h) =>
      h.task_id === task &&
      h.action === "submit_encoding" &&
      h.outcome === "accepted",
  );

// ------------------------------------------------------------- Musibot runs

/** "<login> <UTC day>" for every day from the claim of one of the campaign's pre-tasks to its accepted submission or release, or its expiry. */
async function preTaskDays(c: Campaign): Promise<Set<string>> {
  const days = new Set<string>();
  const logins = new Map<string, string>();
  const login = async (id: string) => {
    if (!logins.has(id))
      logins.set(id, (await gh.getUserLogin(token, Number(id))) ?? id);
    return logins.get(id)!;
  };
  for (const [i, claim] of c.history.entries()) {
    if (
      !claim.task_id.startsWith("P") ||
      claim.subtask_id ||
      claim.action !== "claim_encoding" ||
      claim.outcome !== "accepted"
    )
      continue;
    const end = c.history
      .slice(i + 1)
      .find(
        (h) =>
          h.task_id === claim.task_id &&
          !h.subtask_id &&
          h.user_id === claim.user_id &&
          (h.action === "reap" ||
            (h.outcome === "accepted" &&
              (h.action === "submit_encoding" ||
                h.action === "release_encoding"))),
      );
    const user = await login(claim.user_id);
    const last = new Date(end?.timestamp ?? Date.now());
    for (
      let day = new Date(claim.timestamp.slice(0, 10));
      day <= last;
      day.setUTCDate(day.getUTCDate() + 1)
    )
      days.add(`${user} ${day.toISOString().slice(0, 10)}`);
  }
  return days;
}

// ------------------------------------------------------------------- report

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const row = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
const notationRows = (title: string, notes: (PageNotation | string)[]) => [
  row([
    `${title}: measures`,
    ...notes.map((n) => (typeof n === "string" ? n : String(n.measures))),
  ]),
  row([
    `${title}: staff measures with notes / only mRest / only mSpace / empty`,
    ...notes.map((n) =>
      typeof n === "string"
        ? ""
        : `${n.notes} / ${n.mRest} / ${n.mSpace} / ${n.empty}`,
    ),
  ]),
  row([
    `${title}: at the page start`,
    ...notes.map((n) => (typeof n === "string" ? "" : n.start)),
  ]),
  row([
    `${title}: changes on the page`,
    ...notes.map((n) =>
      typeof n === "string" ? "" : n.changes.join("; ") || "none",
    ),
  ]),
];

const campaigns = await Promise.all(args.map(loadCampaign));
const out: string[] = [
  `# Comparison of ${campaigns.map((c) => c.slug).join(" and ")}`,
  "",
  `Generated ${new Date().toISOString()}.`,
  "",
  ...campaigns.map(
    (c) =>
      `- ${c.slug} at ${c.head.slice(0, 7)}: ${c.pieces.map((p) => `${p.id} ${p.preparation ?? "measure-detection"}`).join(", ")}`,
  ),
  "",
];

for (const piece of campaigns[0].pieces) {
  const paths = campaigns.map(
    (c) => c.pieces.find((p) => p.id === piece.id)?.path,
  );
  if (paths.some((p) => !p)) {
    out.push(`## ${piece.id}`, "", "Not in both campaigns.", "");
    continue;
  }
  const states = await Promise.all(
    campaigns.map((c, i) => loadPiece(c, paths[i]!)),
  );
  const truth = states.findIndex((s) => s.named);
  const placed = states.map((s, i) =>
    truth < 0 || s.named ? null : placements(s, states[truth]),
  );
  out.push(`## ${piece.id}`, "");
  for (const [i, s] of states.entries())
    out.push(
      `- Staves of ${campaigns[i].slug}: ` +
        (s.parsed?.scoreDef.staves
          .map((st, k) => `${k + 1} ${st.label || "(no label)"}`)
          .join(", ") ?? "no score"),
    );
  out.push(
    "",
    truth < 0
      ? "Neither campaign names the instruments in its layout task, so the staff placement is not compared."
      : `Staff placement is measured against the instruments named in ${campaigns[truth].slug}.`,
    "",
  );
  const pages = Math.max(...states.map((s) => s.pages.length));
  for (let page = 1; page <= pages; page++) {
    const details: string[] = [];
    const rows = [
      row(["", ...campaigns.map((c) => c.slug)]),
      row(["---", ...campaigns.map(() => "---")]),
      row([
        "Staff boxes",
        ...states.map((s) => String(s.pages[page - 1]?.staves?.length ?? 0)),
      ]),
    ];
    if (truth >= 0)
      rows.push(
        row([
          "Misplaced / on no staff / not matched",
          ...placed.map((p, i) => {
            if (states[i].named) return "named in the layout task";
            const pg = p?.[page - 1];
            if (!pg) return "no recognition record";
            details.push(
              ...pg.misplaced.map((m) => `${campaigns[i].slug}, ${m}`),
            );
            return `${pg.misplaced.length} / ${pg.unplaced} / ${pg.unmatched}`;
          }),
        ]),
      );
    const drafts: (PageNotation | string)[] = [];
    const encoded: (PageNotation | string)[] = [];
    for (const [i, c] of campaigns.entries()) {
      const task = c.tasks.find(
        (t) =>
          !t.subtask_id &&
          t.fragment === paths[i] &&
          t.locator === `surface-${page}`,
      );
      if (!task) {
        drafts.push("no page task");
        encoded.push("no page task");
        continue;
      }
      const commit = await draftCommit(c, task.task_id);
      const draft = commit
        ? await gh.getRepoFile(token, c.owner, c.repo, paths[i]!, commit.sha)
        : null;
      const notation = draft ? pageNotation(draft, page) : null;
      drafts.push(notation ?? `no draft of ${task.task_id}`);
      if (commit)
        details.push(
          `${c.slug}: draft of ${task.task_id} from ${commit.where}, commit ${commit.sha.slice(0, 7)}`,
        );
      const main = accepted(c, task.task_id)
        ? await gh.getRepoFile(token, c.owner, c.repo, paths[i]!, c.head)
        : null;
      encoded.push(
        (main && pageNotation(main, page)) ?? `${task.task_id} not encoded`,
      );
    }
    rows.push(
      ...notationRows("Draft", drafts),
      ...notationRows("Encoded", encoded),
    );
    out.push(
      `### Page ${page}`,
      "",
      ...rows,
      "",
      ...details.map((d) => `- ${d}`),
      ...(details.length ? [""] : []),
    );
  }
}

if (relayDb) {
  const db = new DatabaseSync(relayDb, { readOnly: true });
  const runs = db.prepare(
    "SELECT amount FROM relay_use WHERE login = ? AND day = ? AND kind = 'omr_runs'",
  );
  const days = await Promise.all(campaigns.map(preTaskDays));
  out.push("## Musibot runs", "");
  for (const [i, c] of campaigns.entries()) {
    const lines = [...days[i]].sort().map((d) => {
      const [login, day] = d.split(" ");
      const amount =
        (runs.get(login, day) as { amount: number } | undefined)?.amount ?? 0;
      const shared = days.some((other, j) => j !== i && other.has(d));
      return `  - ${login}, ${day}: ${amount}${shared ? " (a day of the other campaign too)" : ""}`;
    });
    out.push(
      `- ${c.slug}:`,
      ...(lines.length ? lines : ["  - no pre-task claimed"]),
    );
  }
  out.push("");
}

console.log(out.join("\n"));
