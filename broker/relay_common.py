"""
What the IIIF and OMR relays share: the relay slots and buffer cap of a
worker process, the download deadline, the daily allowances per login,
and the headers of a relayed body.
"""

import functools
import json
import threading
import time
from os import getenv

import urllib3
from flask import current_app, g, jsonify, session

try:
    from .registry import signed_in
    from .relay_db import seconds_to_next_day
    from .shared import app_module
except ImportError:
    # Run as a top-level module (flask --app app run, gunicorn app:app).
    from registry import signed_in
    from relay_db import seconds_to_next_day
    from shared import app_module

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

# Headers on relayed third-party bodies. The relays answer in the app origin, so
# a body opened directly in a tab (an SVG or HTML document) would otherwise run
# script with the session cookie. fetch() ignores all three.
RELAY_SAFETY_HEADERS = [
    ("Content-Disposition", "attachment"),
    ("X-Content-Type-Options", "nosniff"),
    ("Content-Security-Policy", "sandbox"),
]


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
    relay_store = app_module().relay_store
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
    relay_store = app_module().relay_store
    login = session.get("userLogin")
    relay_store.add(login, kind, amount)
    current_app.logger.info(
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
        if not signed_in():
            return view(*args, **kwargs)
        login = session.get("userLogin")
        relay_use = app_module().relay_use
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
            response = current_app.make_response(view(*args, **kwargs))
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
    relay_use = app_module().relay_use
    RELAY_BUFFER_BYTES = app_module().RELAY_BUFFER_BYTES
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
