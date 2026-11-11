// Commits and branches: the repository head, multi-file commits, and branch
// refs (read, create, fast-forward, list, delete).

import {
  apiRoot,
  authHeaders,
  baseHeaders,
  ghGet,
  ghSend,
  githubFetch,
} from "./request.ts";
import type { ErrorResponse, FileChange, RepoData } from "./shapes.ts";
import { RESOLVE_TTL_MS, memoGet, repoHeadInfoCache } from "./caches.ts";
import { encodeRepoPath } from "./files.ts";

/**
 * Read a repo's default branch, its current head commit SHA and that commit's
 * tree SHA, and whether the authenticated user can push to it (drives the
 * same-repo vs. fork PR path). The tree SHA is what a commit built on this
 * head starts from (`commitFiles`'s `baseTreeSha`).
 */
export async function getRepoHead(
  token: string,
  owner: string,
  repo: string,
): Promise<{ branch: string; sha: string; treeSha: string; canPush: boolean }> {
  // The branch name and push permission are memoised; the head SHA is read
  // fresh on every call — callers rely on it for optimistic concurrency.
  const key = `${owner}/${repo}`;
  let info = memoGet(repoHeadInfoCache, key);
  if (!info) {
    const repoRes = await ghGet<RepoData>(
      `${apiRoot(token)}/repos/${owner}/${repo}`,
      token,
    );
    if (!repoRes.ok)
      throw new Error(
        `${repoRes.data?.message || "Failed to read repository"} (${repoRes.status} GET repo)`,
      );
    info = {
      branch: repoRes.data.default_branch,
      canPush: Boolean(repoRes.data.permissions?.push),
    };
    repoHeadInfoCache.set(key, {
      value: info,
      expires: Date.now() + RESOLVE_TTL_MS,
    });
  }
  // The branch endpoint carries the head commit together with its tree, so
  // one read serves both the optimistic-concurrency parent and the tree a
  // commit on it is built from.
  const branchRes = await ghGet<{
    commit: { sha: string; commit: { tree: { sha: string } } };
    message?: string;
  }>(
    `${apiRoot(token)}/repos/${owner}/${repo}/branches/${encodeRepoPath(info.branch)}`,
    token,
  );
  if (!branchRes.ok)
    throw new Error(
      `${branchRes.data?.message || "Failed to read branch"} (${branchRes.status} GET branches/${info.branch})`,
    );
  const head = branchRes.data.commit;
  return {
    branch: info.branch,
    sha: head.sha,
    treeSha: head.commit.tree.sha,
    canPush: info.canPush,
  };
}

/**
 * Commit several text files to a repo in a single commit via the Git Data API,
 * so files land atomically with one clean diff. `files` is an array of
 * { path, content } with UTF-8 string content. Returns the new commit SHA.
 *
 * Pass `opts.deletePaths` to remove files in the same commit, so a set of files
 * can be replaced by a smaller set without leaving the extra ones behind.
 *
 * Pass `opts.baseSha` to commit on a specific parent: the ref update is
 * non-forced, so if the branch has moved past `baseSha` (a concurrent change)
 * the update fails rather than clobbering it — optimistic concurrency for the
 * tracking tables. Omit it to commit on the current branch head. Pass
 * `opts.branch` to target a branch other than the repo default (e.g. a feature
 * branch being prepared for a pull request).
 *
 * Pass `opts.newBranch` (with `baseSha`) to create that branch at the new
 * commit instead of updating an existing ref — one call replaces the
 * create-branch/fast-forward pair, and no ref exists until the commit does.
 *
 * Binary files are uploaded one at a time, which for images is the long part of
 * the commit; `opts.onUpload` is called after each one with how many of them are
 * done, so a caller can report progress through them.
 * https://docs.github.com/en/rest/git
 */
export async function commitFiles(
  token: string,
  owner: string,
  repo: string,
  files: FileChange[],
  message: string,
  {
    baseSha,
    baseTreeSha,
    branch,
    newBranch,
    replaceBranch = false,
    deletePaths = [],
    onUpload,
  }: {
    baseSha?: string;
    /** The tree of `baseSha`, when already known; saves reading the commit. */
    baseTreeSha?: string;
    branch?: string;
    newBranch?: string;
    /**
     * With `newBranch`: a branch of that name that exists already is moved to
     * the commit (forced) instead of refusing it. The branch keeps its old
     * commit until the new one exists.
     */
    replaceBranch?: boolean;
    deletePaths?: string[];
    onUpload?: (uploaded: number, total: number) => void;
  } = {},
): Promise<string> {
  if (newBranch && !baseSha)
    throw new Error("newBranch requires baseSha (the commit to branch from).");
  if (baseTreeSha && !baseSha)
    throw new Error("baseTreeSha requires baseSha (the commit it belongs to).");
  for (const file of files) {
    const hasText = file.content != null;
    const hasBinary = file.contentBase64 != null;
    if (hasText === hasBinary) {
      throw new Error(
        `File ${file.path} must provide exactly one of content or contentBase64.`,
      );
    }
  }

  const api = `/repos/${owner}/${repo}`;

  // Resolve the target branch and the parent commit to build on. A new
  // branch's parent is always the given baseSha; no ref exists to resolve.
  const targetBranch =
    newBranch ??
    branch ??
    (await ghSend<{ default_branch: string }>("GET", api, token))
      .default_branch;
  let headSha = baseSha;
  if (!headSha) {
    const ref = await ghSend<{ object: { sha: string } }>(
      "GET",
      `${api}/git/ref/heads/${encodeRepoPath(targetBranch)}`,
      token,
    );
    headSha = ref.object.sha;
  }
  const baseTree =
    baseTreeSha ??
    (
      await ghSend<{ tree: { sha: string } }>(
        "GET",
        `${api}/git/commits/${headSha}`,
        token,
      )
    ).tree.sha;

  // Text files go inline in the tree; binary files are uploaded as base64 blobs
  // first (the tree API only accepts text inline) and referenced by SHA. An
  // entry with a null SHA takes its path out of the tree the commit is built on.
  const treeEntries: Array<
    | { path: string; mode: "100644"; type: "blob"; sha: string | null }
    | { path: string; mode: "100644"; type: "blob"; content: string }
  > = [];
  const binaryCount = files.filter((f) => f.contentBase64 != null).length;
  let uploaded = 0;
  for (const f of files) {
    const base = {
      path: f.path,
      mode: "100644" as const,
      type: "blob" as const,
    };
    if (f.contentBase64 != null) {
      const blob = await ghSend<{ sha: string }>(
        "POST",
        `${api}/git/blobs`,
        token,
        {
          content: f.contentBase64,
          encoding: "base64",
        },
      );
      treeEntries.push({ ...base, sha: blob.sha });
      onUpload?.(++uploaded, binaryCount);
      continue;
    }
    treeEntries.push({ ...base, content: f.content ?? "" });
  }
  for (const path of deletePaths) {
    treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
  }

  // Build a tree off the current one, with our files added.
  const tree = await ghSend<{ sha: string }>(
    "POST",
    `${api}/git/trees`,
    token,
    {
      base_tree: baseTree,
      tree: treeEntries,
    },
  );

  const commit = await ghSend<{ sha: string }>(
    "POST",
    `${api}/git/commits`,
    token,
    {
      message,
      tree: tree.sha,
      parents: [headSha],
    },
  );

  if (newBranch && replaceBranch) {
    try {
      await ghSend(
        "PATCH",
        `${api}/git/refs/heads/${encodeRepoPath(newBranch)}`,
        token,
        { sha: commit.sha, force: true },
      );
    } catch (e) {
      if (!/^Reference does not exist /.test((e as Error).message)) throw e;
      await ghSend("POST", `${api}/git/refs`, token, {
        ref: `refs/heads/${newBranch}`,
        sha: commit.sha,
      });
    }
  } else if (newBranch) {
    await ghSend("POST", `${api}/git/refs`, token, {
      ref: `refs/heads/${newBranch}`,
      sha: commit.sha,
    });
  } else {
    await ghSend(
      "PATCH",
      `${api}/git/refs/heads/${encodeRepoPath(targetBranch)}`,
      token,
      {
        sha: commit.sha,
      },
    );
  }

  return commit.sha;
}

/** The commit `branch` points at, or null when there is no such branch. */
export async function getBranchHead(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  const { status, ok, data } = await ghGet<{
    object?: { sha?: string };
    message?: string;
  }>(
    `${apiRoot(token)}/repos/${owner}/${repo}/git/ref/heads/${encodeRepoPath(branch)}`,
    token,
  );
  if (status === 404) return null;
  if (!ok || !data?.object?.sha)
    throw new Error(
      `${data?.message || "Failed to read branch"} (${status} GET ref heads/${branch})`,
    );
  return data.object.sha;
}

/** Create a new branch `branch` pointing at `fromSha`. */
export async function createBranch(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  fromSha: string,
): Promise<void> {
  await ghSend("POST", `/repos/${owner}/${repo}/git/refs`, token, {
    ref: `refs/heads/${branch}`,
    sha: fromSha,
  });
}

/**
 * Point an existing branch at `sha`. Non-forced, so it succeeds only when the
 * move is a fast-forward — a branch carrying its own commits is never rolled
 * back. Returns whether the update was applied.
 */
export async function fastForwardBranch(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  sha: string,
): Promise<boolean> {
  const res = await githubFetch(
    `${apiRoot(token)}/repos/${owner}/${repo}/git/refs/heads/${encodeRepoPath(branch)}`,
    {
      method: "PATCH",
      headers: { ...baseHeaders, ...authHeaders(token) },
      body: JSON.stringify({ sha }),
    },
  );
  if (res.ok) return true;
  const data: ErrorResponse = await res.json().catch(() => ({}));
  if (
    res.status === 409 ||
    (res.status === 422 && /fast.?forward/i.test(data.message ?? ""))
  ) {
    return false;
  }
  throw new Error(
    `${data.message || "Failed to fast-forward branch"} (${res.status} PATCH ref heads/${branch})`,
  );
}

/**
 * The repo's branches whose name passes `keep`, each with the commit time of
 * its head.
 */
export async function listBranchCommitTimes(
  token: string,
  owner: string,
  repo: string,
  keep: (name: string) => boolean,
): Promise<{ name: string; committedAt: string }[]> {
  const root = `${apiRoot(token)}/repos/${owner}/${repo}`;
  const refs = await ghGet<{ ref: string; object: { sha: string } }[]>(
    `${root}/git/matching-refs/heads/`,
    token,
    { cache: false },
  );
  if (!refs.ok) throw new Error(`Failed to list the branches of ${repo}.`);
  const kept = refs.data
    .map(({ ref, object }) => ({
      name: ref.slice("refs/heads/".length),
      sha: object.sha,
    }))
    .filter(({ name }) => keep(name));
  return Promise.all(
    kept.map(async ({ name, sha }) => {
      const commit = await ghGet<{ committer: { date: string } }>(
        `${root}/git/commits/${sha}`,
        token,
      );
      if (!commit.ok) throw new Error(`Failed to read commit ${sha}.`);
      return { name, committedAt: commit.data.committer.date };
    }),
  );
}

/** Delete a branch. An already-gone ref counts as success. */
export async function deleteBranch(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<void> {
  const res = await githubFetch(
    `${apiRoot(token)}/repos/${owner}/${repo}/git/refs/heads/${encodeRepoPath(branch)}`,
    {
      method: "DELETE",
      headers: { ...baseHeaders, ...authHeaders(token) },
    },
  );
  if (res.ok || res.status === 404) return;
  const data: ErrorResponse = await res.json().catch(() => ({}));
  if (
    res.status === 422 &&
    /reference does not exist/i.test(data.message ?? "")
  )
    return;
  throw new Error(
    `${data.message || "Failed to delete branch"} (${res.status} DELETE ref heads/${branch})`,
  );
}
