"""
OAuth session broker for the app (Flask).

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
import json
import logging
import socket  # noqa: F401  test_app.py patches socket.getaddrinfo through app
import struct
import sys
import threading
import time
from datetime import timedelta
from os import getenv, makedirs, chmod, path, remove
from pathlib import Path
from urllib.parse import urlsplit

import requests
import urllib3  # noqa: F401  test_app.py reaches urllib3 through app
from authlib.integrations.flask_client import OAuth
from cachelib.file import FileSystemCache
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, request, session
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
    they hold are revoked. A session without a GitHub token, as /login starts
    one, holds only the OAuth round trip and is kept PRELOGIN_S at most.

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
            # Without its token the session is no login: what it recorded
            # for that login goes too.
            for key in ("githubToken", "userLogin", "campaignRepos"):
                opened.pop(key, None)
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


try:
    from .shared import client_network, limiter  # noqa: F401
except ImportError:
    # Run as a top-level module (flask --app app run, gunicorn app:app).
    from shared import client_network, limiter  # noqa: F401

limiter.init_app(app)


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
    if request.endpoint not in ("iiif_relay.iiif_fetch", "omr_relay.omr_blob"):
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


# The blueprints for login, the GitHub proxy and the relays, and the names
# test_app.py reads or patches on this module.
try:
    from .auth import auth, safe_return_path, with_auth_error
    from .github_proxy import (  # noqa: F401
        CAMPAIGN_REPO_CHECK_S,
        CAMPAIGN_TEMPLATE,
        campaign_repository,
        fetch_repository,
        github_proxy,
    )
    from .iiif_relay import (  # noqa: F401
        IIIF_MAX_BYTES,
        iiif_relay,
        resolves_to_public_address,
    )
    from .omr_relay import (  # noqa: F401
        MUSIBOT_HOST,
        MUSIBOT_TOKEN,
        MUSIBOT_URL,
        OMR_MAX_BYTES,
        omr_relay,
    )
    from .relay_common import (  # noqa: F401
        DAILY_ALLOWANCES,
        RELAY_BUFFER_BYTES,
        RELAY_DEADLINE_S,
        RELAY_SLOTS,
        RELAY_SLOTS_PER_LOGIN,
        RelayUse,
    )
except ImportError:
    # Run as a top-level module (flask --app app run, gunicorn app:app).
    from auth import auth, safe_return_path, with_auth_error
    from github_proxy import (  # noqa: F401
        CAMPAIGN_REPO_CHECK_S,
        CAMPAIGN_TEMPLATE,
        campaign_repository,
        fetch_repository,
        github_proxy,
    )
    from iiif_relay import (  # noqa: F401
        IIIF_MAX_BYTES,
        iiif_relay,
        resolves_to_public_address,
    )
    from omr_relay import (  # noqa: F401
        MUSIBOT_HOST,
        MUSIBOT_TOKEN,
        MUSIBOT_URL,
        OMR_MAX_BYTES,
        omr_relay,
    )
    from relay_common import (  # noqa: F401
        DAILY_ALLOWANCES,
        RELAY_BUFFER_BYTES,
        RELAY_DEADLINE_S,
        RELAY_SLOTS,
        RELAY_SLOTS_PER_LOGIN,
        RelayUse,
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
    if request.endpoint == "auth.login":
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

# This process's relay slots (relay_common.py) and the relays' database.
# The relays read both through this module.
relay_use = RelayUse()

try:
    from .relay_db import RelayStore
except ImportError:
    # Run as a top-level module (flask --app app run, gunicorn app:app).
    from relay_db import RelayStore

relay_store = RelayStore(
    getenv("RELAY_DB_PATH") or path.join(app.instance_path, "relay.db")
)

# The largest request body any route reads: a file at the IIIF cap committed
# through /proxy as a base64 blob (4/3 of its size), plus room for the JSON
# around it. Werkzeug answers a larger body, chunked or not, with 413.
app.config["MAX_CONTENT_LENGTH"] = IIIF_MAX_BYTES * 4 // 3 + 1024 * 1024


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
        res = requests.delete(
            "{}/applications/{}/token".format(GITHUB_API, client_id),
            auth=(client_id, client_secret),
            json={"access_token": token},
            headers={"Accept": "application/vnd.github+json"},
            timeout=5,
        )
        if res.status_code not in (204, 404):
            app.logger.warning(
                "token_revoke %s",
                json.dumps(
                    {
                        "source": "broker",
                        "event": "revoke_failed",
                        "status": res.status_code,
                    },
                    separators=(",", ":"),
                ),
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


app.register_blueprint(auth)
app.register_blueprint(iiif_relay)
app.register_blueprint(omr_relay)
app.register_blueprint(github_proxy)


if __name__ == "__main__":
    app.run(port=7777)
