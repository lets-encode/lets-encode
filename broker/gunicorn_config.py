# Gunicorn settings for the session broker. Run from broker/:
#
#   gunicorn -c gunicorn_config.py wsgi:app
#
# One broker process per instance, bound to the instance's reverse-proxy
# target. The port is BROKER_PORT of the instance's env file in
# instances-config/, which the checked-out branch selects with the mapping
# vite.config.js uses for the build mode (README.md §6). PORT in the
# environment takes precedence. Loopback only: the reverse proxy is the
# broker's sole client.
import os
from pathlib import Path

from dotenv import dotenv_values

BRANCH_MODES = {
    "main": "production",
    "staging": "staging",
    "testing": "testing",
}


def _port():
    if os.environ.get("PORT"):
        return os.environ["PORT"]
    root = Path(__file__).resolve().parent.parent
    # .git/HEAD holds "ref: refs/heads/<branch>", or a commit id when detached.
    head = (root / ".git" / "HEAD").read_text().strip()
    if not head.startswith("ref: refs/heads/"):
        raise RuntimeError(
            "detached HEAD: set PORT to the instance's broker port"
        )
    mode = BRANCH_MODES.get(
        head.removeprefix("ref: refs/heads/"), "development"
    )
    env_file = root / "instances-config" / f".env.{mode}"
    port = dotenv_values(env_file).get("BROKER_PORT")
    if not port:
        raise RuntimeError(f"{env_file} sets no BROKER_PORT")
    return port


bind = "127.0.0.1:" + _port()

# Sessions and the slug DB live on the shared filesystem (instance/), so
# workers need no coordination beyond the host. flask-limiter's counters do
# NOT: with the default memory:// storage each worker counts separately, so
# the effective rate limits are the stated limits times this worker count
# (set RATELIMIT_STORAGE_URI to share counters — see broker/README.md).
workers = 2

# The IIIF and OMR relays wait on third-party servers. Threads keep a slow
# upstream from occupying a whole worker; app.py holds relay requests to
# RELAY_SLOTS per worker, below `threads`, and gives downloads a deadline.
# With gthread, `timeout` applies to the worker's main loop, not to a request.
worker_class = "gthread"
threads = 8
timeout = 90

# Request log to stdout, so the service manager captures it. The format is
# gunicorn's default with the request path in place of the request line: query
# strings carry OAuth codes, presigned upload URLs and the URLs IIIF sources are
# fetched from.
accesslog = "-"
access_log_format = (
    '%(h)s %(l)s %(u)s %(t)s "%(m)s %(U)s %(H)s" %(s)s %(b)s "%(f)s" "%(a)s"'
)
