// Points a campaign repo's automation at a branch of the central repository,
// for testing a feature branch on a test campaign without merging it.
//
// Two files of the campaign's default branch are changed, one commit each:
//   config.yaml                      automation.ref — the coordinator's code
//   .github/workflows/caller.yml     campaign.yml@<ref> — the workflow around it
//                                    (job guard, pointer read, checkout)
// The branch defaults to the one checked out in this repository, the
// workflow ref to the branch. The campaign runs the branch as pushed; local
// commits not on GitHub are reported. To return a campaign to its instance,
// give the instance branch and `main` (caller.yml's ref for every campaign the
// app creates): `... <owner>/<repo> develop main`.
//
// Writing caller.yml needs a token with the `workflow` scope.
//
// Env: GH_TOKEN — a token that can write the campaign repo and its workflows.
// Usage: GH_TOKEN=... node scripts/use-branch.ts <owner>/<repo> [<branch> [<workflow-ref>]]

import { execFileSync } from "node:child_process";

const API = "https://api.github.com";
const CONFIG = "config.yaml";
const CALLER = ".github/workflows/caller.yml";

const token = process.env.GH_TOKEN ?? "";
const [owner, repo] = (process.argv[2] ?? "").split("/");
const git = (...args: string[]): string =>
  execFileSync("git", ["-C", import.meta.dirname, ...args], {
    encoding: "utf8",
  }).trim();
const branch = process.argv[3] ?? git("rev-parse", "--abbrev-ref", "HEAD");
const workflowRef = process.argv[4] ?? branch;
// The refs campaign.yml accepts for automation.ref.
const REF = /^[A-Za-z0-9_./-]+$/;
if (
  !token ||
  !owner ||
  !repo ||
  branch === "HEAD" ||
  ![branch, workflowRef].every((r) => REF.test(r) && !r.includes(".."))
) {
  console.error(
    "Usage: GH_TOKEN=<token> node scripts/use-branch.ts <owner>/<repo> [<branch> [<workflow-ref>]]",
  );
  process.exit(1);
}

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  Authorization: `Bearer ${token}`,
};

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `${method} ${path} failed (${res.status}): ${await res.text()}`,
    );
  }
  return (await res.json()) as T;
}

interface FileInfo {
  sha: string;
  content: string;
}

async function readFile(path: string): Promise<{ sha: string; text: string }> {
  const file = await api<FileInfo>(
    "GET",
    `/repos/${owner}/${repo}/contents/${path}`,
  );
  return {
    sha: file.sha,
    text: Buffer.from(file.content, "base64").toString("utf8"),
  };
}

async function writeFile(
  path: string,
  sha: string,
  text: string,
  message: string,
): Promise<void> {
  await api("PUT", `/repos/${owner}/${repo}/contents/${path}`, {
    message,
    sha,
    content: Buffer.from(text, "utf8").toString("base64"),
  });
}

/** config.yaml with automation.ref set; the ref line is the one inside the `automation:` block. */
function withAutomationRef(yaml: string, ref: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === "automation:");
  if (start < 0) throw new Error(`${CONFIG} has no automation block.`);
  let end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
  if (end < 0) end = lines.length;
  const at = lines.findIndex(
    (l, i) => i > start && i < end && /^\s+ref:/.test(l),
  );
  if (at < 0) throw new Error(`${CONFIG} has no automation.ref.`);
  lines[at] = `  ref: "${ref}"`;
  return lines.join("\n");
}

/** caller.yml with the ref of its campaign.yml call set. */
function withWorkflowRef(yaml: string, ref: string): string {
  const call = /(uses:\s*\S+\/\.github\/workflows\/campaign\.yml@)\S+/;
  if (!call.test(yaml)) throw new Error(`${CALLER} calls no campaign.yml.`);
  return yaml.replace(call, `$1${ref}`);
}

const config = await readFile(CONFIG);
const central = /^\s+central_repository:\s*"?([^"\s]+)"?/m.exec(
  config.text,
)?.[1];
if (!central)
  throw new Error(`${CONFIG} has no automation.central_repository.`);
// Both refs must exist in the central repository; a missing one fails every run.
const heads = new Map<string, string>();
for (const ref of new Set([branch, workflowRef])) {
  const commit = await api<{ sha: string }>(
    "GET",
    `/repos/${central}/commits/${encodeURIComponent(ref)}`,
  ).catch(() => {
    throw new Error(`${central} has no ${ref}; push it first.`);
  });
  heads.set(ref, commit.sha);
}
if (!process.argv[3]) {
  const pushed = heads.get(branch)!;
  const local = git("rev-parse", "HEAD");
  if (pushed !== local)
    console.error(
      `Note: ${central}@${branch} is at ${pushed.slice(0, 7)}, the checkout at ${local.slice(0, 7)}; the campaign runs ${pushed.slice(0, 7)}.`,
    );
}

const caller = await readFile(CALLER);
const changes: [string, { sha: string; text: string }, string, string][] = [
  [
    CONFIG,
    config,
    withAutomationRef(config.text, branch),
    `automation.ref ${branch}`,
  ],
  [
    CALLER,
    caller,
    withWorkflowRef(caller.text, workflowRef),
    `campaign.yml@${workflowRef}`,
  ],
];
for (const [path, file, text, what] of changes) {
  if (text === file.text) {
    console.error(`${path}: already ${what}`);
    continue;
  }
  await writeFile(path, file.sha, text, `Use ${what} of ${central}`);
  console.error(`${path}: ${what}`);
}
