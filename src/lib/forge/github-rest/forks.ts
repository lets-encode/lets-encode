// Forks: creating the user's fork, waiting until it is ready, and syncing it
// with the upstream repository.

import { sleep } from "../../util.ts";
import {
  ApiError,
  apiRoot,
  authHeaders,
  baseHeaders,
  ghSend,
  githubFetch,
} from "./request.ts";

// Fork identities already ensured this session, keyed by upstream owner/repo.
// Only the create + readiness poll is skipped for a known fork — the upstream
// sync still runs on every call, since callers create branches at upstream
// commits the fork must contain.
export const knownForks = new Map<
  string,
  { owner: string; repo: string; branch: string }
>();

/**
 * Thrown when GitHub cannot bring a fork's default branch up to date with the
 * campaign because the branch has commits of its own (merge-upstream answers
 * 409). Its message tells the volunteer how to discard them.
 */
export class ForkDivergedError extends Error {
  constructor(fork: string, branch: string) {
    super(
      `Your fork ${fork} has commits of its own on ${branch}, so it cannot take the campaign's latest changes. On GitHub, open the fork, choose "Sync fork" and discard the commits, then try again.`,
    );
    this.name = "ForkDivergedError";
  }
}

// Bring the fork's default branch up to date with the upstream repo.
async function syncFork(
  token: string,
  fork: { owner: string; repo: string; branch: string },
): Promise<void> {
  try {
    await ghSend(
      "POST",
      `/repos/${fork.owner}/${fork.repo}/merge-upstream`,
      token,
      { branch: fork.branch },
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 409)
      throw new ForkDivergedError(`${fork.owner}/${fork.repo}`, fork.branch);
    throw e;
  }
}

/**
 * Ensure the authenticated user has a fork of `owner/repo`, waiting until it's
 * ready (forking is async), and its default branch synced with upstream.
 * Returns the fork's { owner, repo }. Used when a volunteer without push
 * access proposes work — they fork and PR upstream. Throws a
 * ForkDivergedError when the fork's default branch has commits of its own.
 */
export async function ensureFork(
  token: string,
  owner: string,
  repo: string,
  {
    attempts = 20,
    delayMs = 1500,
  }: { attempts?: number; delayMs?: number } = {},
): Promise<{ owner: string; repo: string }> {
  const headers = { ...baseHeaders, ...authHeaders(token) };
  const known = knownForks.get(`${owner}/${repo}`);
  if (known) {
    // A fork deleted or renamed since is looked up again below.
    try {
      await syncFork(token, known);
      return { owner: known.owner, repo: known.repo };
    } catch (e) {
      if (e instanceof ForkDivergedError) throw e;
      knownForks.delete(`${owner}/${repo}`);
    }
  }
  // Only the default branch — the fork doesn't need copies of upstream's
  // in-flight claim branches.
  const data = await ghSend<{ full_name: string; default_branch: string }>(
    "POST",
    `/repos/${owner}/${repo}/forks`,
    token,
    { default_branch_only: true },
  );
  if (!data.full_name?.includes("/") || !data.default_branch) {
    throw new Error("GitHub returned an invalid fork description.");
  }

  const [forkOwner, forkRepo] = data.full_name.split("/");
  // Poll until the fork's default branch ref exists (the fork is populated).
  for (let i = 0; i < attempts; i++) {
    const r = await githubFetch(
      `${apiRoot(token)}/repos/${forkOwner}/${forkRepo}/git/ref/heads/${data.default_branch}`,
      { headers, cache: "no-store" },
    );
    // A 404 means the fork is still being populated; any other failure is
    // reported.
    if (!r.ok && r.status !== 404)
      throw new Error(
        `Fork ${forkOwner}/${forkRepo} could not be read (${r.status}).`,
      );
    if (r.ok) {
      const fork = {
        owner: forkOwner,
        repo: forkRepo,
        branch: data.default_branch,
      };
      await syncFork(token, fork);
      knownForks.set(`${owner}/${repo}`, fork);
      return { owner: forkOwner, repo: forkRepo };
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  throw new Error(`Fork ${forkOwner}/${forkRepo} was not ready in time.`);
}
