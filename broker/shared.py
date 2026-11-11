"""
What several of the broker's blueprints use: the rate limiter and the
client address it keys on, reading a JSON field from an upstream answer,
and the module that created the running app.
"""

import ipaddress
import sys
from os import getenv

from flask import current_app
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address


# Rate-limit counters live in the storage RATELIMIT_STORAGE_URI names. The
# default memory:// keeps them in-process (gunicorn_config.py runs one worker),
# and counters reset on restart. Point the URI at redis/memcached to share
# counters between processes.
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
    default_limits=["20 per second"],
    storage_uri=getenv("RATELIMIT_STORAGE_URI") or "memory://",
)


def json_field(response, name):
    """The `name` field of a JSON object body, or None."""
    try:
        body = response.json()
    except ValueError:
        return None
    return body.get(name) if isinstance(body, dict) else None


def app_module():
    """
    The module that created the running Flask app: app.py, under whichever
    name it was imported. The blueprints read the names test_app.py patches
    on app.py through it, at call time.
    """
    return sys.modules[current_app.import_name]
