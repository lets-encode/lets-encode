# OAuth session broker (Flask)

The server-side piece of the SPA's GitHub auth. The OAuth token **never reaches
the browser**: the whole flow runs here, the token is kept in a server-side
session, and the browser holds only an opaque httpOnly session cookie.
The authorization-code exchange sends a PKCE (S256) `code_challenge`, but
GitHub's classic OAuth App token endpoint is not documented to enforce it —
the OAuth `state` parameter is the load-bearing CSRF protection. The exchange
requests the `public_repo` and `notifications` scopes used by repository
mutations and notification muting.

- `GET /login?return_to=/path` — starts the OAuth flow (redirects to GitHub).
- `GET /authorize` — GitHub's callback: exchanges the code, stores the token in
  the session, redirects back to the SPA (`?auth_error=…` on failure).
- `POST /logout` — revokes the token at GitHub and clears the session.
- `/proxy/<url>` — relays the SPA's GitHub API calls (`api.github.com` only),
  attaching the session's token server-side. Login-gated and rate-limited.
  It relays only the endpoints the app calls, and writes only to campaign
  repositories: those GitHub reports as generated from `CAMPAIGN_TEMPLATE`
  and forks of them. The template itself takes `/generate` only.
- `GET /iiif?url=…` — relays IIIF manifests and canvas images for the
  onboarding wizard. Campaign sources come from arbitrary institutions, which
  rules out both a CSP host allowlist and direct browser fetches (many IIIF
  servers send no CORS headers); relaying same-origin solves both. Login-gated
  and rate-limited; no credentials are attached upstream. Each worker relays
  at most `RELAY_SLOTS` requests at once (`RELAY_SLOTS_PER_LOGIN` per login),
  each until its answer is sent, buffers at most `RELAY_BUFFER_BYTES` of
  bodies, and answers 429 beyond either. A download starts no hop and no read
  after `RELAY_DEADLINE_S`, so it ends within that plus the read timeout;
  headers sent a byte at a time can take longer. Each login has a daily
  allowance (see [Relay use](#relay-use)).
- `/omr/api/<path>` and `/omr/blob?url=…` — relay the Musibot OMR service for
  the console's OMR preparation: a fixed set of API endpoints (create page,
  presigned file URLs, start and poll an execution, delete page, list
  pipelines) with the institutional token attached server-side, and file
  transfers to and from the presigned URLs on the service's host. Login-gated
  and rate-limited; answers 503 unless `MUSIBOT_TOKEN` is set. A page is
  relayed only to the login that created it, an execution only on the page it
  was started on. File transfers take the IIIF relay's slots; downloads also
  have its deadline. Each login has daily allowances (see
  [Relay use](#relay-use)).
- `/registry/…` — the campaign name registry blueprint: the name → (forge,
  repo id) mapping behind every campaign address, with the claim/register
  lifecycle around it. Claiming and registering are login-gated; resolving a
  name is public. Routes, lifecycle and admin: `registry.py`.

## The registry's lifecycle

A registry row is in one of three statuses: `pending` (a claim held for a
setup in progress), `active` (a registered campaign) or `tombstoned` (a
retired name that stays occupied). A name is taken in two steps because a
campaign's setup takes a while and the name must be safe for the whole of it:
`POST /registry/claim` holds it against a claim token from the moment the
organiser picks it, and `POST /registry/register` presents that token when the
setup is finished. Registering verifies the repo at GitHub with the session's
token: the caller must hold push permission on the repository the name is
bound to (403 otherwise; an unknown repo or a non-github forge is 404).
Registration happens at the _end_ of setup, not when the
repository is created — a repository is not yet a campaign, and an abandoned
setup must never be published as one. A claim is a short lease: one that
nobody promotes occupies nothing once it has run out (reads report the name
free and the next write drops the row), so there is no sweeper. A claim's
token works only in the session of the login that made it, and one login
holds at most `MAX_PENDING_CLAIMS` (10) claims at a time. A repository is the
campaign of one active name, the one it is named after.

The admin surface is three routes: `GET /registry/admin/slugs` (list
everything), `DELETE /registry/admin/slugs/<name>` (tombstone a name; the row
is kept, so the name stays occupied) and `POST
/registry/admin/slugs/<name>/free` (remove a name's row, so anyone may take
the name).

**`/registry/admin/` must be protected by institutional auth at the reverse
proxy** before requests reach the broker (see `README.md` §6). The
built-in `ADMIN_TOKEN` bearer check is defence in depth and a dev/local
fallback, not the primary control: one shared secret, no rotation, no audit
trail. The routes serve only when `ADMIN_TOKEN` and `ADMIN_ROUTES_ENABLED=1`
are both set; otherwise they answer 503 (fail closed), so a token set for CLI
use alone exposes nothing. Setting the token without the flag logs a warning
at startup.

Sessions are files under `instance/sessions` (gitignored, `0700`), shared
between gunicorn workers on the same host; set `SESSION_DIR` to override. The
session ID is rotated after OAuth login and server-side sessions expire 12
hours after their last request. The GitHub token is stored encrypted with a
key derived from `FLASK_SECRET`, so a changed `FLASK_SECRET` logs everyone
out. There is no limit on the number of session files: expired ones are
removed on a write, at most every ten minutes per worker, and their tokens
are revoked at GitHub. `/login` writes a session file and is limited to 30 requests a minute
per client address.

## Relay use

Each login may use the relays up to an allowance per UTC day, set by
environment variables:

| Variable           | What is counted                               | Default |
| ------------------ | --------------------------------------------- | ------- |
| `IIIF_DAILY_BYTES` | bytes fetched through `/iiif`                 | 20 GiB  |
| `OMR_DAILY_BYTES`  | bytes through `/omr/blob`, in both directions | 10 GiB  |
| `OMR_DAILY_RUNS`   | OMR pipeline runs started through `/omr/api`  | 500     |

Past an allowance the relay answers 429 with `X-Lets-Encode-Limit: daily` and
a `Retry-After` of the seconds to 00:00 UTC; the request that passes it is
completed. The counts are kept per login and day in `instance/relay.db`
(`RELAY_DB_PATH`), which also records the login that created each Musibot
page. Every counted request writes one `relay_use` log line with the login,
what was counted, the amount, and the IIIF host, the transfer's direction or
the OMR page. The totals per day and login:

```sh
sqlite3 instance/relay.db "SELECT day, login, kind, amount FROM relay_use ORDER BY day, login"
```

## Same-origin requirement

The broker **must share the SPA's origin** — the session cookie
(`HttpOnly; Secure; SameSite=Lax`) has to be first-party. Mount it under a path
of the SPA's origin:

- deployed: the reverse proxy passes `/auth/` and `/registry/` to the broker
  (see `README.md` §6),
- development: the Vite dev server proxies `/auth` and `/registry` (see
  `vite.config.js`).

The SPA reaches it via `PUBLIC_BROKER_URL` (default `/auth`) and
`PUBLIC_REGISTRY_URL` (default `/registry`).

## Configure

Environment variables:

| Name                    | Value                                                                                                                                                                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_CLIENT_ID`      | the OAuth app's client id                                                                                                                                                                                                                                                                                |
| `GITHUB_CLIENT_SECRET`  | the OAuth app's client secret (**secret**, only here)                                                                                                                                                                                                                                                    |
| `FLASK_SECRET`          | signs the session cookie (**secret**; e.g. `python3 -c "import secrets; print(secrets.token_hex(32))"`)                                                                                                                                                                                                  |
| `REDIRECT_URL`          | the OAuth callback as the browser reaches it, e.g. `https://your-domain.example/auth/authorize` — required outside development and must match the OAuth app's registered callback                                                                                                                        |
| `FLASK_ENV`             | set to `development` locally to allow the cookie over plain HTTP                                                                                                                                                                                                                                         |
| `SESSION_DIR`           | optional: session file directory                                                                                                                                                                                                                                                                         |
| `CAMPAIGN_TEMPLATE`     | optional: the campaign template repository, `owner/name` (default `lets-encode/campaign-template`); `/proxy` writes only to repositories generated from it and their forks                                                                                                                               |
| `DB_PATH`               | optional: the registry's SQLite file (default `instance/slugs.db`) — the registry's entire state, back it up by copying it                                                                                                                                                                               |
| `ADMIN_TOKEN`           | bearer token for `/registry/admin/` (dev fallback and defence in depth; production gates these routes at the reverse proxy — see `README.md` §6)                                                                                                                                                         |
| `ADMIN_ROUTES_ENABLED`  | set to `1` to serve `/registry/admin/` at all; unless both this and `ADMIN_TOKEN` are set, admin routes answer 503                                                                                                                                                                                       |
| `PROXY_FIX_X_FOR`       | the number of reverse proxies in front (1 behind the institution's reverse proxy); when set, X-Forwarded-For, -Proto and -Host supply the client address the rate limits key on and the host the CSRF guard compares `Origin` with. Leave unset without a trusted proxy — the headers would be spoofable |
| `RATELIMIT_STORAGE_URI` | optional: flask-limiter counter storage (default `memory://`, per worker process — see Deployment notes)                                                                                                                                                                                                 |
| `MUSIBOT_URL`           | optional: the Musibot OMR API the `/omr` relay forwards to (default `https://quest.ms.mff.cuni.cz/musibot/api`)                                                                                                                                                                                          |
| `MUSIBOT_TOKEN`         | the Musibot API token (**secret**, only here); without it `/omr` answers 503 and the OMR preparation cannot run                                                                                                                                                                                          |

The broker loads these from its process environment. The simplest way locally is a
`broker/.env` file (auto-loaded via python-dotenv, and gitignored):

```sh
cp .env.example .env    # then fill in the values
```

Real environment variables take precedence over `.env`, so in production you can
set them through your service manager instead (systemd `EnvironmentFile=`,
container env, …) and skip the file.

## Run

```sh
pip install --require-hashes -r requirements.txt

# development (reads broker/.env; the Vite proxy makes it same-origin)
flask --app app run --port 7777

# deployed (behind the reverse proxy — see README.md §6)
PORT=7777 gunicorn -c gunicorn_config.py wsgi:app
```

`wsgi.py` is a thin shim re-exporting `app`, so service managers can point at the
conventional `wsgi:app` target. `gunicorn_config.py` binds to loopback on
`PORT` (default 7777); each deployed instance runs its own broker on its own
port — production 7777, staging 7778, testing 7779, matching the reverse
proxy's targets (`README.md` §6). Only the proxy needs to reach the bind
address, so it stays on loopback.

## Test

From the repository root, with the broker requirements installed:

```sh
python -m unittest broker.test_app broker.test_registry -v
```

## GitHub API telemetry

The proxy writes one structured `github_api` log entry for every authenticated
GitHub request. It includes the method, endpoint path, status, duration,
GitHub rate-limit bucket, limit, remaining/used counts, reset time and GitHub
request ID. Query strings, request bodies and OAuth tokens are not logged;
the access log (`gunicorn_config.py`) records request paths without their
query strings.

The shared forge client emits the same rate-limit fields in browser developer
tools and GitHub Actions logs. Its in-process counters are available through
`getGitHubRequestTelemetry()` for a browser tab or one coordinator run.
Broker-generated `429` responses carry `X-Lets-Encode-Upstream: broker`, so
they are reported separately from GitHub primary or secondary limits.

## Deployment notes

- **HTTPS is required** — the session cookie is marked `Secure` outside
  development, and the OAuth code travels over this connection. It is the scheme
  the _browser_ used that matters, so TLS terminating at a proxy or appliance in
  front is fine.
- **Trust the forwarded client IP** — behind a proxy every request appears to
  come from that proxy, which would turn the rate limits into one bucket shared
  by all users. Set `PROXY_FIX_X_FOR` to the number of proxies in front (1 for
  the institution's reverse proxy) and the app wraps itself in werkzeug's
  `ProxyFix`; left unset, X-Forwarded-For is not trusted and the per-client
  limits collapse into that single shared bucket. Confirm
  `request.remote_addr` resolves to a real client.
- **Forward the public host** — the CSRF guard compares the browser's `Origin`
  with the request's host. The proxy must send `X-Forwarded-Host` (Apache's
  `mod_proxy` does by default) and `PROXY_FIX_X_FOR` must be set; otherwise the
  host is the proxy's upstream address and every write is answered 403.
- **Rate-limit counters are per worker by default** — the limiter's `memory://`
  storage is in-process, so with gunicorn's 2 workers the effective limits are
  twice the stated ones, and counters reset on restart. Set
  `RATELIMIT_STORAGE_URI` to a shared store (redis/memcached) for exact,
  restart-surviving limits.
- **Nothing may rewrite the session cookie** — the production cookie name uses
  the `__Host-` prefix, which browsers reject outright unless the cookie is
  `Secure`, scoped to `Path=/`, and carries no `Domain` attribute. A proxy that
  rewrites cookies will break login with no error in any log.
- **Keep the secrets only here** — the client secret and `FLASK_SECRET` never
  appear in the SPA build.
- **Bandwidth** — every authenticated GitHub API call is relayed through this
  service; that is the price of keeping the token out of the browser.
  Anonymous reads (the public campaign listing) still go to GitHub directly.

## Provider note

This broker exists because holding the token server-side keeps it out of reach
of any script running in the page. The authorization-code exchange is protected
by the OAuth `state` parameter; a PKCE `code_challenge` is sent alongside it,
though GitHub's OAuth App token endpoint is not documented to enforce it. Auth
remains a provider trait (see `src/lib/forge/config.ts`).
