"""
Login and logout: the OAuth round trip with GitHub (/login, /authorize)
and /logout, with the return path and error codes handed back to the app.
"""

import json
from os import getenv
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import requests
from flask import Blueprint, current_app, jsonify, redirect, request, session

try:
    from .shared import app_module, limiter
except ImportError:
    # Run as a top-level module (flask --app app run, gunicorn app:app).
    from shared import app_module, limiter

auth = Blueprint("auth", __name__)


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


@auth.route("/login")
# Every visit writes a session file, kept for the OAuth round trip.
@limiter.limit("30 per minute")
@limiter.limit("300 per minute", key_func=lambda: "all")
def login():
    # Remember where the SPA wants the user back, then hand off to GitHub.
    # authlib generates and session-stores the OAuth `state` parameter; the
    # return path is kept under it, so logins started in two tabs each come
    # back where they started.
    github = app_module().github
    redirect_uri = oauth_callback_url()
    rv = github.create_authorization_url(redirect_uri)
    github.save_authorize_data(redirect_uri=redirect_uri, **rv)
    session["return_to:" + rv["state"]] = safe_return_path(
        request.args.get("return_to")
    )
    return redirect(rv["url"])


@auth.route("/authorize")
def authorize():
    github = app_module().github
    return_to = session.pop("return_to:" + request.args.get("state", ""), "/")
    try:
        token = github.authorize_access_token()
    except Exception as e:
        # Denied grant, stale/invalid state, or a failed exchange. Surface it to
        # the SPA rather than failing silently.
        error = getattr(e, "error", None) or type(e).__name__
        current_app.logger.warning(
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
    # A failed or unreadable answer ends as a login error, like a missing login.
    try:
        resp = github.get("user", token=token)
        login = resp.json().get("login") if resp.ok else None
    except (requests.RequestException, ValueError):
        login = None
    if not (isinstance(login, str) and login):
        return redirect(with_auth_error(return_to, "user"))
    # What the session recorded for an earlier login does not carry over; the
    # OAuth data of logins still under way in other tabs stays. Replace the
    # pre-login session ID after authentication so an ID fixed by an attacker
    # cannot become an authenticated session.
    session.pop("campaignRepos", None)
    session["githubToken"] = token["access_token"]
    session["userLogin"] = login
    current_app.session_interface.regenerate(session)
    return redirect(return_to)


@auth.route("/logout", methods=["POST"])
def logout():
    revoke_github_token = app_module().revoke_github_token
    revoke_github_token(session.get("githubToken"))
    session.clear()
    return jsonify(ok=True)
