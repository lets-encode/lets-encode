// Copies a campaign into a new campaign repository that differs only in how
// its facsimile pieces are prepared, so two preparations can be compared on
// the same pages, pieces and metadata (compare-campaigns.ts reports on both).
//
// The copy is generated from the source's campaign template and gets, in one
// commit, the source's files as of its default branch:
//   config.yaml             new name, title, repo id and instigator;
//                           `preparation` set on every facsimile piece
//   caller.yml, page images as they are
//   README.md               new title and address
//   sources/<piece>/        a facsimile piece's score with the source's
//                           corrected boxes (below); any other piece's score
//                           as the campaign was created
//   tracking/               fresh tables with the new preparation's task plan
// The page tasks' work, the recognition record (omr.xml) and the tracking
// history are not copied: the copy starts at its pre-tasks.
//
// Corrected boxes: an OMR copy gets the source's layout-corrected.json without
// named instruments, its layout.json, and the measure zones in the score, so
// its layout task opens with the source's boxes. A measure-detection copy
// gets the measure zones. With --fresh-layout, or from a source without
// layout-corrected.json, an OMR copy gets no boxes and its layout task runs
// the layout model. A measure-detection copy needs measure zones in the
// source.
//
// The campaign registry gives the copy its address and is written only from
// a session of the app; the script prints the call that registers the name.
//
// Env: GH_TOKEN — a token that can read the source and create repositories
// under the owner, with the `workflow` scope when the source's caller.yml
// differs from the template's.
// --dry-run <dir> writes the copy's files to <dir> instead, with repo id 0,
// and creates nothing.
//
// Usage: GH_TOKEN=... node scripts/copy-campaign.ts <owner>/<repo> <name> <preparation> [--owner <account>] [--title <title>] [--fresh-layout] [--dry-run <dir>]

import {
  PREPARATIONS,
  buildCommentCsv,
  buildHistoryCsv,
  buildLockCsv,
  buildStateCsv,
  buildTaskCsv,
  type ConfigPiece,
  type PieceSurfaces,
} from "../src/lib/campaign-init.ts";
import {
  COMMENT_PATH,
  CONFIG_PATH,
  HISTORY_PATH,
  LOCK_PATH,
  STATE_PATH,
  TASK_PATH,
  configString,
} from "../src/lib/campaign-tables.ts";
import {
  buildFacsimileMei,
  initialFacsimileModel,
  parseFacsimileMei,
} from "../src/lib/mei-facsimile.ts";
import {
  correctedLayoutJson,
  correctedLayoutPath,
  layoutRecordPath,
  withCorrectedLayout,
} from "../src/lib/omr-layout.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as gh from "../src/lib/forge/github-rest.ts";

// The GitHub client logs every request with console.info, which writes to
// stdout.
console.info = () => {};

const API = "https://api.github.com";
const CALLER = ".github/workflows/caller.yml";

const token = process.env.GH_TOKEN ?? "";
const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const [, value] = args.splice(at, 2);
  if (!value || value.startsWith("--")) {
    console.error(`${name} needs a value.`);
    process.exit(1);
  }
  return value;
};
const freshLayout = args.includes("--fresh-layout");
if (freshLayout) args.splice(args.indexOf("--fresh-layout"), 1);
const ownerOption = option("--owner");
const titleOption = option("--title");
const dryRun = option("--dry-run");
const [source, name, preparation] = args;
const [srcOwner, srcRepo] = (source ?? "").split("/");
if (
  !token ||
  !srcOwner ||
  !srcRepo ||
  !name ||
  !(PREPARATIONS as readonly string[]).includes(preparation ?? "")
) {
  console.error(
    "Usage: GH_TOKEN=<token> node scripts/copy-campaign.ts <owner>/<repo> <name> " +
      `<${PREPARATIONS.join("|")}> [--owner <account>] [--title <title>] [--fresh-layout] [--dry-run <dir>]`,
  );
  process.exit(1);
}

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  Authorization: `Bearer ${token}`,
};

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers });
  if (!res.ok)
    throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as T;
}

/** Every file path of a repository's default branch. */
async function treePaths(owner: string, repo: string): Promise<string[]> {
  const tree = await api<{ tree: { type: string; path: string }[] }>(
    `/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
  );
  return tree.tree.filter((t) => t.type === "blob").map((t) => t.path);
}

/** A file as the commit that first added it holds it. */
async function firstVersion(path: string): Promise<string> {
  // The commits come newest first, a hundred per page.
  let first: { sha: string } | undefined;
  for (let page = 1; ; page++) {
    const commits = await api<{ sha: string }[]>(
      `/repos/${srcOwner}/${srcRepo}/commits?path=${encodeURIComponent(path)}&per_page=100&page=${page}`,
    );
    first = commits.at(-1) ?? first;
    if (commits.length < 100) break;
  }
  const text =
    first && (await gh.getRepoFile(token, srcOwner, srcRepo, path, first.sha));
  if (!text) throw new Error(`Could not read the first version of ${path}.`);
  return text;
}

async function read(path: string): Promise<string | null> {
  return gh.getRepoFile(token, srcOwner, srcRepo, path);
}

/** The pieces of config.yaml, read as configPieces reads them, with the fields the task plan needs. */
function configPieces(yaml: string): ConfigPiece[] {
  const block = /^pieces:[^\S\n]*\n((?:[ \t].*\n?)*)/m.exec(yaml)?.[1] ?? "";
  return block
    .split(/^ {2}- /m)
    .slice(1)
    .map((entry) => ({
      id: configString(entry, "id"),
      kind: configString(entry, "kind"),
      path: configString(entry, "path"),
      preparation: configString(entry, "preparation") || undefined,
      pages: Number(configString(entry, "pages")) || undefined,
      zones: [
        ...entry.matchAll(
          /\{ surface: (\d+), ulx: (\d+), uly: (\d+), lrx: (\d+), lry: (\d+) \}/g,
        ),
      ].map(([, surface, ulx, uly, lrx, lry]) => ({
        surface: Number(surface),
        ulx: Number(ulx),
        uly: Number(uly),
        lrx: Number(lrx),
        lry: Number(lry),
      })),
      header: {
        title: configString(entry, "title"),
        composer: configString(entry, "composer"),
      },
    }));
}

/**
 * config.yaml with `key` set in the block starting at the line `block`
 * (`campaign:`), as configToYaml writes the value.
 */
function withField(
  yaml: string,
  block: string,
  key: string,
  value: string | number,
): string {
  const lines = yaml.split("\n");
  const start = lines.indexOf(block);
  const at = lines.findIndex(
    (l, i) => i > start && new RegExp(`^ {2}${key}:`).test(l),
  );
  if (start < 0 || at < 0) throw new Error(`config.yaml has no ${key}.`);
  lines[at] =
    `  ${key}: ${typeof value === "number" ? value : JSON.stringify(value)}`;
  return lines.join("\n");
}

/** config.yaml with `preparation` set on every facsimile piece. */
function withPreparation(yaml: string): string {
  return yaml
    .replace(/^ {4}preparation: .*\n/gm, "")
    .replace(
      /^( {4}kind: "facsimile"\n)/gm,
      `$1    preparation: ${JSON.stringify(preparation)}\n`,
    );
}

const srcInfo = await api<{
  template_repository: { owner: { login: string }; name: string } | null;
}>(`/repos/${srcOwner}/${srcRepo}`);
const template = srcInfo.template_repository;
if (!template)
  throw new Error(`${source} was not generated from a campaign template.`);
const configYaml = await read(CONFIG_PATH);
if (!configYaml) throw new Error(`${source} has no ${CONFIG_PATH}.`);
const srcName = configString(configYaml, "name");
const title =
  titleOption ?? `${configString(configYaml, "title")} (${preparation})`;
const user = (await gh.getAuthenticatedUser(token))?.user;
if (!user) throw new Error("GH_TOKEN is not accepted by GitHub.");
const owner = ownerOption ?? user.login;
const srcPaths = await treePaths(srcOwner, srcRepo);

// The scores and side files of the copy, piece by piece.
const files: gh.FileChange[] = [];
const surfaces: PieceSurfaces = {};
const pieces = configPieces(configYaml);
for (const piece of pieces) {
  const initial = await firstVersion(piece.path);
  if (piece.kind !== "facsimile") {
    files.push({ path: piece.path, content: initial });
    continue;
  }
  const { headXml, scoreDef } = parseFacsimileMei(initial);
  const main = await read(piece.path);
  if (!main) throw new Error(`${source} has no ${piece.path}.`);
  const parsed = parseFacsimileMei(main);
  const corrected = await read(correctedLayoutPath(piece.path));
  const boxed = parsed.pages.some((pg) => pg.zones.length);
  const pages = corrected
    ? withCorrectedLayout(parsed.pages, corrected)
    : parsed.pages;
  if (preparation === "measure-detection") {
    if (!boxed) throw new Error(`${piece.path} has no measure zones to copy.`);
    files.push({
      path: piece.path,
      content: buildFacsimileMei(
        {
          headXml,
          scoreDef,
          pages: pages.map(({ staves: _s, grandstaves: _g, ...pg }) => pg),
        },
        { withBreaks: true },
      ),
    });
    surfaces[piece.id] = pages.flatMap((pg, i) =>
      pg.zones.length ? [i + 1] : [],
    );
    console.error(`${piece.id}: measure zones copied`);
  } else if (corrected && boxed && !freshLayout) {
    files.push(
      {
        path: piece.path,
        content: buildFacsimileMei(
          { headXml, scoreDef, pages },
          { withBreaks: true, emptyMeasures: true, padZones: true },
        ),
      },
      {
        path: correctedLayoutPath(piece.path),
        content: correctedLayoutJson(
          pages.map((pg) => ({
            ...pg,
            staves: (pg.staves ?? []).map(({ staff: _s, ...box }) => box),
          })),
        ),
      },
    );
    const raw = layoutRecordPath(piece.path);
    const record = srcPaths.includes(raw) ? await read(raw) : null;
    if (record) files.push({ path: raw, content: record });
    console.error(`${piece.id}: corrected layout copied`);
  } else {
    const model = initialFacsimileModel(
      parsed.pages.map(({ image, width, height }) => ({
        image,
        width,
        height,
        measures: [],
      })),
    );
    files.push({
      path: piece.path,
      content: buildFacsimileMei({ ...model, headXml }),
    });
    console.error(`${piece.id}: no boxes, the layout task detects them`);
  }
}

const copied = new Set(files.map((f) => f.path));
for (const path of srcPaths) {
  if (copied.has(path) || path === CONFIG_PATH || path.startsWith("tracking/"))
    continue;
  if (path.startsWith("sources/") && !/\.(jpe?g|png|tiff?|webp)$/i.test(path))
    continue;
  if (path === "README.md") {
    const readme = (await read(path)) ?? "";
    files.push({
      path,
      content: readme
        .replace(/^# .*$/m, `# ${title}`)
        .replace(`/${srcName})`, `/${name})`),
    });
  } else if (path === CALLER) {
    files.push({ path, content: (await read(path)) ?? "" });
  } else {
    const blob = await gh.getRepoFileBytes(token, srcOwner, srcRepo, path);
    if (!blob) throw new Error(`Could not read ${path}.`);
    files.push({
      path,
      contentBase64: Buffer.from(await blob.arrayBuffer()).toString("base64"),
    });
  }
}

const plan = {
  pieces: pieces.map((piece) =>
    piece.kind === "facsimile" ? { ...piece, preparation } : piece,
  ),
  validation: {
    required_validations: Number(
      configString(configYaml, "required_validations"),
    ),
    pass_threshold: Number(configString(configYaml, "pass_threshold")),
  },
};
files.push(
  { path: TASK_PATH, content: buildTaskCsv(plan, surfaces) },
  { path: STATE_PATH, content: buildStateCsv(plan, surfaces) },
  { path: LOCK_PATH, content: buildLockCsv() },
  { path: HISTORY_PATH, content: buildHistoryCsv() },
  { path: COMMENT_PATH, content: buildCommentCsv() },
);
const configFor = (repoId: number): gh.FileChange => {
  let config = withPreparation(configYaml);
  config = withField(config, "campaign:", "name", name);
  config = withField(config, "campaign:", "title", title);
  config = withField(config, "campaign:", "instigator", String(user.id));
  config = withField(config, "campaign:", "repo_id", repoId);
  return { path: CONFIG_PATH, content: config };
};

if (dryRun) {
  for (const file of [...files, configFor(0)]) {
    const target = join(dryRun, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      file.content ?? Buffer.from(file.contentBase64 ?? "", "base64"),
    );
  }
  console.log(`Wrote ${files.length + 1} file(s) to ${dryRun}.`);
  process.exit(0);
}

console.error(
  `Creating ${owner}/${name} from ${template.owner.login}/${template.name}`,
);
const repo = await gh.createRepoFromTemplate(token, {
  templateOwner: template.owner.login,
  templateRepo: template.name,
  owner,
  name,
  description: title.slice(0, 350),
  isPrivate: false,
});
await gh.waitForRepoContents(token, owner, name, CALLER);
files.push(configFor(repo.id));
const kept = new Set([...srcPaths, ...files.map((f) => f.path)]);
const templateOnly = (await treePaths(owner, name)).filter(
  (path) => !kept.has(path),
);
console.error(`Committing ${files.length} file(s)`);
await gh.commitFiles(
  token,
  owner,
  name,
  files,
  `Initialise campaign as a copy of ${source} with ${preparation}`,
  {
    deletePaths: templateOnly,
    onUpload: (done, total) => console.error(`uploaded ${done} of ${total}`),
  },
);
const { names: topics } = await api<{ names: string[] }>(
  `/repos/${srcOwner}/${srcRepo}/topics`,
);
await gh.setRepoTopics(token, owner, name, topics);

console.log(
  `Created ${repo.html_url} (repository id ${repo.id}).\n` +
    `To register the name, open the app signed in as ${owner} and run in the browser console:\n` +
    `await fetch("/registry/register", { method: "POST", headers: { "Content-Type": "application/json" }, ` +
    `body: JSON.stringify({ name: ${JSON.stringify(name)}, repo_id: ${repo.id}, forge: "github" }) }).then((r) => r.status)`,
);
