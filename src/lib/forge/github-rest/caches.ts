// Value caches for id resolution and repository head info, and the reset of
// everything read with the session's account.

import { etagCache } from "./request.ts";
import { knownForks } from "./forks.ts";
import type { RepoRef } from "./shapes.ts";

// Value cache for the id→login and id→repo resolvers, on top of ghGet's ETag
// conditional caching (a 304 is free of the rate limit, but still a round trip).
// This memo skips the network entirely for a repeat lookup within TTL_MS. Logins
// and repo names change rarely; the TTL bounds how long a rename stays hidden
// behind a display lookup — acceptable, since these values are display-only.
export const RESOLVE_TTL_MS = 5 * 60_000;
export const loginCache = new Map<number, { value: string; expires: number }>();
export const repoRefCache = new Map<
  number,
  { value: RepoRef; expires: number }
>();
// Default branch + push permission per repo. Both change rarely; the TTL
// bounds how long a change stays hidden. Skips one round trip on every
// getRepoHead call after the first.
export const repoHeadInfoCache = new Map<
  string,
  { value: { branch: string; canPush: boolean }; expires: number }
>();

export function memoGet<K, T>(
  cache: Map<K, { value: T; expires: number }>,
  key: K,
): T | undefined {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (hit) cache.delete(key);
  return undefined;
}

/**
 * Forget what was read with the session's account: response bodies kept for
 * conditional requests, push permissions and forks. Run when the account
 * logs out, so the reads that follow are made afresh.
 */
export function clearRequestCaches(): void {
  etagCache.clear();
  repoHeadInfoCache.clear();
  knownForks.clear();
}
