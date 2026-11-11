// User accounts: the authenticated user, id-to-login resolution and
// collaborator permissions.

import {
  ApiError,
  apiRoot,
  authHeaders,
  baseHeaders,
  ghGet,
  githubFetch,
} from "./request.ts";
import type { GitHubUser } from "./shapes.ts";
import { RESOLVE_TTL_MS, loginCache, memoGet } from "./caches.ts";

/**
 * Fetch the authenticated user along with the scopes the token actually holds.
 * `X-OAuth-Scopes` is the live source of truth for what the token can do.
 * Returns null if invalid.
 */
export async function getAuthenticatedUser(
  token: string,
): Promise<{ user: GitHubUser; scopes: string } | null> {
  const res = await githubFetch(`${apiRoot(token)}/user`, {
    headers: { ...baseHeaders, ...authHeaders(token) },
    cache: "no-store",
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  const user: GitHubUser = await res.json();
  const scopes = res.headers.get("X-OAuth-Scopes") ?? "";
  return { user, scopes };
}

/**
 * Resolve a numeric account id to its current login (username). Used to display
 * the people referenced by the tracking tables, which store the stable numeric
 * id. Memoised for RESOLVE_TTL_MS. Returns null if the account can't be read.
 */
export async function getUserLogin(
  token: string | undefined,
  id: number,
): Promise<string | null> {
  const memo = memoGet(loginCache, id);
  if (memo !== undefined) return memo;
  const { status, ok, data } = await ghGet<{
    login?: string;
    message?: string;
  }>(`${apiRoot(token)}/user/${id}`, token);
  if (status === 404) return null;
  if (!ok) throw new Error(data?.message || `Failed to resolve user ${id}`);
  const login = data?.login ?? null;
  if (login)
    loginCache.set(id, { value: login, expires: Date.now() + RESOLVE_TTL_MS });
  return login;
}

/**
 * Whether `username` can push to the repo, via the collaborator-permission
 * lookup. Returns false when the user is not a collaborator or does not
 * exist (404); throws when the lookup fails otherwise.
 */
export async function getCollaboratorCanPush(
  token: string,
  owner: string,
  repo: string,
  username: string,
): Promise<boolean> {
  const { status, ok, data } = await ghGet<{
    permission?: string;
    message?: string;
  }>(
    `${apiRoot(token)}/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}/permission`,
    token,
  );
  if (status === 404) return false;
  if (!ok)
    throw new ApiError(
      status,
      `${data?.message || "Failed to read the collaborator permission"} (${status} GET collaborators/${username}/permission)`,
    );
  return data?.permission === "admin" || data?.permission === "write";
}
