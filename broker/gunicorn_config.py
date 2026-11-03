# Gunicorn settings for the session broker. Run from broker/:
#
#   PORT=7778 gunicorn -c gunicorn_config.py wsgi:app
#
# One broker process per instance; PORT must match the instance's reverse-proxy
# target (production 7777, staging 7778, testing 7779 — see README.md §6).
# Loopback only: the reverse proxy is the broker's sole client.
import os

bind = "127.0.0.1:" + os.environ.get("PORT", "7778")

# One worker process: flask-limiter's counters (default memory:// storage)
# and the relay slots in app.py are kept per process, so with one process
# they hold as stated. Its threads serve requests concurrently.
workers = 1

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
