"""
The /proxy relay: the GitHub API calls the app makes, with the session's
token attached, limited to the app's own endpoints and to writes to
campaign repositories.
"""

import json
import re
import time
from os import getenv
from urllib.parse import quote, urlsplit, urlunsplit

import requests
from flask import Blueprint, current_app, jsonify, request, session

try:
    from .registry import GITHUB_API, signed_in
    from .shared import app_module, client_network, json_field, limiter
except ImportError:
    # Run as a top-level module (flask --app app run, gunicorn app:app).
    from registry import GITHUB_API, signed_in
    from shared import app_module, client_network, json_field, limiter

github_proxy = Blueprint("github_proxy", __name__)

# The proxy relays only GitHub API calls (the SPA does no git smart-HTTP).
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
            r"/graphql",
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
# dispatches a workflow without inputs. Of GraphQL it sends queries only.
_REF_WRITE = re.compile(_REPO + r"/git/refs(/heads/.+)?")
_DISPATCH = re.compile(_REPO + r"/actions/workflows/[^/]+/dispatches")
# A GraphQL document that names a mutation or subscription anywhere. The app
# passes all values as variables, so its queries contain neither word.
_GRAPHQL_WRITE = re.compile(r"\b(mutation|subscription)\b")


def graphql_query(path):
    """Whether this request is a GraphQL query, which only reads."""
    if request.method != "POST" or path != "/graphql" or request.query_string:
        return False
    body = request.get_json(force=True, silent=True)
    return (
        isinstance(body, dict)
        and set(body) <= {"query", "variables", "operationName"}
        and isinstance(body.get("query"), str)
        and not _GRAPHQL_WRITE.search(body["query"])
    )


def write_beyond_the_app(path):
    """Whether this request's body does more than the app's own writes."""
    if request.method not in ("POST", "PATCH"):
        return False
    if path == "/graphql":
        return not graphql_query(path)
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
# "campaignRepos" (lower-case owner/name → when found) for
# CAMPAIGN_REPO_CHECK_S; a name is looked up again after that, since a
# renamed repository's old name can come to name another repository.
CAMPAIGN_REPO_CHECK_S = 600
CAMPAIGN_TEMPLATE = (
    getenv("CAMPAIGN_TEMPLATE") or "lets-encode/campaign-template"
).lower()
_REPO_PATH = re.compile(r"/repos/([^/]+/[^/]+)(/.*)?")


class RepositoryLookupFailed(Exception):
    """GitHub answered a repository lookup with neither the repository nor 404."""

    def __init__(self, response):
        super().__init__(response.status_code)
        self.response = response


def fetch_repository(full_name):
    """
    GitHub's description of a repository as the session sees it, or None when
    GitHub does not show it (404). Raises RepositoryLookupFailed for any other
    failed answer.
    """
    response = requests.get(
        "{}/repos/{}".format(GITHUB_API, full_name),
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": "token " + session["githubToken"],
        },
        timeout=(10, 30),
    )
    if response.status_code == 404:
        return None
    if not response.ok:
        raise RepositoryLookupFailed(response)
    body = response.json()
    return body if isinstance(body, dict) else None


def generated_from_template(repository):
    template = (repository or {}).get("template_repository") or {}
    return str(template.get("full_name", "")).lower() == CAMPAIGN_TEMPLATE


def remember_campaign_repo(full_name):
    now = time.time()
    known = session.get("campaignRepos")
    session["campaignRepos"] = {
        **{
            name: found
            for name, found in (
                known if isinstance(known, dict) else {}
            ).items()
            if now - found < CAMPAIGN_REPO_CHECK_S
        },
        full_name.lower(): now,
    }


def campaign_repository(full_name):
    """Whether the proxy may write to `full_name`. May raise RequestException."""
    known = session.get("campaignRepos")
    found = known.get(full_name.lower()) if isinstance(known, dict) else None
    if found is not None and time.time() - found < CAMPAIGN_REPO_CHECK_S:
        return True
    fetch_repository = app_module().fetch_repository
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


# GitHub's answer to the write check's repository lookup, when it is neither
# the repository nor 404: an ended session (401) and a rate limit keep GitHub's
# status and rate-limit headers and are marked as GitHub's, so the app reads
# them as it reads any GitHub answer; any other failure is a 502.
RATE_LIMIT_HEADERS = (
    "Retry-After",
    "X-RateLimit-Limit",
    "X-RateLimit-Remaining",
    "X-RateLimit-Reset",
    "X-RateLimit-Resource",
)


def repository_lookup_failure(upstream):
    status = upstream.status_code
    rate_limited = status == 429 or (
        status == 403 and upstream.headers.get("X-RateLimit-Remaining") == "0"
    )
    if status == 401 or rate_limited:
        try:
            body = upstream.json()
        except ValueError:
            body = None
        message = body.get("message", "") if isinstance(body, dict) else ""
        response = jsonify(message=message or "GitHub refused the request")
        response.status_code = status
        for name in RATE_LIMIT_HEADERS:
            if name in upstream.headers:
                response.headers[name] = upstream.headers[name]
        response.headers["X-Lets-Encode-Upstream"] = "github"
        return response
    return (
        jsonify(
            error="GitHub could not be asked whether this is a campaign repository ({})".format(
                status
            )
        ),
        502,
    )


def write_outside_campaigns(path):
    """
    Whether this write goes to a repository other than a campaign repository
    or, for /generate, to a template other than the campaign template.
    """
    if request.method == "GET" or graphql_query(path):
        return False
    match = _REPO_PATH.fullmatch(path)
    if not match:
        return True
    full_name, rest = match.group(1), match.group(2) or ""
    if rest == "/generate":
        return full_name.lower() != CAMPAIGN_TEMPLATE
    return not campaign_repository(full_name)


def refused(event, error, path):
    """A 403 from the broker for a request it does not relay, logged."""
    current_app.logger.warning(
        "github_api %s",
        json.dumps(
            {
                "source": "broker",
                "event": event,
                "method": request.method,
                "endpoint": path,
                "user": session.get("userLogin"),
            },
            separators=(",", ":"),
        ),
    )
    response = jsonify(error=error, source="broker")
    response.status_code = 403
    response.headers["X-Lets-Encode-Upstream"] = "broker"
    return response


def relay_refusal(path):
    """
    The broker's answer when the proxy may not relay this request to the
    api.github.com `path`, or None when it may.
    """
    # A "." or ".." segment would move the request to another endpoint:
    # requests resolves them before sending.
    if any(segment in (".", "..") for segment in path.split("/")):
        return jsonify(error="Path not allowed"), 400
    routes = PROXY_ROUTES.get(request.method)
    if (
        routes is None
        or not routes.fullmatch(path)
        or write_beyond_the_app(path)
    ):
        return refused(
            "endpoint_refused", "That GitHub endpoint is not relayed", path
        )
    try:
        outside = write_outside_campaigns(path)
    except requests.Timeout:
        return jsonify(error="Upstream request timed out"), 504
    except RepositoryLookupFailed as e:
        return repository_lookup_failure(e.response)
    except (requests.RequestException, ValueError):
        return jsonify(error="Upstream request failed"), 502
    if outside:
        return refused(
            "write_refused", "Writes go to campaign repositories only", path
        )
    return None


_MOVED_REPO = re.compile(r"/repositories/(\d+)(/.*)?")


def moved_repository_url(location):
    """
    The URL a GitHub redirect to /repositories/<id>/… stands for under the
    repository's current name, with the redirect's query; None for any other
    redirect or when GitHub does not show the repository.
    """
    parts = urlsplit(location)
    match = _MOVED_REPO.fullmatch(parts.path)
    if (
        parts.scheme != "https"
        or parts.netloc not in ALLOWED_DOMAINS
        or not match
    ):
        return None
    lookup = requests.get(
        "{}/repositories/{}".format(GITHUB_API, match.group(1)),
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": "token " + session["githubToken"],
        },
        timeout=(10, 30),
    )
    full_name = json_field(lookup, "full_name") if lookup.ok else None
    if not isinstance(full_name, str) or not _REPO_PATH.fullmatch(
        "/repos/" + full_name
    ):
        return None
    return urlunsplit(
        (
            "https",
            parts.netloc,
            "/repos/" + quote(full_name) + (match.group(2) or ""),
            parts.query,
            "",
        )
    )


@github_proxy.route(
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
    if not signed_in():
        return jsonify(error="Authentication required"), 401
    # The server has already percent-decoded the path. Quoting it again keeps
    # a literal %, ? or # in a file name inside the path GitHub receives.
    url = quote(url, safe="/:")
    if not url.startswith("http"):
        url = "https://" + url
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc not in ALLOWED_DOMAINS:
        return jsonify(error="Domain not allowed"), 400
    refusal = relay_refusal(parsed.path)
    if refusal is not None:
        return refusal
    path = parsed.path
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
    # A GraphQL query goes upstream as parsed, so GitHub reads the same query
    # graphql_query checked, whatever duplicate keys the raw body held.
    body = (
        json.dumps(request.get_json(force=True, silent=True))
        if parsed.path == "/graphql"
        else request.get_data()
    )

    # Timeout protects gunicorn workers from being parked indefinitely by a
    # hung upstream connection: 10s to connect, 60s between reads.
    started_at = time.monotonic()
    try:
        response = requests.request(
            request.method,
            url,
            headers=headers,
            data=body,
            timeout=(10, 60),
            allow_redirects=False,
        )
        # A renamed or transferred repository answers its old name with a
        # redirect to /repositories/<id>/…. The request is sent once more,
        # to the repository's current name, after the same checks.
        if response.status_code in (301, 302, 307, 308):
            moved = moved_repository_url(
                requests.structures.CaseInsensitiveDict(
                    response.raw.headers
                ).get("Location", "")
            )
            if moved is None:
                return (
                    jsonify(
                        error="GitHub redirected the request elsewhere",
                        source="broker",
                    ),
                    502,
                )
            path = urlsplit(moved).path
            refusal = relay_refusal(path)
            if refusal is not None:
                return refusal
            url = moved
            response = requests.request(
                request.method,
                url,
                headers=headers,
                data=body,
                timeout=(10, 60),
                allow_redirects=False,
            )
    except requests.Timeout:
        return jsonify(error="Upstream request timed out"), 504
    except requests.RequestException:
        return jsonify(error="Upstream request failed"), 502
    if (
        request.method == "POST"
        and path.endswith("/generate")
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
    current_app.logger.info(
        "github_api %s",
        json.dumps(
            {
                "source": "github",
                "method": request.method,
                "endpoint": path,
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
