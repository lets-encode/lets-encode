"""
The /omr relay: the Musibot OMR service's API calls the app makes, with the
institutional token attached, and file transfers to and from the
service's presigned URLs.
"""

import re
import time
from os import getenv
from urllib.parse import urlsplit

import requests
from flask import Blueprint, current_app, g, jsonify, request, session

try:
    from .iiif_relay import IIIF_MAX_BYTES
    from .registry import signed_in
    from .relay_common import (
        RELAY_DEADLINE_S,
        RELAY_SAFETY_HEADERS,
        RELAY_TIMEOUT,
        count_relay_use,
        daily_allowance_used_up,
        in_relay_slot,
        read_relayed,
        relay_busy,
        relayed_headers,
    )
    from .shared import app_module, client_network, json_field, limiter
except ImportError:
    # Run as a top-level module (flask --app app run, gunicorn app:app).
    from iiif_relay import IIIF_MAX_BYTES
    from registry import signed_in
    from relay_common import (
        RELAY_DEADLINE_S,
        RELAY_SAFETY_HEADERS,
        RELAY_TIMEOUT,
        count_relay_use,
        daily_allowance_used_up,
        in_relay_slot,
        read_relayed,
        relay_busy,
        relayed_headers,
    )
    from shared import app_module, client_network, json_field, limiter

omr_relay = Blueprint("omr_relay", __name__)

# /omr relay: the Musibot OMR service, for the app's OMR preparation. The
# service sends no CORS headers and its API token is institutional, so the
# browser reaches it only through here. Only the endpoints the app uses are
# relayed, matched against these patterns. Every page under the shared
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


def omr_refusal(error, status):
    """The broker's own refusal of an OMR request, marked as the broker's."""
    response = jsonify(error=error, source="musibot")
    response.status_code = status
    response.headers["X-Lets-Encode-Upstream"] = "broker"
    return response


@omr_relay.route("/omr/api/<path:path>", methods=["GET", "POST", "DELETE"])
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
    if not signed_in():
        return jsonify(error="Authentication required"), 401
    MUSIBOT_TOKEN = app_module().MUSIBOT_TOKEN
    relay_store = app_module().relay_store
    if not MUSIBOT_TOKEN:
        return omr_refusal("OMR is not configured on this instance", 503)
    for method, pattern in OMR_ROUTES:
        route = pattern.fullmatch(path) if method == request.method else None
        if route:
            break
    else:
        return omr_refusal("That OMR endpoint is not relayed", 404)
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
        return omr_refusal(
            "That OMR page or run does not belong to this account", 404
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
    elif response.ok and request.method == "DELETE":
        relay_store.remove_page(page_id)
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


@omr_relay.route("/omr/blob", methods=["GET", "PUT"])
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
    if not signed_in():
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
    return current_app.response_class(
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
