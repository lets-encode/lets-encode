// Request layer of the GitHub REST adapter: API base and broker routing,
// GET/send helpers with ETag caching and retries, rate-limit and API errors,
// and the request telemetry.

import { sleep } from "../../util.ts";

const API = "https://api.github.com";
/** The website the repos and accounts are shown on. */
export const WEB = "https://github.com";

/**
 * Token sentinel: authenticate via the broker session instead of a bearer
 * token. Requests are sent to the base registered with routeSessionVia() and
 * carry the (same-origin, httpOnly) session cookie; no Authorization header.
 */
export const SESSION = "@session";

let sessionApiBase: string | null = null;

/** Register the broker proxy base (e.g. `/auth/proxy/api.github.com`) that SESSION calls go to. */
export function routeSessionVia(base: string): void {
  sessionApiBase = base;
}

let sessionRejected: (() => void) | null = null;

/**
 * Register the callback run when a SESSION call is answered with 401: the
 * broker session has ended or GitHub no longer accepts its token.
 */
export function onSessionRejected(callback: () => void): void {
  sessionRejected = callback;
}

/**
 * Waits before re-attempting a request the broker's relays refused with a 429
 * other than a daily allowance, in ms, each longer than the last. The relays
 * also refuse while their requests in flight are taken, which a slow upstream
 * holds for up to the relay's deadline plus its read timeout (see
 * broker/app.py), so the waits add up to more than a minute.
 */
export const RELAY_RETRY_WAITS_MS = [
  500, 1000, 2000, 4000, 8000, 15000, 15000, 15000,
];

/** A clock time to the minute ("14:05"), rounded up (never early) or down. */
export const minuteClock = (ms: number, up: boolean): string =>
  new Date(
    (up ? Math.ceil : Math.floor)(ms / 60_000) * 60_000,
  ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Whether an answer through the broker came from the service it reached
 * (`github`, `iiif`, `musibot`), which the broker marks in
 * `X-Lets-Encode-Upstream` on every answer it passes on. Any other answer —
 * the broker's own, marked or not, or one from a proxy in front of it — is
 * the broker's side.
 */
export const fromUpstream = (
  res: { headers: Headers },
  upstream: "github" | "iiif" | "musibot",
): boolean => res.headers.get("x-lets-encode-upstream") === upstream;

/**
 * fetch() for the broker's own endpoints (the registry and the relays): the
 * broker's own 401 means its session has ended, as for a proxied SESSION call.
 * A 401 the relays pass on from a source or service they reach (marked
 * `X-Lets-Encode-Upstream` other than `broker`) does not.
 */
export async function brokerFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, init);
  const upstream = res.headers.get("X-Lets-Encode-Upstream");
  if (res.status === 401 && (!upstream || upstream === "broker"))
    sessionRejected?.();
  return res;
}

export function apiRoot(token?: string): string {
  if (token === SESSION) {
    if (!sessionApiBase)
      throw new Error("SESSION used before routeSessionVia() was called.");
    return sessionApiBase;
  }
  return API;
}

export function authHeaders(token?: string): Record<string, string> {
  return token && token !== SESSION ? { Authorization: `Bearer ${token}` } : {};
}

export const baseHeaders: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

// All GETs pass `cache: 'no-store'`: the API responds with
// `Cache-Control: max-age=60`, which would otherwise let the browser serve a
// stale cached response (e.g. an early 404 right after a ref was created, or
// an open PR that has since closed) to the polls and retries this app relies
// on. In runtimes without an HTTP cache (Node) the option is a no-op.
//
// Freshness is instead kept by conditional requests: ghGet() remembers each
// URL's ETag and sends `If-None-Match` on the next read. An unchanged resource
// answers 304 Not Modified — served from the remembered body, and NOT counted
// against the API rate limit — so repeated reads and "nothing changed yet"
// polls are free. The store lives in the app, not in any HTTP cache, so
// `no-store` still holds and no shared cache is involved.

/**
 * Thrown when GitHub reports the request rate limit is exhausted (HTTP 403/429
 * with no remaining quota). Its message is written for the person using the
 * app and says when to retry; logged out, it also names logging in as the way
 * past the shared anonymous limit.
 */
export class RateLimitError extends Error {
  readonly source: "github" | "broker";
  /** The request carried no credentials, so the per-address anonymous limit applied. */
  readonly anonymous: boolean;
  readonly resource: string | null;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly used: number | null;
  /** Unix epoch seconds when the limit resets, or null if not reported. */
  readonly resetAt: number | null;
  readonly retryAfterSeconds: number | null;
  constructor({
    source,
    anonymous,
    resource,
    limit,
    remaining,
    used,
    resetAt,
    retryAfterSeconds,
  }: {
    source: "github" | "broker";
    anonymous: boolean;
    resource: string | null;
    limit: number | null;
    remaining: number | null;
    used: number | null;
    resetAt: number | null;
    retryAfterSeconds: number | null;
  }) {
    // A reset time is shown to the minute, rounded up so it is never early.
    const when = retryAfterSeconds
      ? `in about ${retryAfterSeconds} seconds`
      : resetAt
        ? `at ${minuteClock(resetAt * 1000, true)}`
        : "later";
    super(
      source === "broker"
        ? `Too many requests were sent in a short time. Try again ${when}.`
        : anonymous
          ? `GitHub allows only a limited number of requests without logging in, and that limit has been reached. Try again ${when}, or log in with GitHub to continue now.`
          : `GitHub's request limit has been reached. Try again ${when}.`,
    );
    this.name = "RateLimitError";
    this.source = source;
    this.anonymous = anonymous;
    this.resource = resource;
    this.limit = limit;
    this.remaining = remaining;
    this.used = used;
    this.resetAt = resetAt;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * A non-2xx answer to a request, with its HTTP status. The message ends in
 * "(status METHOD path)".
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Whether the same request may succeed when it is sent again: GitHub or the
 * broker reported a rate limit, answered with a 5xx, or no answer arrived
 * (fetch rejects with a TypeError).
 */
export const isTransientError = (error: unknown): boolean =>
  error instanceof RateLimitError ||
  error instanceof TypeError ||
  (error instanceof ApiError && error.status >= 500);

export interface GitHubRequestTelemetry {
  total: number;
  conditional: number;
  notModified: number;
  rateLimited: number;
  byMethod: Record<string, number>;
  byResource: Record<string, number>;
  last: {
    request: number;
    method: string;
    endpoint: string;
    status: number | null;
    durationMs: number;
    source: "github" | "broker";
    resource: string | null;
    limit: number | null;
    remaining: number | null;
    used: number | null;
    resetAt: number | null;
    retryAfterSeconds: number | null;
    conditional: boolean;
  } | null;
}

const requestTelemetry: GitHubRequestTelemetry = {
  total: 0,
  conditional: 0,
  notModified: 0,
  rateLimited: 0,
  byMethod: {},
  byResource: {},
  last: null,
};

/** Cumulative GitHub request counters for this browser tab or coordinator run. */
export function getGitHubRequestTelemetry(): GitHubRequestTelemetry {
  return {
    ...requestTelemetry,
    byMethod: { ...requestTelemetry.byMethod },
    byResource: { ...requestTelemetry.byResource },
    last: requestTelemetry.last ? { ...requestTelemetry.last } : null,
  };
}

/** Reset the current process's counters (primarily useful for diagnostics and tests). */
export function resetGitHubRequestTelemetry(): void {
  requestTelemetry.total = 0;
  requestTelemetry.conditional = 0;
  requestTelemetry.notModified = 0;
  requestTelemetry.rateLimited = 0;
  requestTelemetry.byMethod = {};
  requestTelemetry.byResource = {};
  requestTelemetry.last = null;
}

function numberHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw == null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function endpointFrom(input: RequestInfo | URL): string {
  try {
    const path = new URL(String(input), "https://local.invalid").pathname;
    const proxyMarker = "/proxy/api.github.com";
    const proxyIndex = path.indexOf(proxyMarker);
    return proxyIndex >= 0
      ? path.slice(proxyIndex + proxyMarker.length) || "/"
      : path;
  } catch {
    return "(invalid URL)";
  }
}

function recordRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  startedAt: number,
  res: Response | null,
): GitHubRequestTelemetry["last"] {
  const headers = res?.headers ?? new Headers();
  const method = (init?.method ?? "GET").toUpperCase();
  const conditional = new Headers(init?.headers).has("If-None-Match");
  // A request sent to GitHub directly is answered by GitHub.
  const viaBroker =
    sessionApiBase !== null &&
    (input instanceof Request ? input.url : String(input)).startsWith(
      sessionApiBase,
    );
  const source: "github" | "broker" =
    viaBroker && !fromUpstream({ headers }, "github") ? "broker" : "github";
  const resource = headers.get("X-RateLimit-Resource");
  const entry = {
    request: ++requestTelemetry.total,
    method,
    endpoint: endpointFrom(input),
    status: res?.status ?? null,
    durationMs: Date.now() - startedAt,
    source,
    resource,
    limit: numberHeader(headers, "X-RateLimit-Limit"),
    remaining: numberHeader(headers, "X-RateLimit-Remaining"),
    used: numberHeader(headers, "X-RateLimit-Used"),
    resetAt: numberHeader(headers, "X-RateLimit-Reset"),
    retryAfterSeconds: numberHeader(headers, "Retry-After"),
    conditional,
  };
  if (conditional) requestTelemetry.conditional++;
  if (res?.status === 304) requestTelemetry.notModified++;
  requestTelemetry.byMethod[method] =
    (requestTelemetry.byMethod[method] ?? 0) + 1;
  const bucket = resource ?? "unknown";
  requestTelemetry.byResource[bucket] =
    (requestTelemetry.byResource[bucket] ?? 0) + 1;
  requestTelemetry.last = entry;
  if (res == null || res.status >= 400 || source === "broker") {
    console.info("[github-api]", entry);
  }
  return entry;
}

// A `.` or `..` path segment, literal or percent-encoded, with `/` or `\` as
// separator. fetch() resolves these before sending, so a repository value
// interpolated into a path could otherwise move the request to another
// endpoint. The URL parser drops tabs and newlines first, so the test does
// too.
const DOT_SEGMENT = /(^|[/\\])(\.|%2e){1,2}([/\\]|$)/i;

export async function githubFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const path = String(input instanceof Request ? input.url : input)
    .replace(/[\t\n\r]/g, "")
    .split(/[?#]/)[0];
  if (DOT_SEGMENT.test(path)) {
    throw new Error(
      `Refused a request with a dot segment in its path: ${path}`,
    );
  }
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (error) {
    recordRequest(input, init, startedAt, null);
    throw error;
  }
  const telemetry = recordRequest(input, init, startedAt, res);
  const viaSession =
    sessionApiBase !== null &&
    (input instanceof Request ? input.url : String(input)).startsWith(
      sessionApiBase,
    );
  if (res.status === 401 && viaSession) sessionRejected?.();
  if (res.status !== 403 && res.status !== 429) return res;
  const remaining = res.headers.get("X-RateLimit-Remaining");
  const retryAfterHeader = res.headers.get("Retry-After");
  const retryAfter =
    retryAfterHeader == null ? Number.NaN : Number(retryAfterHeader);
  const message = await res
    .clone()
    .text()
    .catch(() => "");
  // Only genuine rate-limit signals classify: HTTP 429, an exhausted quota
  // header, a Retry-After header, or GitHub's rate-limit message. Other 403s
  // (permissions, the broker's CSRF/origin/session rejections) surface
  // through the normal error path with their own message.
  const limited =
    res.status === 429 ||
    remaining === "0" ||
    Number.isFinite(retryAfter) ||
    /secondary rate limit|rate limit exceeded|abuse detection/i.test(message);
  if (!limited) return res;
  requestTelemetry.rateLimited++;
  throw new RateLimitError({
    source: telemetry?.source ?? "github",
    anonymous: !viaSession && !new Headers(init?.headers).has("Authorization"),
    resource: telemetry?.resource ?? null,
    limit: telemetry?.limit ?? null,
    remaining: telemetry?.remaining ?? null,
    used: telemetry?.used ?? null,
    resetAt: telemetry?.resetAt ?? null,
    retryAfterSeconds: telemetry?.retryAfterSeconds ?? null,
  });
}

// ETag store for conditional GETs, keyed by full request URL. Only cacheable
// JSON GETs add entries; it grows with the number of distinct URLs read in a
// session. Never used for responses whose bodies carry short-lived tokens (see
// getRepoFileDownloadUrl / getDirDownloadUrls), which pass `cache: false`.
export const etagCache = new Map<
  string,
  { etag: string; body: string; link: string | null }
>();

/**
 * A GitHub JSON GET with ETag conditional-request caching and rate-limit
 * detection. On 304 the remembered body is returned (status normalised to 200);
 * on a fresh 200 the response ETag and body are stored. Throws RateLimitError
 * when the quota is exhausted, and an ApiError on a 5xx that persists through
 * the repeats (retryingGet). Returns the HTTP status, parsed JSON (null on
 * an empty or non-JSON body), and the pagination `Link` header (remembered
 * alongside the ETag). Pass `cache: false` to skip the ETag store while
 * keeping the rate-limit guard.
 */
export async function ghGet<T>(
  url: string,
  token?: string,
  { cache = true }: { cache?: boolean } = {},
): Promise<{ status: number; ok: boolean; data: T; link: string | null }> {
  const { status, ok, text, link } = await sharedGet(url, token, cache);
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  // The broker's own refusals carry `error` where GitHub's carry `message`;
  // callers read `message`.
  if (!ok && data && typeof data === "object") {
    const body = data as { message?: unknown; error?: unknown };
    if (body.message === undefined && typeof body.error === "string")
      data = { ...body, message: body.error };
  }
  return { status, ok, data: data as T, link };
}

type RawGet = {
  status: number;
  ok: boolean;
  text: string;
  link: string | null;
};

// GETs in flight, keyed by cache mode, token and URL. A GET of a URL that is
// already being read joins that request instead of sending its own.
const getsInFlight = new Map<string, Promise<RawGet>>();

function sharedGet(
  url: string,
  token: string | undefined,
  cache: boolean,
): Promise<RawGet> {
  const key = `${cache}\n${token ?? ""}\n${url}`;
  const pending = getsInFlight.get(key);
  if (pending) return pending;
  const request = rawGet(url, token, cache).finally(() =>
    getsInFlight.delete(key),
  );
  getsInFlight.set(key, request);
  return request;
}

async function rawGet(
  url: string,
  token: string | undefined,
  cache: boolean,
): Promise<RawGet> {
  const cached = cache ? etagCache.get(url) : undefined;
  const headers: Record<string, string> = {
    ...baseHeaders,
    ...authHeaders(token),
  };
  if (cached) headers["If-None-Match"] = cached.etag;
  const res = await retryingGet(() =>
    githubFetch(url, { headers, cache: "no-store" }),
  );
  if (res.status === 304 && cached)
    return { status: 200, ok: true, text: cached.body, link: cached.link };
  const text = await res.text();
  if (res.status >= 500) {
    let detail: { message?: string; error?: string } = {};
    try {
      detail = JSON.parse(text) ?? {};
    } catch {
      // A 5xx body need not be JSON.
    }
    throw new ApiError(
      res.status,
      `${detail.message || detail.error || "GitHub API error"} (${res.status} GET ${endpointFrom(url)})`,
    );
  }
  const etag = res.headers.get("ETag");
  const link = res.headers.get("Link");
  if (cache && res.ok && etag) etagCache.set(url, { etag, body: text, link });
  else if (res.status === 404) etagCache.delete(url);
  return { status: res.status, ok: res.ok, text, link };
}

/** Waits before each repeat of a GET that failed with a 5xx. */
const GET_RETRY_DELAYS_MS = [500, 1500];

// A GET is safe to repeat, so a 5xx is retried after each delay in turn.
async function retryingGet(send: () => Promise<Response>): Promise<Response> {
  let res = await send();
  for (const delayMs of GET_RETRY_DELAYS_MS) {
    if (res.status < 500) break;
    await sleep(delayMs);
    res = await send();
  }
  return res;
}

/**
 * A GitHub JSON request without ETag caching — the write path, plus reads that
 * treat any non-2xx as failure. `path` is API-root-relative (e.g.
 * `/repos/o/r/pulls`); `body` is sent as JSON when given. Throws an ApiError
 * on a non-2xx response, with the body's `message` (or the broker's `error`)
 * suffixed `(status METHOD path)`. Returns the parsed JSON body ({} when empty).
 */
export async function ghSend<T>(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<T> {
  const send = () =>
    githubFetch(`${apiRoot(token)}${path}`, {
      method,
      headers: { ...baseHeaders, ...authHeaders(token) },
      cache: "no-store",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const res = await (method === "GET" ? retryingGet(send) : send());
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data as { message?: string; error?: string };
    throw new ApiError(
      res.status,
      `${detail.message || detail.error || "GitHub API error"} (${res.status} ${method} ${path})`,
    );
  }
  return data as T;
}
