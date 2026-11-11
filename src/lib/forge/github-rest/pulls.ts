// Pull requests: reading their details, commits and changed files, comments,
// closing, and opening them from a set of file changes.

import {
  RateLimitError,
  apiRoot,
  authHeaders,
  baseHeaders,
  ghGet,
  ghSend,
  githubFetch,
} from "./request.ts";
import type { ErrorResponse, FileChange } from "./shapes.ts";
import { commitFiles, deleteBranch, getRepoHead } from "./commits.ts";
import { ensureFork } from "./forks.ts";

/**
 * The messages of a pull request's commits, oldest first. GitHub lists at
 * most 250 commits of a pull request.
 */
export async function getPullRequestCommitMessages(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<string[]> {
  const messages: string[] = [];
  for (let page = 1; ; page++) {
    const data = await ghSend<unknown>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100&page=${page}`,
      token,
    );
    if (!Array.isArray(data))
      throw new Error("GitHub returned an invalid pull-request commit list.");
    for (const c of data as { commit?: { message?: string } }[])
      messages.push(c.commit?.message ?? "");
    if (data.length < 100) return messages;
  }
}

/** Read the PR fields needed before its complete changed-file list is fetched. */
export async function getPullRequestDetails(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<{
  body: string | null;
  changedFiles: number;
  commits: number;
  createdAt: string;
  state: string;
  headSha: string;
  baseSha: string;
  /** "owner/repo" of the head branch's repo; '' when that repo is gone. */
  headRepo: string;
}> {
  const data = await ghSend<{
    body?: string | null;
    changed_files?: number;
    commits?: number;
    created_at?: string;
    state?: string;
    head?: { sha?: string; repo?: { full_name?: string } | null };
    base?: { sha?: string };
  }>("GET", `/repos/${owner}/${repo}/pulls/${number}`, token);
  return {
    body: data.body ?? null,
    changedFiles: data.changed_files ?? 0,
    commits: data.commits ?? 0,
    createdAt: data.created_at ?? "",
    state: data.state ?? "open",
    headSha: data.head?.sha ?? "",
    baseSha: data.base?.sha ?? "",
    headRepo: data.head?.repo?.full_name ?? "",
  };
}

/**
 * The messages of the commits `head` has beyond `base`, compared in
 * owner/repo; `head` may name a fork's branch as `fork-owner:branch`. Null
 * when either side does not exist.
 */
export async function compareCommitMessages(
  token: string,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<string[] | null> {
  const { status, ok, data } = await ghGet<{
    commits?: { commit?: { message?: string } }[];
    message?: string;
  }>(
    `${apiRoot(token)}/repos/${owner}/${repo}/compare/${base}...${head}`,
    token,
    { cache: false },
  );
  if (status === 404) return null;
  if (!ok)
    throw new Error(data?.message || `Failed to compare ${base}...${head}`);
  return (data?.commits ?? []).map((c) => c.commit?.message ?? "");
}

/** One changed file of a pull request, with its unified-diff patch when GitHub supplies one. */
export interface PullRequestFile {
  filename: string;
  status: string;
  patch?: string;
}

const PR_FILES_PER_PAGE = 100;

async function pullRequestFilesPage(
  token: string,
  owner: string,
  repo: string,
  number: number,
  page: number,
): Promise<PullRequestFile[]> {
  const data = await ghSend<unknown>(
    "GET",
    `/repos/${owner}/${repo}/pulls/${number}/files?per_page=${PR_FILES_PER_PAGE}&page=${page}`,
    token,
  );
  if (!Array.isArray(data))
    throw new Error("GitHub returned an invalid pull-request file list.");
  return (data as PullRequestFile[]).map((f) => ({
    filename: f.filename,
    status: f.status,
    patch: f.patch,
  }));
}

/**
 * List every changed file in a pull request, including each file's unified-diff
 * patch. GitHub paginates this endpoint at 100 files and exposes at most 3,000;
 * a mismatch is rejected so the coordinator never validates a partial view.
 * `firstPage` is the first page, read alongside the pull request itself.
 */
export async function getPullRequestFiles(
  token: string,
  owner: string,
  repo: string,
  number: number,
  expectedChangedFiles: number,
  firstPage: PullRequestFile[],
): Promise<PullRequestFile[]> {
  if (!Number.isInteger(expectedChangedFiles) || expectedChangedFiles < 0) {
    throw new Error("Pull request reported an invalid changed-file count.");
  }
  if (expectedChangedFiles > 3000) {
    throw new Error(
      "Pull request changes more than GitHub’s 3,000-file inspection limit.",
    );
  }

  const pages = Math.max(
    1,
    Math.ceil(expectedChangedFiles / PR_FILES_PER_PAGE),
  );
  const files = [...firstPage];
  for (let page = 2; page <= pages; page++) {
    files.push(
      ...(await pullRequestFilesPage(token, owner, repo, number, page)),
    );
  }
  if (files.length !== expectedChangedFiles) {
    throw new Error(
      `Incomplete pull-request file list: expected ${expectedChangedFiles}, received ${files.length}.`,
    );
  }
  return files;
}

/**
 * The changed files of a single commit whose parent is `baseSha`, or null when
 * the commit has another parent. Such a commit's diff equals the diff of a
 * one-commit pull request from it onto `baseSha`.
 */
async function commitFilesOnBase(
  token: string,
  owner: string,
  repo: string,
  sha: string,
  baseSha: string,
  expectedChangedFiles: number,
): Promise<PullRequestFile[] | null> {
  const data = await ghSend<{
    parents?: Array<{ sha?: string }>;
    files?: PullRequestFile[];
  }>("GET", `/repos/${owner}/${repo}/commits/${sha}`, token);
  if (data.parents?.length !== 1 || data.parents[0].sha !== baseSha)
    return null;
  const files = (data.files ?? []).map((f) => ({
    filename: f.filename,
    status: f.status,
    patch: f.patch,
  }));
  if (files.length !== expectedChangedFiles) {
    throw new Error(
      `Incomplete commit file list: expected ${expectedChangedFiles}, received ${files.length}.`,
    );
  }
  return files;
}

/**
 * A pull request's body, creation time, state, head sha and complete changed-file list. The
 * first page of files is read alongside the pull request itself; the
 * request's changed-file count then says whether further pages follow. When
 * GitHub fails to serve the pull request's diff, a one-commit pull request
 * whose commit sits directly on the base takes its file list from that commit.
 */
export async function getPullRequest(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<{
  body: string | null;
  changedFiles: number;
  commits: number;
  createdAt: string;
  state: string;
  headSha: string;
  baseSha: string;
  files: PullRequestFile[];
}> {
  const [details, firstPage] = await Promise.all([
    getPullRequestDetails(token, owner, repo, number),
    pullRequestFilesPage(token, owner, repo, number, 1).catch((e: unknown) =>
      e instanceof Error ? e : new Error(String(e)),
    ),
  ]);
  if (firstPage instanceof Error) {
    if (firstPage instanceof RateLimitError || details.commits !== 1)
      throw firstPage;
    const files = await commitFilesOnBase(
      token,
      owner,
      repo,
      details.headSha,
      details.baseSha,
      details.changedFiles,
    );
    if (!files) throw firstPage;
    return { ...details, files };
  }
  const files = await getPullRequestFiles(
    token,
    owner,
    repo,
    number,
    details.changedFiles,
    firstPage,
  );
  return { ...details, files };
}

/** One open pull request, as the campaign automation reads it. */
export interface OpenPullRequest {
  number: number;
  created_at: string;
  draft: boolean;
  /** GitHub account type: 'User', 'Bot' or 'Organization'. */
  user: { id: number; login: string; type: string };
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  body: string | null;
}

/** The repository's open pull requests, newest first; 1,000 at most. */
export async function listOpenPullRequests(
  token: string,
  owner: string,
  repo: string,
): Promise<OpenPullRequest[]> {
  const prs: OpenPullRequest[] = [];
  for (let page = 1; page <= 10; page++) {
    const { ok, data } = await ghGet<
      Array<OpenPullRequest> | { message?: string }
    >(
      `${apiRoot(token)}/repos/${owner}/${repo}/pulls?state=open&per_page=100&sort=created&direction=desc&page=${page}`,
      token,
    );
    if (!ok || !Array.isArray(data)) {
      throw new Error(
        (data as { message?: string })?.message ||
          "Failed to list pull requests",
      );
    }
    prs.push(...data);
    if (data.length < 100) break;
  }
  return prs.map((pr) => ({
    number: pr.number,
    created_at: pr.created_at,
    draft: Boolean(pr.draft),
    user: { id: pr.user.id, login: pr.user.login, type: pr.user.type },
    head: {
      sha: pr.head.sha,
      ref: pr.head.ref,
      repo: pr.head.repo ? { full_name: pr.head.repo.full_name } : null,
    },
    body: pr.body ?? null,
  }));
}

/** A pull request's current state: 'open' or 'closed'. */
export async function getPullRequestState(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<string> {
  const { ok, data } = await ghGet<{ state?: string; message?: string }>(
    `${apiRoot(token)}/repos/${owner}/${repo}/pulls/${number}`,
    token,
  );
  if (!ok) throw new Error(data?.message || "Failed to read pull request");
  return data?.state ?? "open";
}

// The account a workflow's GITHUB_TOKEN comments as: the coordinator's.
const ACTIONS_BOT = "github-actions[bot]";

/**
 * The body of the coordinator's most recent comment on a pull request, or
 * null if it has none. Comments by anyone else are skipped: any GitHub user
 * can comment on a public pull request.
 */
export async function getLastIssueComment(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<string | null> {
  // The per-issue comments endpoint serves oldest-first and has no sort
  // parameter: probe page 1, then walk back from the Link header's
  // rel="last". No Link header means page 1 holds every comment.
  type Comment = { body?: string; user?: { login?: string } };
  const url = `${apiRoot(token)}/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`;
  const readPage = async (page: number | null) => {
    const res = await ghGet<Comment[]>(
      page === null ? url : `${url}&page=${page}`,
      token,
    );
    if (!res.ok)
      throw new Error(
        (res.data as unknown as ErrorResponse)?.message ||
          "Failed to read comments",
      );
    return res;
  };
  const newestByBot = (data: Comment[]) =>
    (Array.isArray(data) ? data : [])
      .filter((c) => c.user?.login === ACTIONS_BOT)
      .at(-1)?.body ?? null;
  const probe = await readPage(null);
  const lastPage = Number(
    probe.link?.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/)?.[1] ?? 1,
  );
  for (let page = lastPage; page > 1; page--) {
    const body = newestByBot((await readPage(page)).data);
    if (body !== null) return body;
  }
  return newestByBot(probe.data);
}

/** Close a pull request without merging it. */
export async function closePullRequest(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<void> {
  await ghSend("PATCH", `/repos/${owner}/${repo}/pulls/${number}`, token, {
    state: "closed",
  });
}

/** Post a comment on a pull request and then close it (used to resolve claims). */
export async function commentAndClosePr(
  token: string,
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<void> {
  await ghSend(
    "POST",
    `/repos/${owner}/${repo}/issues/${number}/comments`,
    token,
    { body },
  );
  await closePullRequest(token, owner, repo, number);
}

/**
 * Open a pull request. Returns { number, html_url, headSha } — the head commit
 * SHA is what identifies the workflow run the PR triggers. When a pull request
 * from `head` is open already, that one is returned.
 */
export async function createPullRequest(
  token: string,
  owner: string,
  repo: string,
  {
    title,
    head,
    base,
    body,
  }: { title: string; head: string; base: string; body: string },
): Promise<{
  number: number;
  html_url: string;
  headSha: string;
  createdAt: string;
}> {
  const res = await githubFetch(
    `${apiRoot(token)}/repos/${owner}/${repo}/pulls`,
    {
      method: "POST",
      headers: { ...baseHeaders, ...authHeaders(token) },
      body: JSON.stringify({ title, head, base, body }),
    },
  );
  const data: {
    number: number;
    html_url: string;
    head?: { sha?: string };
    created_at?: string;
    message?: string;
    errors?: Array<{ message?: string }>;
  } = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A 422's `message` is just "Validation Failed" — the actual reason (e.g.
    // "No commits between X and Y") is in the errors array.
    const detail = data.errors
      ?.map((e) => e.message)
      .filter(Boolean)
      .join("; ");
    // The same head opened from another tab or device: that pull request is
    // the one to follow.
    if (
      res.status === 422 &&
      /pull request already exists/i.test(detail ?? "")
    ) {
      const open = await findOpenPullRequest(
        token,
        owner,
        repo,
        head.includes(":") ? head : `${owner}:${head}`,
      );
      if (open) return open;
    }
    throw new Error(
      `${data.message || "Failed to open pull request"}${detail ? `: ${detail}` : ""} (${res.status} POST pulls)`,
    );
  }
  return {
    number: data.number,
    html_url: data.html_url,
    headSha: data.head?.sha ?? "",
    createdAt: data.created_at ?? "",
  };
}

/**
 * Commit `files` onto a fresh branch and open a pull request to `owner/repo`
 * from it — the way the app stands in for a volunteer client (its
 * PR triggers the claim/submission Actions). Returns { number, html_url } plus
 * `head`, the repo and branch the PR's head was created in, so the caller can
 * delete the branch once the PR is resolved.
 *
 * If the user can push to the repo (owner/collaborator) the branch is made in
 * the repo itself. Otherwise the user's fork is used and a cross-repo PR is
 * opened upstream — the real volunteer model. Either way the branch is based on
 * the upstream head, or on `baseSha` when given, so the PR diff is only the
 * change in `files` as long as they were read at that commit.
 */
export async function openChangePr(
  token: string,
  owner: string,
  repo: string,
  {
    branch,
    files,
    message,
    title,
    body,
    baseSha,
  }: {
    branch: string;
    files: FileChange[];
    message: string;
    title: string;
    body: string;
    baseSha?: string;
  },
): Promise<{
  number: number;
  html_url: string;
  headSha: string;
  head: { owner: string; repo: string; branch: string };
}> {
  const head = await getRepoHead(token, owner, repo);
  const { branch: base, canPush } = head;
  const sha = baseSha ?? head.sha;
  const target = canPush
    ? { owner, repo }
    : await ensureFork(token, owner, repo);

  // The commit is built first and the branch created at it in one step; no
  // ref exists until the commit does, so only a failed PR needs cleanup.
  let branchCreated = false;
  try {
    await commitFiles(token, target.owner, target.repo, files, message, {
      baseSha: sha,
      newBranch: branch,
    });
    branchCreated = true;

    const head = canPush ? branch : `${target.owner}:${branch}`;
    const pr = await createPullRequest(token, owner, repo, {
      title,
      head,
      base,
      body,
    });
    return { ...pr, head: { owner: target.owner, repo: target.repo, branch } };
  } catch (error) {
    if (branchCreated) {
      // A pull request whose creation response was lost exists all the
      // same: it is returned, and its branch kept. The branch is deleted
      // only once GitHub shows no pull request from it.
      const opened = await findOpenPullRequest(
        token,
        owner,
        repo,
        `${target.owner}:${branch}`,
      ).catch(() => undefined);
      if (opened)
        return {
          ...opened,
          head: { owner: target.owner, repo: target.repo, branch },
        };
      if (opened === null) {
        try {
          await deleteBranch(token, target.owner, target.repo, branch);
        } catch (cleanupError) {
          console.warn(
            `Could not clean up branch ${target.owner}/${target.repo}:${branch}: ${(cleanupError as Error).message}`,
          );
        }
      }
    }
    throw error;
  }
}

// The open pull request whose head is `head` ("owner:branch"), or null.
async function findOpenPullRequest(
  token: string,
  owner: string,
  repo: string,
  head: string,
): Promise<{
  number: number;
  html_url: string;
  headSha: string;
  createdAt: string;
} | null> {
  const prs = await ghSend<
    Array<{
      number: number;
      html_url: string;
      head?: { sha?: string };
      created_at?: string;
    }>
  >(
    "GET",
    `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(head)}`,
    token,
  );
  const pr = prs[0];
  return pr
    ? {
        number: pr.number,
        html_url: pr.html_url,
        headSha: pr.head?.sha ?? "",
        createdAt: pr.created_at ?? "",
      }
    : null;
}
