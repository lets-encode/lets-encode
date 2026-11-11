// The viewer's task branch `encode-<task_id>`: which repo it lives in, where
// their work on a task stands, the work kept from expired claims, and its
// deletion.

import { parseHistoryCsv, HISTORY_PATH } from "../campaign-tables.ts";
import type { TaskRow } from "../campaign-tables.ts";
import { sideFilesOf } from "../campaign-submit.ts";
import {
  claimPullRequest,
  keptWorkBranch,
  keptWorkSince,
} from "../coordinator-policy.ts";
import type { CommandContext } from "./core.ts";

// Delete the viewer's task branch `encode-<task_id>` — in the campaign repo
// with push access, in their fork otherwise. Non-fatal: a leftover branch is
// deleted by the next claim of the task.
async function deleteTaskBranch(
  ctx: CommandContext,
  task_id: string,
): Promise<void> {
  try {
    const workRepo = await workRepoOf(ctx, task_id);
    await ctx.forge.deleteBranch(
      workRepo.owner,
      workRepo.repo,
      `encode-${task_id}`,
    );
  } catch (e) {
    console.warn(`Could not delete encode-${task_id}: ${(e as Error).message}`);
  }
}

// The head repo of a claim's pull request, per campaign repo id and number.
const claimHeadRepos = new Map<
  string,
  Promise<{ owner: string; repo: string } | null>
>();

// The repo the viewer's task branch `encode-<task_id>` lives in: the repo
// their accepted claim's pull request came from, where the campaign
// automation also looks for it. Without one (or when that repo is gone), the
// campaign repo with push access, their fork otherwise (a repo cannot be
// forked by its owner).
async function workRepoOf(
  ctx: CommandContext,
  task_id: string,
): Promise<{ owner: string; repo: string }> {
  const { forge: f, owner, repo } = ctx;
  const { sha, canPush } = await f.getRepoHead(owner, repo);
  const pr = claimPullRequest(
    parseHistoryCsv(
      (await f.getRepoFile(owner, repo, HISTORY_PATH, sha)) ?? "",
    ),
    task_id,
    ctx.viewer,
  );
  if (pr !== null) {
    const key = `${ctx.repoId}#${pr}`;
    let head = claimHeadRepos.get(key);
    if (!head) {
      head = f.getPullRequestHeadRepo(owner, repo, pr);
      claimHeadRepos.set(key, head);
      head.catch(() => claimHeadRepos.delete(key));
    }
    const found = await head;
    if (found) return found;
  }
  return canPush ? { owner, repo } : f.ensureFork(owner, repo);
}

/** Where a task's files are read from: a repo and the ref within it. */
export interface FileSource {
  owner: string;
  repo: string;
  ref: string;
  /** For the viewer's own task branch, the commit it was read at. */
  sha?: string;
}

// The campaign branch `wip-<task_id>` when history.csv records work kept
// from expired claims of the task since its last accepted submission; null
// otherwise, whether or not the branch exists.
async function keptWorkRef(
  ctx: CommandContext,
  task_id: string,
): Promise<string | null> {
  const { forge: f, owner, repo } = ctx;
  const history = parseHistoryCsv(
    (await f.getRepoFile(owner, repo, HISTORY_PATH)) ?? "",
  );
  return keptWorkSince(history, task_id).length > 0
    ? keptWorkBranch(task_id)
    : null;
}

// Where the viewer's work on a task stands: their task branch
// `encode-<task_id>` when it carries the task's score, else the work kept
// from expired claims (keptWorkRef) when there is any; null when the work
// starts from `main`.
async function workSource(
  ctx: CommandContext,
  task: TaskRow,
): Promise<FileSource | null> {
  const { forge: f, owner, repo } = ctx;
  const workRepo = await workRepoOf(ctx, task.task_id);
  const own = { ...workRepo, ref: `encode-${task.task_id}` };
  const sha = await f.getBranchHead(own.owner, own.repo, own.ref);
  if (
    sha &&
    (await f.getRepoFile(own.owner, own.repo, task.fragment, sha)) != null
  )
    return { ...own, sha };
  const ref = await keptWorkRef(ctx, task.task_id);
  if (ref && (await f.getRepoFile(owner, repo, task.fragment, ref)) != null)
    return { owner, repo, ref };
  return null;
}

// Commit the work kept from the task's expired claims (keptWorkRef) onto
// the viewer's fresh task branch: the score and the side files it carries.
// Returns whether there was any.
async function seedFromKeptWork(
  ctx: CommandContext,
  task: TaskRow,
  workRepo: { owner: string; repo: string },
  ref: string,
): Promise<boolean> {
  const { forge: f, owner, repo } = ctx;
  const kept = await keptWorkRef(ctx, task.task_id);
  if (!kept) return false;
  const paths = [task.fragment, ...sideFilesOf(task)];
  const contents = await Promise.all(
    paths.map((path) => f.getRepoFile(owner, repo, path, kept)),
  );
  const files = paths.flatMap((path, i) =>
    contents[i] == null ? [] : [{ path, content: contents[i]! }],
  );
  if (files.length === 0) return false;
  await f.commitFiles(
    workRepo.owner,
    workRepo.repo,
    files,
    `Let's Encode: continue ${task.task_id} from kept work`,
    { branch: ref },
  );
  return true;
}

export { deleteTaskBranch, seedFromKeptWork, workRepoOf, workSource };
