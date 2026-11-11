// Repositories: id resolution, creation from a template, existence and
// access reads, topics, notification subscription and topic search.

import { sleep } from "../../util.ts";
import {
  apiRoot,
  authHeaders,
  baseHeaders,
  ghGet,
  ghSend,
  githubFetch,
} from "./request.ts";
import type {
  ErrorResponse,
  RepoData,
  RepoRef,
  RepoSummary,
} from "./shapes.ts";
import { RESOLVE_TTL_MS, memoGet, repoRefCache } from "./caches.ts";
import { getRepoFile } from "./files.ts";

/**
 * Resolve a numeric repo id to its current owner/name via `GET /repositories/{id}`
 * — the id is stable across rename/transfer, so this is the authoritative way to
 * reach a repo the app tracks by id. Memoised for RESOLVE_TTL_MS. Returns null if
 * the repo can't be read (deleted, or not visible to this token).
 */
export async function getRepoById(
  token: string | undefined,
  id: number,
): Promise<RepoRef | null> {
  const memo = memoGet(repoRefCache, id);
  if (memo !== undefined) return memo;
  const { status, ok, data } = await ghGet<{
    name?: string;
    owner?: { login?: string };
    message?: string;
  }>(`${apiRoot(token)}/repositories/${id}`, token);
  if (status === 404) return null;
  if (!ok)
    throw new Error(data?.message || `Failed to resolve repository ${id}`);
  const owner = data?.owner?.login;
  const repo = data?.name;
  if (!owner || !repo) return null;
  const ref: RepoRef = { id, owner, repo };
  repoRefCache.set(id, { value: ref, expires: Date.now() + RESOLVE_TTL_MS });
  return ref;
}

/**
 * Create a new repo from a template via the "generate" endpoint.
 * https://docs.github.com/en/rest/repos/repos#create-a-repository-using-a-template
 */
export async function createRepoFromTemplate(
  token: string,
  {
    templateOwner,
    templateRepo,
    name,
    description,
    isPrivate,
    owner,
  }: {
    templateOwner: string;
    templateRepo: string;
    name: string;
    description: string;
    isPrivate: boolean;
    owner: string;
  },
): Promise<RepoData> {
  const res = await githubFetch(
    `${apiRoot(token)}/repos/${templateOwner}/${templateRepo}/generate`,
    {
      method: "POST",
      headers: { ...baseHeaders, ...authHeaders(token) },
      body: JSON.stringify({
        owner, // account/org the new repo is created under
        name,
        description,
        private: isPrivate,
        include_all_branches: false,
      }),
    },
  );
  // An error page from a proxy in front of the broker is not JSON.
  const data: RepoData & { error?: string } = res.ok
    ? await res.json()
    : await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = `${data.message || data.error || "Failed to create repository"} (${res.status})`;
    const detail = Array.isArray(data.errors)
      ? `: ${data.errors.map((e) => e.message || e.code).join(", ")}`
      : "";
    throw new Error(message + detail);
  }
  return data; // includes html_url, full_name, etc.
}

/** Whether a repo named `repo` exists under `owner` (any visibility the token can see). */
export async function repoExists(
  owner: string,
  repo: string,
  token?: string,
): Promise<boolean> {
  const { status, ok, data } = await ghGet<ErrorResponse>(
    `${apiRoot(token)}/repos/${owner}/${repo}`,
    token,
  );
  if (status === 404) return false;
  if (!ok) throw new Error(data?.message || "Failed to check repository name");
  return true;
}

/** A repository's data by owner/name, or null if it doesn't exist (404). */
export async function getRepoInfo(
  token: string,
  owner: string,
  repo: string,
): Promise<RepoData | null> {
  const { status, ok, data } = await ghGet<RepoData>(
    `${apiRoot(token)}/repos/${owner}/${repo}`,
    token,
  );
  if (status === 404) return null;
  if (!ok) throw new Error(data?.message || "Failed to read repository");
  return data;
}

/** Repository visibility and whether the current authenticated user can push. */
export async function getRepoAccess(
  token: string,
  owner: string,
  repo: string,
): Promise<{ isPrivate: boolean; canPush: boolean }> {
  const { ok, data } = await ghGet<RepoData>(
    `${apiRoot(token)}/repos/${owner}/${repo}`,
    token,
  );
  if (!ok) throw new Error(data?.message || "Failed to read repository");
  return {
    isPrivate: Boolean(data?.private),
    canPush: Boolean(data?.permissions?.push),
  };
}

/**
 * Poll until a path appears in the repo, returning its content. The `generate`
 * endpoint returns before the new repo's contents are guaranteed present, so
 * the init commit must wait for them. Throws if the path never appears.
 */
export async function waitForRepoContents(
  token: string,
  owner: string,
  repo: string,
  path: string,
  {
    attempts = 10,
    delayMs = 1000,
  }: { attempts?: number; delayMs?: number } = {},
): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const content = await getRepoFile(token, owner, repo, path);
    if (content !== null) return content;
    await sleep(delayMs);
  }
  throw new Error(
    `Timed out waiting for ${path} to appear in ${owner}/${repo}.`,
  );
}

/** Replace a repo's topics — used to tag repos created through this app. */
export async function setRepoTopics(
  token: string,
  owner: string,
  repo: string,
  names: string[],
): Promise<unknown> {
  return ghSend<unknown>("PUT", `/repos/${owner}/${repo}/topics`, token, {
    names,
  });
}

/**
 * The authenticated user's notification subscription for a repo, or null when
 * they have none set (the default "participating and @mentions" level).
 * `ignored` true means the repo is muted; `subscribed` true means watching.
 */
export async function getRepoSubscription(
  token: string,
  owner: string,
  repo: string,
): Promise<{ subscribed: boolean; ignored: boolean } | null> {
  const { status, ok, data } = await ghGet<{
    subscribed?: boolean;
    ignored?: boolean;
    message?: string;
  }>(`${apiRoot(token)}/repos/${owner}/${repo}/subscription`, token, {
    cache: false,
  });
  if (status === 404) return null;
  if (!ok)
    throw new Error(data?.message || "Failed to read repository subscription");
  return {
    subscribed: Boolean(data?.subscribed),
    ignored: Boolean(data?.ignored),
  };
}

/**
 * Set the authenticated user's subscription for a repo to "ignored": no web or
 * email notifications from it, including participating threads (own PRs,
 * mentions). Requires the OAuth 'notifications' scope; affects only the token's
 * own user.
 */
export async function ignoreRepoNotifications(
  token: string,
  owner: string,
  repo: string,
): Promise<void> {
  await ghSend("PUT", `/repos/${owner}/${repo}/subscription`, token, {
    subscribed: false,
    ignored: true,
  });
}

/**
 * List repos tagged with `topic`. With the user's `repo`-scoped token, GitHub's
 * search returns matching public repos plus the user's own private matches.
 * Visibility always reflects GitHub's current state.
 */
export async function searchReposByTopic(
  topic: string,
  token?: string,
): Promise<{ repos: RepoSummary[]; incomplete: boolean }> {
  const q = encodeURIComponent(`topic:${topic}`);
  type SearchItem = {
    id: number;
    full_name: string;
    name: string;
    owner?: { login: string };
    html_url: string;
    private: boolean;
    description: string | null;
    updated_at: string;
    created_at: string;
  };
  const items: SearchItem[] = [];
  // A search GitHub stopped before it was done reports incomplete_results.
  let incomplete = false;
  // The search API pages at 100 results and serves at most 1,000 (10 pages).
  for (let page = 1; page <= 10; page++) {
    const { ok, data } = await ghGet<{
      items?: SearchItem[];
      incomplete_results?: boolean;
      message?: string;
    }>(
      `${apiRoot(token)}/search/repositories?q=${q}&sort=updated&order=desc&per_page=100&page=${page}`,
      token,
    );
    if (!ok) throw new Error(data?.message || "Repo search failed");
    if (data?.incomplete_results) incomplete = true;
    const batch = data?.items ?? [];
    items.push(...batch);
    if (batch.length < 100) break;
  }
  const repos = items.map((r) => ({
    id: r.id,
    full_name: r.full_name,
    name: r.name,
    owner: r.owner?.login,
    html_url: r.html_url,
    private: r.private,
    description: r.description,
    updated_at: r.updated_at,
    created_at: r.created_at,
  }));
  return { repos, incomplete };
}
