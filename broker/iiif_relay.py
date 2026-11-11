"""
The /iiif relay: IIIF manifests and canvas images from any institution's
server, fetched for the onboarding wizard, with each hop checked against
the address rules.
"""

import ipaddress
import socket
import time
from urllib.parse import urlsplit

import requests
from flask import Blueprint, current_app, g, jsonify, request, session

try:
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
    from .shared import app_module, client_network, limiter
except ImportError:
    # Run as a top-level module (flask --app app run, gunicorn app:app).
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
    from shared import app_module, client_network, limiter

iiif_relay = Blueprint("iiif_relay", __name__)

# /iiif relay limits. Campaign sources come from any institution's IIIF server,
# so the host cannot be an allowlist; the request is constrained instead — see
# iiif_fetch. A canvas is fetched at the largest size the server gives; the
# cap is GitHub's limit for one file, the most a committed page can be.
IIIF_MAX_BYTES = 100 * 1024 * 1024
IIIF_MAX_REDIRECTS = 5
IIIF_ALLOWED_CONTENT = ("application/json", "application/ld+json", "image/")


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


@iiif_relay.route("/iiif", methods=["GET"])
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
    if not signed_in():
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
        if not parsed.hostname or not app_module().resolves_to_public_address(
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

    # A source's error answer is passed on as its status, marked as the
    # source's, whatever its body: an error page is not relayed.
    if response.status_code >= 400:
        response.close()
        failed = jsonify(
            error="The source answered {}".format(response.status_code)
        )
        failed.status_code = response.status_code
        failed.headers["X-Lets-Encode-Upstream"] = "iiif"
        if "retry-after" in response.headers:
            failed.headers["Retry-After"] = response.headers["retry-after"]
        return failed

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

    return current_app.response_class(
        chunks,
        status=response.status_code,
        headers=[
            *relayed_headers(response, content_type),
            ("X-Lets-Encode-Upstream", "iiif"),
            *RELAY_SAFETY_HEADERS,
        ],
    )
