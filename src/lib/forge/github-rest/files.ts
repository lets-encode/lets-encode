// Repository file reads: single files, the batched read of the same files
// from several repositories, raw bytes and temporary download URLs.

import {
  RateLimitError,
  apiRoot,
  authHeaders,
  baseHeaders,
  ghGet,
  ghSend,
  githubFetch,
} from "./request.ts";
import type { ErrorResponse } from "./shapes.ts";

// Decode GitHub's base64 file content to a UTF-8 string without Node's Buffer, so
// this runs in the browser too. GitHub wraps the base64 in newlines — strip
// whitespace before decoding.
function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// A repo-relative path as a URL path: each segment percent-encoded, the
// separators kept, so a %, ? or # in a file name stays part of the path.
export function encodeRepoPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * Fetch and decode a UTF-8 text file from a repo. Returns the file's content as
 * a string, or null if it doesn't exist yet (404) or, with `maxBytes`, is
 * larger than that; the size is read before the content is downloaded.
 */
export async function getRepoFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
  maxBytes?: number,
): Promise<string | null> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const { status, ok, data } = await ghGet<
    | { content?: string; encoding?: string; size?: number; message?: string }
    | Array<unknown>
  >(
    `${apiRoot(token)}/repos/${owner}/${repo}/contents/${encodeRepoPath(path)}${query}`,
    token,
  );
  if (status === 404) return null;
  if (Array.isArray(data))
    throw new Error(`Failed to fetch ${path}: the path is a directory`);
  if (!ok) throw new Error(data?.message || `Failed to fetch ${path}`);
  if (maxBytes !== undefined && (data?.size ?? 0) > maxBytes) return null;
  if (data?.encoding === "base64" && data.content != null)
    return decodeBase64Utf8(data.content);
  // Files over the Contents API's 1 MB inline limit come back with
  // `encoding: "none"` and no content; read the bytes via the raw media type.
  const blob = await getRepoFileBytes(token, owner, repo, path, ref);
  if (blob === null)
    throw new Error(`Failed to fetch ${path}: content unavailable`);
  return await blob.text();
}

/** Text files of one repo, read at its default branch's head commit. */
export interface RepoFiles {
  /** The head commit the files were read at; '' for a repo without commits. */
  headSha: string;
  isPrivate: boolean;
  /** Whether the authenticated user can push to the repo. */
  canPush: boolean;
  /** Each requested path's text; null where the file does not exist. */
  files: Record<string, string | null>;
}

/** The repository permissions that include pushing. */
const PUSH_PERMISSIONS = new Set(["ADMIN", "MAINTAIN", "WRITE"]);

/** Repos per GraphQL query in getRepoFilesBatch. */
const FILES_BATCH_SIZE = 20;

/**
 * Read the same text files from several repos, each at its default branch's
 * head commit, with one GraphQL query per FILES_BATCH_SIZE repos. The result
 * follows the order of `repos`; a repo that does not exist or cannot be read
 * is null. GraphQL requires a token, so an anonymous call returns null.
 */
export async function getRepoFilesBatch(
  token: string,
  repos: Array<{ owner: string; repo: string }>,
  paths: string[],
): Promise<Array<RepoFiles | null> | null> {
  if (!token) return null;
  const out: Array<RepoFiles | null> = [];
  for (let start = 0; start < repos.length; start += FILES_BATCH_SIZE)
    out.push(
      ...(await repoFilesQuery(
        token,
        repos.slice(start, start + FILES_BATCH_SIZE),
        paths,
      )),
    );
  return out;
}

type BlobNode = { text?: string | null; isTruncated?: boolean } | null;
type CommitNode = { oid?: string } & Record<
  string,
  { object: BlobNode } | string | null | undefined
>;

async function repoFilesQuery(
  token: string,
  repos: Array<{ owner: string; repo: string }>,
  paths: string[],
): Promise<Array<RepoFiles | null>> {
  // Owners, names and paths go in as variables, never into the document.
  const variables: Record<string, string> = {};
  const declarations: string[] = [];
  paths.forEach((path, j) => {
    variables[`p${j}`] = path;
    declarations.push(`$p${j}: String!`);
  });
  const fileFields = paths
    .map(
      (_, j) =>
        `f${j}: file(path: $p${j}) { object { ... on Blob { text isTruncated } } }`,
    )
    .join(" ");
  const repoFields = repos.map(({ owner, repo }, i) => {
    variables[`o${i}`] = owner;
    variables[`n${i}`] = repo;
    declarations.push(`$o${i}: String!`, `$n${i}: String!`);
    return `r${i}: repository(owner: $o${i}, name: $n${i}) { isPrivate viewerPermission defaultBranchRef { target { ... on Commit { oid ${fileFields} } } } }`;
  });
  const query = `query(${declarations.join(", ")}) { ${repoFields.join(" ")} }`;
  const res = await ghSend<{
    data?: Record<
      string,
      {
        isPrivate: boolean;
        viewerPermission: string | null;
        defaultBranchRef: { target: CommitNode | null } | null;
      } | null
    > | null;
    errors?: Array<{
      type?: string;
      message?: string;
      path?: Array<string | number>;
    }>;
  }>("POST", "/graphql", token, { query, variables });
  if (res.errors?.some((e) => e.type === "RATE_LIMITED"))
    throw new RateLimitError({
      source: "github",
      anonymous: false,
      resource: "graphql",
      limit: null,
      remaining: null,
      used: null,
      resetAt: null,
      retryAfterSeconds: null,
    });
  const data = res.data;
  if (!data)
    throw new Error(res.errors?.[0]?.message || "GraphQL query failed");
  // A repository GitHub does not show, or will not show to this account,
  // comes back as null with an error on its own field: that repository reads
  // as unreadable. An error deeper in a repository, or with no path, leaves a
  // field null that is not absent, so the whole read fails rather than report
  // a missing file.
  const failure = res.errors?.find((e) => e.path?.length !== 1);
  if (failure) throw new Error(failure.message || "GraphQL query failed");
  return Promise.all(
    repos.map(async ({ owner, repo }, i) => {
      const found = data[`r${i}`];
      if (!found) return null;
      const commit = found.defaultBranchRef?.target;
      const headSha = commit?.oid ?? "";
      const files: Record<string, string | null> = {};
      await Promise.all(
        paths.map(async (path, j) => {
          const entry = commit?.[`f${j}`];
          const blob = typeof entry === "object" ? entry?.object : null;
          if (!blob) files[path] = null;
          // A binary or large blob comes without its full text.
          else if (blob.text != null && !blob.isTruncated)
            files[path] = blob.text;
          else
            files[path] = await getRepoFile(token, owner, repo, path, headSha);
        }),
      );
      return {
        headSha,
        isPrivate: found.isPrivate,
        canPush: PUSH_PERMISSIONS.has(found.viewerPermission ?? ""),
        files,
      };
    }),
  );
}

/**
 * A repo file's bytes, read through the API rather than from a download URL, so
 * the request goes to a host the browser is allowed to connect to and carries
 * the session's credentials. The `raw` media type returns the file inline for
 * anything up to 100 MB. Returns null if the path or ref is absent.
 */
export async function getRepoFileBytes(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<Blob | null> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const res = await githubFetch(
    `${apiRoot(token)}/repos/${owner}/${repo}/contents/${encodeRepoPath(path)}${query}`,
    {
      headers: {
        ...baseHeaders,
        ...authHeaders(token),
        Accept: "application/vnd.github.raw",
      },
      cache: "no-store",
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch ${path} (${res.status})`);
  return await res.blob();
}

/**
 * Get a temporary direct-download URL for a repo file (the Contents API's
 * `download_url`). For PRIVATE repos this is a raw.githubusercontent.com URL
 * with a short-lived `token` embedded, so it can be fetched without auth headers
 * — e.g. handed to an external viewer like mei-friend via `?file=`. The token
 * expires within minutes, so use it promptly. Returns null if absent.
 */
export async function getRepoFileDownloadUrl(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<string | null> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  // Not ETag-cached: for private repos the download_url carries a short-lived
  // token, so a 304-served body would hand back an expired URL.
  const { status, ok, data } = await ghGet<{
    download_url?: string | null;
    message?: string;
  }>(
    `${apiRoot(token)}/repos/${owner}/${repo}/contents/${encodeRepoPath(path)}${query}`,
    token,
    { cache: false },
  );
  if (status === 404) {
    console.log("[getRepoFileDownloadUrl] path or ref absent", {
      owner,
      repo,
      path,
      ref,
    });
    return null;
  }
  if (!ok) throw new Error(data?.message || `Failed to fetch ${path}`);
  console.log("[getRepoFileDownloadUrl] temporary URL available", {
    path,
    ref: ref ?? "(default)",
    status,
  });
  return data?.download_url ?? null;
}

/**
 * List a repo directory's files with each file's temporary download URL, in a
 * single Contents API call — so a facsimile's page images resolve with one
 * request instead of one per image. URLs are tokenised for private repos (see
 * getRepoFileDownloadUrl); use them promptly. Returns a map of file name →
 * download URL (files without one are omitted); empty if the directory is
 * absent.
 */
export async function getDirDownloadUrls(
  token: string,
  owner: string,
  repo: string,
  dir: string,
  ref?: string,
): Promise<Record<string, string>> {
  const cleanDir = dir.replace(/\/+$/, "");
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  // Not ETag-cached: the per-file download_url values carry short-lived tokens.
  const { status, ok, data } = await ghGet<
    Array<{ name: string; download_url?: string | null }> & ErrorResponse
  >(
    `${apiRoot(token)}/repos/${owner}/${repo}/contents/${encodeRepoPath(cleanDir)}${query}`,
    token,
    { cache: false },
  );
  if (status === 404) return {};
  if (!ok) throw new Error(data?.message || `Failed to list ${dir}`);
  const urls: Record<string, string> = {};
  for (const file of Array.isArray(data) ? data : []) {
    if (file.download_url) urls[file.name] = file.download_url;
  }
  return urls;
}
