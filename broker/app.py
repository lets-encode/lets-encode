"""
OAuth session broker for the instigation SPA (Flask).

The full OAuth flow runs server-side (/login -> GitHub -> /authorize), the
token is stored in a server-side session, and the browser holds only an opaque
httpOnly session cookie. All authenticated GitHub API traffic from the SPA
flows through /proxy/<url>, which attaches the token from the session.

The broker must be served under the SAME origin as the SPA (mounted at /auth by
the reverse proxy in production, or by the Vite dev proxy) so the session cookie
is first-party and CORS never comes into play.

Config (environment variables, loaded from broker/.env if present):
  GITHUB_CLIENT_ID       the OAuth app's client id
  GITHUB_CLIENT_SECRET   the OAuth app's client secret (secret; only here)
  FLASK_SECRET           key that signs the session cookie (secret; generate one)
  REDIRECT_URL           the OAuth callback as the browser reaches it, e.g.
                         https://your-domain.example/auth/authorize
  SESSION_DIR            where session files live (default: instance/sessions)
  FLASK_ENV              set to "development" to allow the cookie over plain HTTP
  PROXY_FIX_X_FOR        number of reverse proxies in front of the broker; when
                         set, X-Forwarded-For, -Proto and -Host (that many hops
                         deep) supply the client address the rate limits key on
                         and the host the CSRF guard compares Origin with
                         (default: unset, headers not trusted)
  RATELIMIT_STORAGE_URI  flask-limiter counter storage (default: memory://,
                         which keeps counters per worker process)
  MUSIBOT_URL            the Musibot OMR API the /omr relay forwards to
                         (default: https://quest.ms.mff.cuni.cz/musibot/api)
  MUSIBOT_TOKEN          the Musibot API token (secret; only here). Unset,
                         the /omr relay answers 503.
  RELAY_DB_PATH          the relays' database: daily use per login and the
                         creators of Musibot pages (default:
                         instance/relay.db)
  IIIF_DAILY_BYTES       bytes one login may fetch through /iiif per UTC day
                         (default: 20 GiB)
  OMR_DAILY_BYTES        bytes one login may transfer through /omr/blob per
                         UTC day, both directions together (default: 10 GiB)
  OMR_DAILY_RUNS         OMR pipeline runs one login may start per UTC day
                         (default: 500)
  CAMPAIGN_TEMPLATE      the campaign template repository, owner/name; /proxy
                         writes only to repositories generated from it and
                         to forks of those (default:
                         lets-encode/campaign-template)

See README.md for setup, and the repository README §6 for the deployed mount.
"""

import base64
import functools
import ipaddress
import json
import logging
import re
import socket
import struct
import sys
import threading
import time
from datetime import timedelta
from os import getenv, makedirs, chmod, path, remove
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

import requests
import urllib3
from authlib.integrations.flask_client import OAuth
from cachelib.file import FileSystemCache
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from dotenv import load_dotenv
from flask import Flask, g, jsonify, redirect, request, session
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_session import Session
from werkzeug.middleware.proxy_fix import ProxyFix

# Load broker/.env (next to this file) into the environment — found regardless of
# the working directory flask/gunicorn is launched from. Real environment
# variables take precedence, so production can set them via the service manager.
load_dotenv(Path(__file__).with_name(".env"))

app = Flask(__name__)
# Without a level of its own the logger takes the root logger's WARNING, which
# drops the github_api and relay_use lines below.
app.logger.setLevel(logging.INFO)
development = getenv("FLASK_ENV") == "development"
app.secret_key = getenv("FLASK_SECRET")
if not app.secret_key:
    sys.exit(
        "FLASK_SECRET is not set; refusing to start with unsigned sessions."
    )
if not development and not getenv("REDIRECT_URL"):
    sys.exit(
        "REDIRECT_URL is not set; production OAuth callbacks must be explicit."
    )
if not getenv("GITHUB_CLIENT_ID") or not getenv("GITHUB_CLIENT_SECRET"):
    sys.exit("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must both be set.")

# Server-side sessions: session data (including the GitHub OAuth token) is kept
# on the server; the browser only holds an opaque session ID. With Flask's
# default client-side sessions the cookie itself would contain the token in
# base64-readable (signed, but not encrypted) form.
# The filesystem cache is shared between gunicorn workers on the same host and
# lives in the (gitignored, never-served) Flask instance folder by default, so
# sessions survive restarts and deployments without external setup. Set
# SESSION_DIR to override. No fallback on failure: refusing to start is better
# than silently landing somewhere volatile and losing all sessions later.
session_dir = getenv("SESSION_DIR") or path.join(app.instance_path, "sessions")
try:
    makedirs(session_dir, mode=0o700, exist_ok=True)
    if not getenv("SESSION_DIR"):
        # session files contain OAuth tokens: keep the default directory
        # private to the service user (an explicit SESSION_DIR is presumed
        # provisioned with intentional permissions, so leave those alone)
        chmod(session_dir, 0o700)
except OSError as e:
    sys.exit("Cannot create session directory {}: {}".format(session_dir, e))


class SessionFiles(FileSystemCache):
    """
    Session files without a file limit: on a write, expired files are removed
    instead, at most every SWEEP_S seconds per process, and the GitHub tokens
    they hold are revoked. Past cachelib's own limit the live sessions that
    expire soonest are removed, which logs their users out. A session without
    a GitHub token, as /login starts one, holds only the OAuth round trip and
    is kept PRELOGIN_S at most.

    The GitHub token is stored encrypted with a key derived from `secret`, so
    the files alone do not yield working tokens. A token that does not
    decrypt with the current key is left out of the session read.
    """

    SWEEP_S = 600
    PRELOGIN_S = 900

    def __init__(self, cache_dir, secret):
        super().__init__(cache_dir=cache_dir, threshold=0)
        self._next_sweep = 0.0
        key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=b"lets-encode session token",
        ).derive(secret.encode())
        self._cipher = Fernet(base64.urlsafe_b64encode(key))

    def set(self, key, value, timeout=None, mgmt_element=False):
        if isinstance(value, dict):
            if "githubToken" in value:
                sealed = self._cipher.encrypt(value["githubToken"].encode())
                value = {**value, "githubToken": sealed.decode()}
            else:
                timeout = min(timeout or self.PRELOGIN_S, self.PRELOGIN_S)
        return super().set(key, value, timeout, mgmt_element)

    def get(self, key):
        return self._opened(super().get(key))

    def _opened(self, value):
        if not (isinstance(value, dict) and "githubToken" in value):
            return value
        opened = dict(value)
        try:
            opened["githubToken"] = self._cipher.decrypt(
                str(value["githubToken"]).encode()
            ).decode()
        except InvalidToken:
            del opened["githubToken"]
        return opened

    def _prune(self):
        now = time.time()
        if now >= self._next_sweep:
            self._next_sweep = now + self.SWEEP_S
            self._remove_expired(now)

    def _remove_expired(self, now):
        # The process that removes a file revokes its token, so two processes
        # sweeping at once revoke it once.
        tokens = []
        for fname in self._list_dir():
            try:
                with self._safe_stream_open(fname, "rb") as f:
                    expires = struct.unpack("I", f.read(4))[0]
                    if expires == 0 or expires >= now:
                        continue
                    value = self.serializer.load(f)
                remove(fname)
                self._update_count(delta=-1)
            except FileNotFoundError:
                continue
            except (OSError, EOFError, struct.error):
                app.logger.warning(
                    "Cannot read session file '%s'", fname, exc_info=True
                )
                continue
            opened = self._opened(value)
            if isinstance(opened, dict) and opened.get("githubToken"):
                tokens.append(opened["githubToken"])
        if tokens:
            threading.Thread(
                target=revoke_github_tokens, args=(tokens,), daemon=True
            ).start()


app.config["SESSION_TYPE"] = "cachelib"
app.config["SESSION_CACHELIB"] = SessionFiles(session_dir, app.secret_key)
# Session cookie hygiene. Secure requires HTTPS, so switch it off for local
# development by setting FLASK_ENV=development.
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = not development
app.config["SESSION_COOKIE_NAME"] = (
    "lets_encode_session" if development else "__Host-lets_encode_session"
)
app.config["SESSION_COOKIE_PATH"] = "/"
app.config["SESSION_PERMANENT"] = False
# A stored session expires PERMANENT_SESSION_LIFETIME after the last request
# that carried it: every request rewrites it with a fresh expiry. The SPA
# relies on this to keep an open app logged in.
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=12)
app.config["SESSION_REFRESH_EACH_REQUEST"] = True
Session(app)

# Behind a reverse proxy the client address and Host header Flask sees are the
# proxy's own, so the per-client rate limits below would collapse into a single
# shared bucket and the CSRF guard would reject every write (the browser's
# Origin names the public host). PROXY_FIX_X_FOR names the number of proxies
# actually in front (1 behind the institution's reverse proxy);
# X-Forwarded-For, -Proto and -Host are then trusted that many hops deep.
# Off by default: without a trusted proxy the headers are client-supplied and
# trivially spoofed.
proxy_hops = int(getenv("PROXY_FIX_X_FOR") or "0")
if proxy_hops:
    app.wsgi_app = ProxyFix(
        app.wsgi_app, x_for=proxy_hops, x_proto=proxy_hops, x_host=proxy_hops
    )


# Rate-limit counters live in the storage RATELIMIT_STORAGE_URI names. The
# default memory:// keeps them in-process: with several gunicorn workers the
# effective limit is the stated limit times the worker count, and counters
# reset on restart. Point the URI at redis/memcached to share counters.
def client_network():
    """
    The client's address as the rate limits key on it: an IPv6 address by its
    /64 network, which one host or household usually holds whole.
    """
    address = get_remote_address()
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return address
    if ip.version == 4:
        return address
    if ip.ipv4_mapped:
        return str(ip.ipv4_mapped)
    return str(ipaddress.IPv6Network((int(ip), 64), strict=False))


limiter = Limiter(
    client_network,
    app=app,
    default_limits=["20 per second"],
    storage_uri=getenv("RATELIMIT_STORAGE_URI") or "memory://",
)


# CSRF guard: state-changing requests must originate from this same origin.
# The SPA and broker share an origin, so a browser's Origin (or, failing that,
# Referer) header on a POST/PUT/PATCH/DELETE must name the host this request
# arrived at. Requests carrying neither header (non-browser clients) pass —
# browsers always send Origin on cross-site state-changing requests. This
# backs up the SameSite=Lax session cookie rather than replacing it.
@app.before_request
def reject_cross_origin_writes():
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return None
    source = request.headers.get("Origin") or request.headers.get("Referer")
    if not source:
        return None
    if urlsplit(source).netloc != request.host:
        return jsonify(error="cross-origin request rejected"), 403
    return None


# The relays of third-party bodies answer the app's fetch() calls only. A
# load the browser makes for an image, font or stylesheet (a url() in a page's
# markup) names its destination in Sec-Fetch-Dest; a browser that sends no
# such header is let through.
@app.before_request
def relay_fetch_only():
    if request.endpoint not in ("iiif_fetch", "omr_blob"):
        return None
    if request.headers.get("Sec-Fetch-Dest", "empty") != "empty":
        return jsonify(error="The relay answers fetch requests only"), 403
    return None


# The campaign name registry (see registry.py): the name → (forge, repo id)
# mapping and the claim/register lifecycle around it. It lives in the broker
# because claiming and registering require the GitHub session; the /registry
# path is passed through unchanged by the production reverse proxy and by the
# Vite dev proxy.
try:
    from .registry import GITHUB_API, registry
except ImportError:
    # Run as a top-level module (flask --app app run, gunicorn app:app).
    from registry import GITHUB_API, registry
app.register_blueprint(registry, url_prefix="/registry")

# The registry's admin routes serve only when ADMIN_TOKEN and
# ADMIN_ROUTES_ENABLED=1 are BOTH set (see registry.py), so a token set for CLI
# use alone cannot expose them. Flag the half-configured state at startup.
if getenv("ADMIN_TOKEN") and getenv("ADMIN_ROUTES_ENABLED") != "1":
    app.logger.warning(
        "admin_routes %s",
        json.dumps(
            {
                "source": "broker",
                "event": "admin_token_without_flag",
                "detail": "ADMIN_TOKEN is set but ADMIN_ROUTES_ENABLED is not;"
                " admin routes answer 503",
            },
            separators=(",", ":"),
        ),
    )


@app.errorhandler(429)
def broker_rate_limited(_error):
    app.logger.warning(
        "github_api %s",
        json.dumps(
            {
                "source": "broker",
                "method": request.method,
                "endpoint": request.path,
                "status": 429,
                "user": session.get("userLogin"),
            },
            separators=(",", ":"),
        ),
    )
    if request.endpoint == "login":
        # The browser navigates to /login: back to the app, which says so.
        return redirect(
            with_auth_error(
                safe_return_path(request.args.get("return_to")), "busy"
            )
        )
    response = jsonify(
        error="OAuth broker request rate limit exceeded", source="broker"
    )
    response.status_code = 429
    response.headers["X-Lets-Encode-Upstream"] = "broker"
    return response


@app.errorhandler(413)
def broker_body_too_large(_error):
    response = jsonify(error="That request is too large", source="broker")
    response.status_code = 413
    response.headers["X-Lets-Encode-Upstream"] = "broker"
    return response


oauth = OAuth(app)
github = oauth.register(
    name="github",
    client_id=getenv("GITHUB_CLIENT_ID"),
    client_secret=getenv("GITHUB_CLIENT_SECRET"),
    access_token_url="https://github.com/login/oauth/access_token",
    authorize_url="https://github.com/login/oauth/authorize",
    api_base_url="https://api.github.com/",
    client_kwargs={
        # public_repo (not the broader repo): fork/create-from-template/commit/PR
        # on public repositories, no access to the user's private repos.
        # notifications: mute the campaign repo for volunteers (see muteOnce).
        "scope": "public_repo notifications",
        "code_challenge_method": "S256",
    },
)

# The proxy relays only GitHub REST API calls (the SPA does no git smart-HTTP).
ALLOWED_DOMAINS = ["api.github.com"]

# The GitHub endpoints the SPA calls (src/lib/forge/github-rest.ts), by
# method. The proxy relays no others, so a script running in the page cannot
# use the session's token beyond what the app itself does, such as to add
# collaborators, change repository settings or create repositories other than
# from a template. A pattern matches the whole percent-encoded path.
_REPO = r"/repos/[^/]+/[^/]+"
PROXY_ROUTES = {
    method: re.compile("|".join(f"(?:{pattern})" for pattern in patterns))
    for method, patterns in {
        "GET": (
            r"/user",
            r"/user/\d+",
            r"/repositories/\d+",
            r"/search/repositories",
            _REPO,
            _REPO + r"/contents(/.*)?",
            _REPO + r"/branches/.+",
            _REPO + r"/compare/.+",
            _REPO + r"/commits/[^/]+",
            _REPO + r"/git/commits/[^/]+",
            _REPO + r"/git/ref/heads/.+",
            _REPO + r"/collaborators/[^/]+/permission",
            _REPO + r"/pulls",
            _REPO + r"/pulls/\d+",
            _REPO + r"/pulls/\d+/files",
            _REPO + r"/issues/\d+/comments",
            _REPO + r"/actions/workflows/[^/]+/runs",
            _REPO + r"/actions/runs/\d+",
            _REPO + r"/actions/runs/\d+/jobs",
            _REPO + r"/subscription",
        ),
        "POST": (
            _REPO + r"/generate",
            _REPO + r"/forks",
            _REPO + r"/merge-upstream",
            _REPO + r"/pulls",
            _REPO + r"/issues/\d+/comments",
            _REPO + r"/git/(blobs|trees|commits|refs)",
            _REPO + r"/actions/workflows/[^/]+/dispatches",
        ),
        "PATCH": (
            _REPO + r"/pulls/\d+",
            _REPO + r"/git/refs/heads/.+",
        ),
        "PUT": (
            _REPO + r"/topics",
            _REPO + r"/subscription",
        ),
        "DELETE": (_REPO + r"/git/refs/heads/.+",),
    }.items()
}

# The request headers the app's GitHub calls carry; no other is forwarded,
# the session cookie and a client's Authorization among them.
PROXY_HEADERS = (
    "Accept",
    "Content-Type",
    "If-None-Match",
    "X-GitHub-Api-Version",
)

# Writes the allowlist admits whose body can do more than the app's own: the
# app creates a ref only as a branch, moves one only without force, and
# dispatches a workflow without inputs.
_REF_WRITE = re.compile(_REPO + r"/git/refs(/heads/.+)?")
_DISPATCH = re.compile(_REPO + r"/actions/workflows/[^/]+/dispatches")


def write_beyond_the_app(path):
    """Whether this request's body does more than the app's own writes."""
    if request.method not in ("POST", "PATCH"):
        return False
    ref_write = _REF_WRITE.fullmatch(path)
    dispatch = _DISPATCH.fullmatch(path)
    if not (ref_write or dispatch):
        return False
    body = request.get_json(force=True, silent=True)
    if not isinstance(body, dict):
        return True
    if dispatch:
        return set(body) != {"ref"}
    return bool(body.get("force")) or (
        request.method == "POST"
        and not str(body.get("ref", "")).startswith("refs/heads/")
    )


# Writes go to campaign repositories only: a repository GitHub reports as
# generated from the campaign template, or a fork whose parent is one. The
# template itself takes /generate only. Repositories found to be campaign
# repositories, and those /generate created, are kept in the session as
# "campaignRepos" (lower-case owner/name).
CAMPAIGN_TEMPLATE = (
    getenv("CAMPAIGN_TEMPLATE") or "lets-encode/campaign-template"
).lower()
_REPO_PATH = re.compile(r"/repos/([^/]+/[^/]+)(/.*)?")


def fetch_repository(full_name):
    """GitHub's description of a repository as the session sees it, or None."""
    response = requests.get(
        "{}/repos/{}".format(GITHUB_API, full_name),
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": "token " + session["githubToken"],
        },
        timeout=(10, 30),
    )
    if not response.ok:
        return None
    body = response.json()
    return body if isinstance(body, dict) else None


def generated_from_template(repository):
    template = (repository or {}).get("template_repository") or {}
    return str(template.get("full_name", "")).lower() == CAMPAIGN_TEMPLATE


def remember_campaign_repo(full_name):
    known = session.get("campaignRepos", [])
    if full_name.lower() not in known:
        session["campaignRepos"] = [*known, full_name.lower()]


def campaign_repository(full_name):
    """Whether the proxy may write to `full_name`. May raise RequestException."""
    if full_name.lower() in session.get("campaignRepos", []):
        return True
    repository = fetch_repository(full_name)
    if repository is None:
        return False
    parent = repository.get("parent")
    if not (
        generated_from_template(repository)
        or (
            repository.get("fork")
            and isinstance(parent, dict)
            and parent.get("full_name")
            and generated_from_template(
                fetch_repository(str(parent["full_name"]))
            )
        )
    ):
        return False
    remember_campaign_repo(full_name)
    return True


def write_outside_campaigns(path):
    """
    Whether this write goes to a repository other than a campaign repository
    or, for /generate, to a template other than the campaign template.
    """
    if request.method == "GET":
        return False
    match = _REPO_PATH.fullmatch(path)
    if not match:
        return True
    full_name, rest = match.group(1), match.group(2) or ""
    if rest == "/generate":
        return full_name.lower() != CAMPAIGN_TEMPLATE
    return not campaign_repository(full_name)


# /iiif relay limits. Campaign sources come from any institution's IIIF server,
# so the host cannot be an allowlist; the request is constrained instead — see
# iiif_fetch. A canvas is fetched at the largest size the server gives; the
# cap is GitHub's limit for one file, the most a committed page can be.
IIIF_MAX_BYTES = 100 * 1024 * 1024
IIIF_MAX_REDIRECTS = 5
IIIF_ALLOWED_CONTENT = ("application/json", "application/ld+json", "image/")

# A relayed download (/iiif, /omr/blob GET) has RELAY_DEADLINE_S from its
# start for its hops and its body: no hop starts and no read of the body
# begins after it, each hop's connect and first-byte timeouts (RELAY_TIMEOUT)
# are cut to the time left, and a read under way ends within the read
# timeout. The two together stay below Apache's default 60 s proxy timeout, so
# a slow source gets this broker's 504 rather than the proxy's error.
# Response headers are read under the read timeout per read only, so a server
# that sends them a byte at a time keeps its relay slot (below) longer.
RELAY_DEADLINE_S = 30
RELAY_TIMEOUT = (10, 25)
# What relay requests may hold in one worker process: RELAY_SLOTS requests,
# RELAY_SLOTS_PER_LOGIN of them for one login, each from its start until its
# answer is sent, and RELAY_BUFFER_BYTES of bodies read and not yet sent. The
# relays wait on third-party servers and on the browser, so the slot cap stays
# below the worker's threads (gunicorn_config.py) and leaves threads for every
# other route; the per-login cap is the wizard's parallel canvas requests
# (IIIF_PREVIEW_REQUESTS in src/lib/prepare-images.ts).
RELAY_SLOTS = 6
RELAY_SLOTS_PER_LOGIN = 4
RELAY_BUFFER_BYTES = 256 * 1024 * 1024


class RelayUse:
    """This process's relay slots, by login, and the bytes they buffer."""

    def __init__(self):
        self.lock = threading.Lock()
        self.slots = {}
        self.buffered = 0


relay_use = RelayUse()

try:
    from .relay_db import RelayStore, seconds_to_next_day
except ImportError:
    # Run as a top-level module (flask --app app run, gunicorn app:app).
    from relay_db import RelayStore, seconds_to_next_day

relay_store = RelayStore(
    getenv("RELAY_DB_PATH") or path.join(app.instance_path, "relay.db")
)

# What one login may use of the relays per UTC day: for each thing counted,
# its name in the refusal and the allowance. Past an allowance, the relay
# answers 429 with X-Lets-Encode-Limit: daily until 00:00 UTC; the request
# that passes it is completed.
DAILY_ALLOWANCES = {
    "iiif_bytes": (
        "IIIF downloads",
        int(getenv("IIIF_DAILY_BYTES") or 20 * 1024**3),
    ),
    "omr_bytes": (
        "OMR file transfers",
        int(getenv("OMR_DAILY_BYTES") or 10 * 1024**3),
    ),
    "omr_runs": ("OMR runs", int(getenv("OMR_DAILY_RUNS") or 500)),
}

# The largest request body any route reads: a file at the IIIF cap committed
# through /proxy as a base64 blob (4/3 of its size), plus room for the JSON
# around it. Werkzeug answers a larger body, chunked or not, with 413.
app.config["MAX_CONTENT_LENGTH"] = IIIF_MAX_BYTES * 4 // 3 + 1024 * 1024

# Headers on relayed third-party bodies. The relays answer in the app origin, so
# a body opened directly in a tab (an SVG or HTML document) would otherwise run
# script with the session cookie. fetch() ignores all three.
RELAY_SAFETY_HEADERS = [
    ("Content-Disposition", "attachment"),
    ("X-Content-Type-Options", "nosniff"),
    ("Content-Security-Policy", "sandbox"),
]

# /omr relay: the Musibot OMR service, for the console's OMR preparation. The
# service sends no CORS headers and its API token is institutional, so the
# browser reaches it only through here. Only the endpoints the console uses
# are relayed, matched against these patterns. Every page under the shared
# token belongs to whoever holds it, and one user must not see another's: the
# page listing is not relayed, a page only to the login that created it
# through the relay, and an execution only on the page it was started on.
# File bytes travel over presigned URLs on the service's own host, relayed by
# /omr/blob.
MUSIBOT_URL = (
    getenv("MUSIBOT_URL") or "https://quest.ms.mff.cuni.cz/musibot/api"
).rstrip("/")
MUSIBOT_TOKEN = getenv("MUSIBOT_TOKEN")
MUSIBOT_HOST = urlsplit(MUSIBOT_URL).netloc
# A page image goes to the service at its committed size, so the cap is the
# same as the IIIF relay's.
OMR_MAX_BYTES = IIIF_MAX_BYTES
# A pattern's first group is the page id, its second the execution id.
_PAGE = r"musicorpus-pages/([A-Za-z0-9_-]+)"
OMR_ROUTES = (
    ("GET", re.compile(r"pipelines")),
    ("POST", re.compile(r"musicorpus-pages")),
    ("DELETE", re.compile(_PAGE)),
    ("GET", re.compile(_PAGE + r"/files")),
    ("POST", re.compile(_PAGE + r"/file-urls")),
    ("POST", re.compile(_PAGE + r"/pipeline-executions")),
    # An execution id in decimal, as the service writes it and SQLite holds it.
    ("GET", re.compile(_PAGE + r"/pipeline-executions/(0|[1-9][0-9]{0,17})")),
)


def resolves_to_public_address(hostname):
    """
    True when every address a hostname resolves to is publicly routable.

    The IIIF relay fetches URLs supplied by the browser, so without this it
    would be a server-side request forgery vector into anything the broker's
    network can reach — cloud metadata endpoints, loopback services, private
    LAN hosts. Every resolved address is checked, since a name can return both
    a public and a private record. An address must be global and match none of
    the special ranges: `is_global` alone admits NAT64 forms of private
    addresses (64:ff9b::/96), and the special ranges alone admit shared address
    space (100.64.0.0/10).
    """
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return False
    if not infos:
        return False
    for info in infos:
        try:
            address = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (
            not address.is_global
            or address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_multicast
            or address.is_unspecified
        ):
            return False
    return True


def relay_busy():
    """The 429 a relay answers when this process has no room for a request."""
    response = jsonify(
        error="The relay is handling too many requests at once; try again shortly",
        source="broker",
    )
    response.status_code = 429
    response.headers["Retry-After"] = "1"
    response.headers["X-Lets-Encode-Upstream"] = "broker"
    return response


def daily_allowance_used_up(kind):
    """
    The 429 for a session whose login has used its allowance of `kind`
    (DAILY_ALLOWANCES) today, or None.
    """
    name, allowance = DAILY_ALLOWANCES[kind]
    if relay_store.used(session.get("userLogin"), kind) < allowance:
        return None
    response = jsonify(
        error=f"This account has reached today's limit for {name}; the limit"
        " is reset at 00:00 UTC",
        source="broker",
    )
    response.status_code = 429
    response.headers["Retry-After"] = str(seconds_to_next_day())
    response.headers["X-Lets-Encode-Upstream"] = "broker"
    response.headers["X-Lets-Encode-Limit"] = "daily"
    return response


def count_relay_use(kind, amount, **details):
    """
    Count `amount` of `kind` against the session's login for today, and write
    it to the log as a relay_use line.
    """
    login = session.get("userLogin")
    relay_store.add(login, kind, amount)
    app.logger.info(
        "relay_use %s",
        json.dumps(
            {
                "source": "broker",
                "user": login,
                "kind": kind,
                "amount": amount,
                **details,
            },
            separators=(",", ":"),
        ),
    )


def in_relay_slot(view):
    """
    Serve `view` in one of this process's relay slots, held until the answer
    has been sent, or answer 429 when the process holds RELAY_SLOTS relay
    requests already or the session's login holds RELAY_SLOTS_PER_LOGIN. The
    slot is g.relay_slot while the view runs; read_relayed counts the bytes
    it buffers on it. A request without a session takes no slot; the view
    answers it 401.
    """

    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        if "githubToken" not in session:
            return view(*args, **kwargs)
        login = session.get("userLogin")
        with relay_use.lock:
            granted = (
                sum(relay_use.slots.values()) < RELAY_SLOTS
                and relay_use.slots.get(login, 0) < RELAY_SLOTS_PER_LOGIN
            )
            if granted:
                relay_use.slots[login] = relay_use.slots.get(login, 0) + 1
        if not granted:
            return relay_busy()
        slot = {"bytes": 0, "released": False}
        g.relay_slot = slot

        def release():
            with relay_use.lock:
                if slot["released"]:
                    return
                slot["released"] = True
                relay_use.buffered -= slot["bytes"]
                relay_use.slots[login] -= 1
                if not relay_use.slots[login]:
                    del relay_use.slots[login]

        try:
            response = app.make_response(view(*args, **kwargs))
        except BaseException:
            release()
            raise
        # The server closes the response once it is sent, or when the client
        # goes away.
        response.call_on_close(release)
        return response

    return wrapped


def read_relayed(response, deadline, limit):
    """
    Read an upstream body as it came over the wire, without content decoding,
    one network read at a time, none begun after `deadline` (a
    time.monotonic() value), and close the response. The bytes are counted
    on the request's relay slot against RELAY_BUFFER_BYTES. Returns (chunks,
    None), or (None, reason) with reason "too_large" past `limit` bytes,
    "busy" past RELAY_BUFFER_BYTES, "timeout" past the deadline or a read
    timeout, "failed" when the connection broke. Content-Length is not
    trusted: it may be absent or understate a chunked response.
    """
    slot = g.relay_slot
    chunks = []
    total = 0
    try:
        while True:
            if time.monotonic() >= deadline:
                return None, "timeout"
            chunk = response.raw.read1(64 * 1024, decode_content=False)
            if not chunk:
                return chunks, None
            total += len(chunk)
            if total > limit:
                return None, "too_large"
            with relay_use.lock:
                if relay_use.buffered + len(chunk) > RELAY_BUFFER_BYTES:
                    return None, "busy"
                relay_use.buffered += len(chunk)
                slot["bytes"] += len(chunk)
            chunks.append(chunk)
    except urllib3.exceptions.ReadTimeoutError:
        return None, "timeout"
    except (urllib3.exceptions.HTTPError, OSError):
        return None, "failed"
    finally:
        response.close()


def json_field(response, name):
    """The `name` field of a JSON object body, or None."""
    try:
        body = response.json()
    except ValueError:
        return None
    return body.get(name) if isinstance(body, dict) else None


def relayed_headers(response, content_type):
    """
    The headers of a relayed body: its type, the upstream's content coding
    when it applied one (the body is relayed undecoded, and the browser
    decodes it), and no caching.
    """
    headers = [("Content-Type", content_type), ("Cache-Control", "no-store")]
    encoding = response.headers.get("content-encoding", "")
    if encoding and encoding.lower() != "identity":
        headers.append(("Content-Encoding", encoding))
    return headers


def oauth_callback_url() -> str:
    # Behind the /auth mount the prefix and scheme are invisible to Flask, so
    # url_for can't reconstruct the externally reachable callback; REDIRECT_URL
    # states it explicitly (it must match the OAuth app's registered callback).
    return getenv("REDIRECT_URL") or request.host_url.rstrip("/") + "/authorize"


def safe_return_path(value):
    # Only same-origin absolute paths. Backslashes are rejected because browsers
    # can normalize them as URL separators ("/\\host" → "//host").
    if (
        not value
        or value.startswith("//")
        or "\\" in value
        or any(ord(char) < 0x20 for char in value)
    ):
        return "/"
    parsed = urlsplit(value)
    if not parsed.scheme and not parsed.netloc and parsed.path.startswith("/"):
        return value
    return "/"


def with_auth_error(return_to, code):
    # The SPA shows a fixed text for each code (src/lib/auth.svelte.ts); no
    # text from the request reaches the page.
    parsed = urlsplit(return_to)
    query = parse_qsl(parsed.query, keep_blank_values=True)
    query.append(("auth_error", code))
    return urlunsplit(("", "", parsed.path, urlencode(query), parsed.fragment))


# authlib's error names for a failed authorisation, as auth_error codes.
AUTH_ERROR_CODES = {"access_denied": "denied", "mismatching_state": "state"}


@app.route("/login")
# Every visit writes a session file, kept for the OAuth round trip.
@limiter.limit("30 per minute")
@limiter.limit("300 per minute", key_func=lambda: "all")
def login():
    # Remember where the SPA wants the user back, then hand off to GitHub.
    # authlib generates and session-stores the OAuth `state` parameter.
    session["return_to"] = safe_return_path(request.args.get("return_to"))
    return github.authorize_redirect(oauth_callback_url())


@app.route("/authorize")
def authorize():
    return_to = session.pop("return_to", "/")
    try:
        token = github.authorize_access_token()
    except Exception as e:
        # Denied grant, stale/invalid state, or a failed exchange. Surface it to
        # the SPA rather than failing silently.
        error = getattr(e, "error", None) or type(e).__name__
        app.logger.warning(
            "oauth_error %s",
            json.dumps(
                {
                    "source": "broker",
                    "event": "authorize_failed",
                    "error": error,
                },
                separators=(",", ":"),
            ),
        )
        return redirect(
            with_auth_error(return_to, AUTH_ERROR_CODES.get(error, "failed"))
        )
    resp = github.get("user", token=token)
    if not resp.ok:
        return redirect(with_auth_error(return_to, "user"))
    # Replace the pre-login session ID after authentication so an ID fixed by
    # an attacker cannot become an authenticated session.
    app.session_interface.regenerate(session)
    session["githubToken"] = token["access_token"]
    session["userLogin"] = resp.json().get("login", "")
    return redirect(return_to)


def revoke_github_token(token):
    # Ask GitHub to invalidate the OAuth token so it cannot be reused after
    # logout. OAuth App tokens do not expire on their own, so without this a
    # leaked token stays valid indefinitely. Best-effort: never let a failure
    # here block the user from logging out.
    client_id = getenv("GITHUB_CLIENT_ID")
    client_secret = getenv("GITHUB_CLIENT_SECRET")
    if not (token and client_id and client_secret):
        return
    try:
        # 204 = revoked, 404 = already invalid; both leave the token unusable.
        requests.delete(
            "{}/applications/{}/token".format(GITHUB_API, client_id),
            auth=(client_id, client_secret),
            json={"access_token": token},
            headers={"Accept": "application/vnd.github+json"},
            timeout=5,
        )
    except requests.RequestException as e:
        app.logger.warning(
            "token_revoke %s",
            json.dumps(
                {
                    "source": "broker",
                    "event": "revoke_failed",
                    "error": str(e),
                },
                separators=(",", ":"),
            ),
        )


def revoke_github_tokens(tokens):
    for token in tokens:
        revoke_github_token(token)


@app.route("/logout", methods=["POST"])
def logout():
    revoke_github_token(session.get("githubToken"))
    session.clear()
    return jsonify(ok=True)


@app.route("/iiif", methods=["GET"])
# Reading a source is one request per canvas, so a large manifest is a burst of
# hundreds. The client spaces them to stay under this ceiling (see
# IIIF_REQUESTS_PER_SECOND); the margin between the two rates leaves room for a
# manifest fetch, or a second tab, alongside a run. Lowering this without
# lowering the client's rate makes every large source fail partway.
@limiter.limit(
    "20 per second",
    key_func=lambda: session.get("userLogin") or client_network(),
)
@in_relay_slot
def iiif_fetch():
    """
    Relay a IIIF manifest or canvas image, same-origin, for the onboarding
    wizard.

    Campaign sources come from arbitrary institutions, which rules out both a
    CSP host allowlist and direct browser fetches (many IIIF servers send no
    CORS headers). Relaying here solves both. No credentials are attached — the
    session gates who may use the relay, nothing more — and redirects are
    followed manually so each hop is re-checked against the address rules.
    """
    if "githubToken" not in session:
        return jsonify(error="Authentication required"), 401
    target = request.args.get("url", "")
    if not target:
        return jsonify(error="A url parameter is required"), 400
    refused = daily_allowance_used_up("iiif_bytes")
    if refused:
        return refused

    deadline = time.monotonic() + RELAY_DEADLINE_S
    seen_redirects = 0
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            return jsonify(error="Upstream request timed out"), 504
        parsed = urlsplit(target)
        if parsed.scheme != "https":
            return jsonify(error="Only https URLs are allowed"), 400
        if not parsed.hostname or not resolves_to_public_address(
            parsed.hostname
        ):
            return jsonify(error="That host is not allowed"), 400
        try:
            response = requests.get(
                target,
                headers={
                    "accept": request.headers.get("accept", "*/*"),
                    # The body is relayed undecoded (read_relayed).
                    "accept-encoding": "identity",
                },
                timeout=(
                    min(RELAY_TIMEOUT[0], left),
                    min(RELAY_TIMEOUT[1], left),
                ),
                allow_redirects=False,
                stream=True,
            )
        except requests.Timeout:
            return jsonify(error="Upstream request timed out"), 504
        except requests.RequestException:
            return jsonify(error="Upstream request failed"), 502

        if response.is_redirect or response.is_permanent_redirect:
            seen_redirects += 1
            if seen_redirects > IIIF_MAX_REDIRECTS:
                response.close()
                return jsonify(error="Too many redirects"), 502
            location = response.headers.get("location", "")
            response.close()
            if not location:
                return jsonify(error="Upstream request failed"), 502
            # A relative Location resolves against the hop it came from.
            target = requests.compat.urljoin(target, location)
            continue
        break

    content_type = response.headers.get("content-type", "")
    if not content_type.startswith(IIIF_ALLOWED_CONTENT):
        response.close()
        return jsonify(error="Unexpected content type from that URL"), 415

    chunks, failure = read_relayed(response, deadline, IIIF_MAX_BYTES)
    count_relay_use("iiif_bytes", g.relay_slot["bytes"], host=parsed.hostname)
    if failure == "too_large":
        return jsonify(error="That resource is too large"), 413
    if failure == "busy":
        return relay_busy()
    if failure == "timeout":
        return jsonify(error="Upstream request timed out"), 504
    if failure:
        return jsonify(error="Upstream request failed"), 502

    return app.response_class(
        chunks,
        status=response.status_code,
        headers=[
            *relayed_headers(response, content_type),
            ("X-Lets-Encode-Upstream", "iiif"),
            *RELAY_SAFETY_HEADERS,
        ],
    )


@app.route("/omr/api/<path:path>", methods=["GET", "POST", "DELETE"])
# Transcribing a page is one execution per staff plus the polling for each,
# so a page is a burst of a few dozen calls.
@limiter.limit(
    "100 per second",
    key_func=lambda: session.get("userLogin") or client_network(),
)
def omr_api(path):
    """
    Relay one Musibot API call, attaching the institutional token. JSON in,
    JSON out; the upstream status is passed through.
    """
    if "githubToken" not in session:
        return jsonify(error="Authentication required"), 401
    if not MUSIBOT_TOKEN:
        return (
            jsonify(
                error="OMR is not configured on this instance", source="musibot"
            ),
            503,
        )
    for method, pattern in OMR_ROUTES:
        route = pattern.fullmatch(path) if method == request.method else None
        if route:
            break
    else:
        return (
            jsonify(error="That OMR endpoint is not relayed", source="musibot"),
            404,
        )
    login = session.get("userLogin")
    groups = route.groups()
    page_id = groups[0] if groups else None
    execution_id = int(groups[1]) if len(groups) > 1 else None
    if page_id is not None and (
        relay_store.page_creator(page_id) != login
        or (
            execution_id is not None
            and not relay_store.has_execution(page_id, execution_id)
        )
    ):
        return (
            jsonify(
                error="That OMR page or run does not belong to this account",
                source="musibot",
            ),
            404,
        )
    starts_run = request.method == "POST" and path.endswith(
        "/pipeline-executions"
    )
    if starts_run:
        refused = daily_allowance_used_up("omr_runs")
        if refused:
            return refused
    headers = {
        "Authorization": f"Bearer {MUSIBOT_TOKEN}",
        "Accept": "application/json",
    }
    body = request.get_data()
    if body:
        headers["Content-Type"] = "application/json"
    try:
        response = requests.request(
            request.method,
            f"{MUSIBOT_URL}/{path}",
            headers=headers,
            data=body or None,
            timeout=(10, 60),
            allow_redirects=False,
        )
    except requests.Timeout:
        return (
            jsonify(
                error="The OMR service did not answer in time", source="musibot"
            ),
            504,
        )
    except requests.RequestException:
        return (
            jsonify(
                error="The OMR service could not be reached", source="musibot"
            ),
            502,
        )
    if response.ok and request.method == "POST" and page_id is None:
        created = json_field(response, "page_id")
        if isinstance(created, str):
            relay_store.add_page(created, login)
    elif response.ok and starts_run:
        started = str(json_field(response, "execution_id"))
        if re.fullmatch(r"0|[1-9][0-9]{0,17}", started):
            relay_store.add_execution(page_id, int(started))
        count_relay_use("omr_runs", 1, page=page_id)
    return (
        response.content,
        response.status_code,
        [
            (
                "Content-Type",
                response.headers.get("content-type", "application/json"),
            ),
            ("Cache-Control", "no-store"),
            ("X-Lets-Encode-Upstream", "musibot"),
            *RELAY_SAFETY_HEADERS,
        ],
    )


@app.route("/omr/blob", methods=["GET", "PUT"])
@limiter.limit(
    "100 per second",
    key_func=lambda: session.get("userLogin") or client_network(),
)
@in_relay_slot
def omr_blob():
    """
    Transfer file bytes to (PUT) or from (GET) a presigned URL the Musibot API
    handed out. Only URLs on the service's own host are relayed, and a body
    in either direction is capped.
    """
    if "githubToken" not in session:
        return jsonify(error="Authentication required"), 401
    url = request.args.get("url", "")
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc != MUSIBOT_HOST:
        return (
            jsonify(
                error="Only presigned URLs on the OMR service's host are relayed",
                source="musibot",
            ),
            400,
        )
    refused = daily_allowance_used_up("omr_bytes")
    if refused:
        return refused
    try:
        if request.method == "PUT":
            if (request.content_length or 0) > OMR_MAX_BYTES:
                return (
                    jsonify(error="That file is too large", source="musibot"),
                    413,
                )
            data = request.get_data()
            if len(data) > OMR_MAX_BYTES:
                return (
                    jsonify(error="That file is too large", source="musibot"),
                    413,
                )
            count_relay_use("omr_bytes", len(data), method="PUT")
            response = requests.put(
                url,
                data=data,
                headers={
                    "Content-Type": request.content_type
                    or "application/octet-stream"
                },
                timeout=(10, 60),
                allow_redirects=False,
            )
            response.close()
            return (
                jsonify(ok=response.ok),
                response.status_code if not response.ok else 200,
                [
                    ("Cache-Control", "no-store"),
                    ("X-Lets-Encode-Upstream", "musibot"),
                ],
            )
        deadline = time.monotonic() + RELAY_DEADLINE_S
        response = requests.get(
            url,
            # The body is relayed undecoded (read_relayed).
            headers={"accept-encoding": "identity"},
            timeout=RELAY_TIMEOUT,
            allow_redirects=False,
            stream=True,
        )
    except requests.Timeout:
        return (
            jsonify(
                error="The OMR service did not answer in time", source="musibot"
            ),
            504,
        )
    except requests.RequestException:
        return (
            jsonify(
                error="The OMR service could not be reached", source="musibot"
            ),
            502,
        )
    chunks, failure = read_relayed(response, deadline, OMR_MAX_BYTES)
    count_relay_use("omr_bytes", g.relay_slot["bytes"], method="GET")
    if failure == "too_large":
        return (
            jsonify(error="That file is too large", source="musibot"),
            413,
        )
    if failure == "busy":
        return relay_busy()
    if failure == "timeout":
        return (
            jsonify(
                error="The OMR service did not answer in time", source="musibot"
            ),
            504,
        )
    if failure:
        return (
            jsonify(
                error="The OMR service could not be reached", source="musibot"
            ),
            502,
        )
    return app.response_class(
        chunks,
        status=response.status_code,
        # Always untyped bytes: an uploaded file must not come back from this
        # origin as a script or document; the app reads it with .blob().
        headers=[
            *relayed_headers(response, "application/octet-stream"),
            ("X-Lets-Encode-Upstream", "musibot"),
            *RELAY_SAFETY_HEADERS,
        ],
    )


@app.route(
    "/proxy/<path:url>", methods=["GET", "POST", "PUT", "PATCH", "DELETE"]
)
# All authenticated GitHub traffic flows through here, and the SPA polls
# (workflow runs, fork readiness), so bursts exceed the default limit. Key by
# user login so users behind a shared institutional NAT don't throttle each
# other.
@limiter.limit(
    "30 per second",
    key_func=lambda: session.get("userLogin") or client_network(),
)
def proxy(url):
    # Only logged-in users may use the proxy: it exists to attach the session's
    # token, and gating it prevents abuse as an open relay. Anonymous reads
    # (e.g. the public campaign listing) go directly to the API from the
    # browser instead.
    if "githubToken" not in session:
        return jsonify(error="Authentication required"), 401
    # The server has already percent-decoded the path. Quoting it again keeps
    # a literal %, ? or # in a file name inside the path GitHub receives.
    url = quote(url, safe="/:")
    if not url.startswith("http"):
        url = "https://" + url
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc not in ALLOWED_DOMAINS:
        return jsonify(error="Domain not allowed"), 400
    # A "." or ".." segment would move the request to another endpoint:
    # requests resolves them before sending.
    if any(segment in (".", "..") for segment in parsed.path.split("/")):
        return jsonify(error="Path not allowed"), 400
    routes = PROXY_ROUTES.get(request.method)
    if (
        routes is None
        or not routes.fullmatch(parsed.path)
        or write_beyond_the_app(parsed.path)
    ):
        app.logger.warning(
            "github_api %s",
            json.dumps(
                {
                    "source": "broker",
                    "event": "endpoint_refused",
                    "method": request.method,
                    "endpoint": parsed.path,
                    "user": session.get("userLogin"),
                },
                separators=(",", ":"),
            ),
        )
        response = jsonify(
            error="That GitHub endpoint is not relayed", source="broker"
        )
        response.status_code = 403
        response.headers["X-Lets-Encode-Upstream"] = "broker"
        return response
    try:
        outside = write_outside_campaigns(parsed.path)
    except requests.Timeout:
        return jsonify(error="Upstream request timed out"), 504
    except (requests.RequestException, ValueError):
        return jsonify(error="Upstream request failed"), 502
    if outside:
        app.logger.warning(
            "github_api %s",
            json.dumps(
                {
                    "source": "broker",
                    "event": "write_refused",
                    "method": request.method,
                    "endpoint": parsed.path,
                    "user": session.get("userLogin"),
                },
                separators=(",", ":"),
            ),
        )
        response = jsonify(
            error="Writes go to campaign repositories only", source="broker"
        )
        response.status_code = 403
        response.headers["X-Lets-Encode-Upstream"] = "broker"
        return response
    if request.query_string:
        url += "?" + request.query_string.decode()

    # The token is attached here from the session, so it never needs to be
    # in the browser.
    headers = {
        name: request.headers[name]
        for name in PROXY_HEADERS
        if name in request.headers
    }
    headers["Authorization"] = "token " + session["githubToken"]

    # Timeout protects gunicorn workers from being parked indefinitely by a
    # hung upstream connection: 10s to connect, 60s between reads.
    started_at = time.monotonic()
    try:
        response = requests.request(
            request.method,
            url,
            headers=headers,
            data=request.get_data(),
            timeout=(10, 60),
            allow_redirects=False,
        )
    except requests.Timeout:
        return jsonify(error="Upstream request timed out"), 504
    except requests.RequestException:
        return jsonify(error="Upstream request failed"), 502
    if (
        request.method == "POST"
        and parsed.path.endswith("/generate")
        and response.status_code == 201
    ):
        created = json_field(response, "full_name")
        if isinstance(created, str):
            remember_campaign_repo(created)

    # 'date' and 'server' must not be passed through: our own HTTP layer adds
    # its own, and duplicate Date headers are joined by browsers into a string
    # that parses as Invalid Date. Cache-directive headers must not be forwarded
    # either: these are per-request, per-user authenticated relays, and any
    # shared cache in front of us could serve a stale response — or one user's
    # response to another — on the same /proxy path. Force no-store.
    # ETag/Last-Modified ARE forwarded: the SPA stores them and sends
    # `If-None-Match` on the next read, so unchanged resources answer 304 (which
    # GitHub does not count against the API rate limit). The SPA keeps those
    # validators itself, so no shared or HTTP cache is involved.
    excluded_response_headers = {
        "content-encoding",
        "content-length",
        "transfer-encoding",
        "connection",
        "www-authenticate",
        "date",
        "server",
        "set-cookie",
        "cache-control",
        "expires",
        "pragma",
        "age",
    }
    out_headers = [
        (name, value)
        for name, value in response.raw.headers.items()
        if name.lower() not in excluded_response_headers
    ]
    out_headers.append(("Cache-Control", "no-store"))
    out_headers.append(("X-Lets-Encode-Upstream", "github"))
    upstream_headers = requests.structures.CaseInsensitiveDict(
        response.raw.headers
    )
    app.logger.info(
        "github_api %s",
        json.dumps(
            {
                "source": "github",
                "method": request.method,
                "endpoint": parsed.path,
                "status": response.status_code,
                "duration_ms": round((time.monotonic() - started_at) * 1000),
                "user": session.get("userLogin"),
                "resource": upstream_headers.get("X-RateLimit-Resource"),
                "limit": upstream_headers.get("X-RateLimit-Limit"),
                "remaining": upstream_headers.get("X-RateLimit-Remaining"),
                "used": upstream_headers.get("X-RateLimit-Used"),
                "reset": upstream_headers.get("X-RateLimit-Reset"),
                "retry_after": upstream_headers.get("Retry-After"),
                "request_id": upstream_headers.get("X-GitHub-Request-Id"),
            },
            separators=(",", ":"),
        ),
    )
    return (response.content, response.status_code, out_headers)


if __name__ == "__main__":
    app.run(port=7777)
