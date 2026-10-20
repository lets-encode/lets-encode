import io
import json
import logging
import os
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

_session_dir = tempfile.TemporaryDirectory()
os.environ["FLASK_ENV"] = "development"
os.environ["FLASK_SECRET"] = "test-secret"
os.environ["GITHUB_CLIENT_ID"] = "test-client"
os.environ["GITHUB_CLIENT_SECRET"] = "test-client-secret"
os.environ["SESSION_DIR"] = _session_dir.name
# Wrap the app in ProxyFix as the deployed broker is (one reverse proxy).
os.environ["PROXY_FIX_X_FOR"] = "1"
# Keep the registry's and the relays' import-time stores out of
# broker/instance/ during tests.
os.environ.setdefault("DB_PATH", os.path.join(_session_dir.name, "slugs.db"))
os.environ.setdefault(
    "RELAY_DB_PATH", os.path.join(_session_dir.name, "relay.db")
)

from broker import app as broker  # noqa: E402
from flask.testing import FlaskClient  # noqa: E402


class ClosingClient(FlaskClient):
    """Reads and closes each response, as the server does once it is sent,
    which gives a relay request's slot back (in_relay_slot)."""

    def open(self, *args, **kwargs):
        kwargs.setdefault("buffered", True)
        return super().open(*args, **kwargs)


class BrokerTest(unittest.TestCase):
    def setUp(self):
        broker.app.config["TESTING"] = True
        broker.app.test_client_class = ClosingClient
        self.addCleanup(setattr, broker.app, "test_client_class", None)
        self.client = broker.app.test_client()
        patcher = patch.object(broker, "relay_use", broker.RelayUse())
        patcher.start()
        self.addCleanup(patcher.stop)
        relay_dir = tempfile.TemporaryDirectory()
        self.addCleanup(relay_dir.cleanup)
        self.relay_store = broker.RelayStore(
            os.path.join(relay_dir.name, "relay.db")
        )
        patcher = patch.object(broker, "relay_store", self.relay_store)
        patcher.start()
        self.addCleanup(patcher.stop)

    def authenticate(self, login="alice"):
        with self.client.session_transaction() as current:
            current["githubToken"] = "server-side-token"
            current["userLogin"] = login

    def test_return_path_is_same_origin_and_auth_error_preserves_query(self):
        self.assertEqual(
            broker.safe_return_path("/campaign/my-campaign?view=table"),
            "/campaign/my-campaign?view=table",
        )
        for unsafe in (
            "https://evil.test/",
            "//evil.test/",
            "///evil.test/",
            "/\\evil.test/",
            "javascript:alert(1)",
        ):
            self.assertEqual(broker.safe_return_path(unsafe), "/")

        # A failed login comes back as a code, never as the error's text.
        declined = RuntimeError("the user declined <b>")
        declined.error = "access_denied"
        for error, code in (
            (declined, "denied"),
            (RuntimeError("x"), "failed"),
        ):
            with self.client.session_transaction() as current:
                current["return_to"] = "/campaign/my-campaign?view=table"
            with patch.object(
                broker.github, "authorize_access_token", side_effect=error
            ):
                response = self.client.get("/authorize")
            location = urlsplit(response.headers["Location"])
            self.assertEqual(location.path, "/campaign/my-campaign")
            self.assertEqual(
                parse_qs(location.query),
                {"view": ["table"], "auth_error": [code]},
            )

    def test_login_uses_state_pkce_and_the_required_scopes(self):
        response = self.client.get("/login?return_to=/campaign")
        params = parse_qs(urlsplit(response.headers["Location"]).query)

        self.assertEqual(params["scope"], ["public_repo notifications"])
        self.assertEqual(params["code_challenge_method"], ["S256"])
        self.assertTrue(params["code_challenge"][0])
        self.assertTrue(params["state"][0])

    def test_login_is_rate_limited_per_address(self):
        broker.limiter.reset()
        self.addCleanup(broker.limiter.reset)
        statuses = [self.client.get("/login").status_code for _ in range(31)]
        self.assertEqual(statuses[:30], [302] * 30)
        self.assertEqual(statuses[30], 429)

    def test_session_files_are_removed_when_expired_and_not_for_their_number(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            files = broker.SessionFiles(directory)
            with patch("cachelib.file.time", return_value=time.time() - 86400):
                files.set("expired", {"userLogin": "a"}, timeout=3600)
            # More live files than a FileSystemCache threshold of 1000 keeps.
            for n in range(1001):
                files.set(f"live-{n}", {"userLogin": "b"}, timeout=3600)
            files._next_sweep = 0
            files.set("next", {"userLogin": "c"}, timeout=3600)

            self.assertFalse(os.path.exists(files._get_filename("expired")))
            for n in range(1001):
                self.assertTrue(
                    os.path.exists(files._get_filename(f"live-{n}"))
                )

    def test_proxy_requires_authentication_and_rejects_other_hosts(self):
        self.assertEqual(
            self.client.get("/proxy/api.github.com/user").status_code, 401
        )
        self.authenticate()
        self.assertEqual(
            self.client.get("/proxy/api.github.com.evil.test/user").status_code,
            400,
        )

    def test_a_request_extends_the_session_lifetime(self):
        lifetime = int(broker.app.permanent_session_lifetime.total_seconds())
        upstream = SimpleNamespace(
            content=b'{"login":"alice"}',
            status_code=200,
            raw=SimpleNamespace(headers={"Content-Type": "application/json"}),
        )
        start = 1_800_000_000
        with patch.object(broker.requests, "request", return_value=upstream):
            with patch("cachelib.file.time", return_value=start):
                self.authenticate()
            with patch("cachelib.file.time", return_value=start + 3600):
                self.client.get("/proxy/api.github.com/user")
            # Past the lifetime counted from login, within it counted from
            # the last request.
            with patch(
                "cachelib.file.time", return_value=start + lifetime + 60
            ):
                kept = self.client.get("/proxy/api.github.com/user")
            with patch(
                "cachelib.file.time",
                return_value=start + 2 * lifetime + 3600,
            ):
                ended = self.client.get("/proxy/api.github.com/user")

        self.assertEqual(kept.status_code, 200)
        self.assertEqual(ended.status_code, 401)

    def test_proxy_replaces_identity_headers_and_filters_the_response(self):
        self.authenticate()
        upstream = SimpleNamespace(
            content=b'{"login":"alice"}',
            status_code=200,
            raw=SimpleNamespace(
                headers={
                    "ETag": '"user-v1"',
                    "Cache-Control": "private",
                    "Set-Cookie": "upstream=bad; Path=/",
                    "Content-Type": "application/json",
                    "X-RateLimit-Resource": "core",
                    "X-RateLimit-Limit": "5000",
                    "X-RateLimit-Remaining": "4998",
                    "X-GitHub-Request-Id": "request-1",
                }
            ),
        )

        with patch.object(
            broker.requests, "request", return_value=upstream
        ) as request_upstream:
            with self.assertLogs(broker.app.logger.name, level="INFO") as logs:
                response = self.client.get(
                    "/proxy/api.github.com/user?detail=full",
                    headers={
                        "Authorization": "Bearer browser-token",
                        "X-Test": "kept",
                    },
                )

        method, url = request_upstream.call_args.args
        options = request_upstream.call_args.kwargs
        self.assertEqual(
            (method, url), ("GET", "https://api.github.com/user?detail=full")
        )
        self.assertEqual(
            options["headers"]["Authorization"], "token server-side-token"
        )
        self.assertNotIn("Cookie", options["headers"])
        self.assertNotIn("Host", options["headers"])
        self.assertEqual(options["headers"]["X-Test"], "kept")
        self.assertFalse(options["allow_redirects"])
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(response.headers["ETag"], '"user-v1"')
        self.assertEqual(response.headers["X-Lets-Encode-Upstream"], "github")
        self.assertNotIn("upstream=bad", response.headers.getlist("Set-Cookie"))
        event = logs.output[0]
        self.assertIn('"endpoint":"/user"', event)
        self.assertIn('"remaining":"4998"', event)
        self.assertIn('"request_id":"request-1"', event)

    def test_proxy_relays_only_the_endpoints_the_app_calls(self):
        # More requests than the proxy's rate limit admits in a second.
        patcher = patch.object(broker.limiter, "enabled", False)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.authenticate()
        upstream = SimpleNamespace(
            content=b"{}", status_code=200, raw=SimpleNamespace(headers={})
        )
        relayed = [
            ("GET", "user"),
            ("GET", "user/orgs?per_page=100"),
            ("GET", "user/123"),
            ("GET", "repositories/42"),
            ("GET", "search/repositories?q=topic:t"),
            ("GET", "repos/o/r"),
            ("GET", "repos/o/r/contents/"),
            ("GET", "repos/o/r/contents/sources/a%20b.mei?ref=T1"),
            ("GET", "repos/o/r/branches/wip-T1"),
            ("GET", "repos/o/r/compare/main...fork:T1"),
            ("GET", "repos/o/r/commits/abc"),
            ("GET", "repos/o/r/git/commits/abc"),
            ("GET", "repos/o/r/git/ref/heads/main"),
            ("GET", "repos/o/r/collaborators/alice/permission"),
            ("GET", "repos/o/r/pulls?state=open"),
            ("GET", "repos/o/r/pulls/7"),
            ("GET", "repos/o/r/pulls/7/files?page=2"),
            ("GET", "repos/o/r/issues/7/comments?per_page=100"),
            ("GET", "repos/o/r/actions/workflows/caller.yml/runs?event=push"),
            ("GET", "repos/o/r/actions/runs/9"),
            ("GET", "repos/o/r/actions/runs/9/jobs"),
            ("GET", "repos/o/r/subscription"),
            ("POST", "repos/t/template/generate"),
            ("POST", "repos/o/r/forks"),
            ("POST", "repos/alice/r/merge-upstream"),
            ("POST", "repos/o/r/pulls"),
            ("POST", "repos/o/r/issues/7/comments"),
            ("POST", "repos/o/r/git/blobs"),
            ("POST", "repos/o/r/git/trees"),
            ("POST", "repos/o/r/git/commits"),
            ("POST", "repos/o/r/git/refs"),
            ("POST", "repos/o/r/actions/workflows/caller.yml/dispatches"),
            ("PATCH", "repos/o/r/pulls/7"),
            ("PATCH", "repos/o/r/git/refs/heads/T1"),
            ("PUT", "repos/o/r/topics"),
            ("PUT", "repos/o/r/subscription"),
            ("DELETE", "repos/o/r/git/refs/heads/wip/T1"),
        ]
        refused = [
            ("DELETE", "repos/o/r"),
            ("PATCH", "repos/o/r"),
            ("POST", "user/repos"),
            ("PUT", "repos/o/r/collaborators/mallory"),
            ("POST", "repos/o/r/keys"),
            ("POST", "repos/o/r/hooks"),
            ("PUT", "repos/o/r/actions/permissions/workflow"),
            ("PUT", "repos/o/r/contents/x.mei"),
            ("DELETE", "repos/o/r/git/refs/tags/v1"),
            ("GET", "user/emails"),
            ("POST", "gists"),
        ]
        with patch.object(
            broker.requests, "request", return_value=upstream
        ) as request_upstream:
            for method, path in relayed:
                response = self.client.open(
                    f"/proxy/api.github.com/{path}", method=method
                )
                self.assertEqual(response.status_code, 200, (method, path))
            self.assertEqual(request_upstream.call_count, len(relayed))
            request_upstream.reset_mock()
            with self.assertLogs(broker.app.logger.name, level="WARNING"):
                for method, path in refused:
                    response = self.client.open(
                        f"/proxy/api.github.com/{path}", method=method
                    )
                    self.assertEqual(response.status_code, 403, (method, path))
                    self.assertEqual(response.get_json()["source"], "broker")
            request_upstream.assert_not_called()

    def test_proxy_refuses_dot_segments(self):
        self.authenticate()
        with patch.object(broker.requests, "request") as upstream:
            for path in (
                "repos/o/r/git/refs/heads/x/%2e%2e/%2e%2e/tags/v1",
                "repos/o/r/contents/./a",
            ):
                response = self.client.delete(f"/proxy/api.github.com/{path}")
                self.assertEqual(response.status_code, 400, path)
            upstream.assert_not_called()

    def test_proxy_keeps_reserved_characters_in_the_path(self):
        self.authenticate()
        upstream = SimpleNamespace(
            content=b"{}", status_code=200, raw=SimpleNamespace(headers={})
        )
        with patch.object(
            broker.requests, "request", return_value=upstream
        ) as request_upstream:
            self.client.get(
                "/proxy/api.github.com/repos/o/r/contents/a%25b%3Fc%23d%20e.mei?ref=main"
            )
        self.assertEqual(
            request_upstream.call_args.args[1],
            "https://api.github.com/repos/o/r/contents/a%25b%3Fc%23d%20e.mei?ref=main",
        )

    def test_request_bodies_over_the_limit_are_rejected(self):
        self.authenticate()
        path = "/proxy/api.github.com/repos/o/r/git/blobs"
        with patch.dict(broker.app.config, {"MAX_CONTENT_LENGTH": 16}):
            with patch.object(broker.requests, "request") as request_upstream:
                declared = self.client.post(path, data=b"x" * 17)
                chunked = self.client.post(
                    path,
                    input_stream=io.BytesIO(b"x" * 17),
                    environ_overrides={"wsgi.input_terminated": True},
                )
        for response in (declared, chunked):
            self.assertEqual(response.status_code, 413)
            self.assertEqual(response.get_json()["source"], "broker")
        request_upstream.assert_not_called()

    def test_broker_rate_limit_is_labeled_separately(self):
        with broker.app.test_request_context("/proxy/api.github.com/user"):
            with self.assertLogs(broker.app.logger.name, level="WARNING"):
                response = broker.broker_rate_limited(None)
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["X-Lets-Encode-Upstream"], "broker")
        self.assertEqual(response.get_json()["source"], "broker")

    def test_proxy_maps_upstream_timeouts(self):
        self.authenticate()
        with patch.object(
            broker.requests, "request", side_effect=broker.requests.Timeout
        ):
            response = self.client.get("/proxy/api.github.com/user")
        self.assertEqual(response.status_code, 504)
        self.assertEqual(
            response.get_json(), {"error": "Upstream request timed out"}
        )

    @staticmethod
    def iiif_response(
        content=b"{}",
        content_type="application/json",
        status=200,
        headers=None,
        read1=None,
    ):
        """An upstream answer whose body arrives in one read; `read1`
        replaces the network read."""
        pending = [content]
        return SimpleNamespace(
            status_code=status,
            is_redirect=False,
            is_permanent_redirect=False,
            headers={"content-type": content_type, **(headers or {})},
            raw=SimpleNamespace(
                read1=read1
                or (
                    lambda _size, decode_content=None: (
                        pending.pop() if pending else b""
                    )
                )
            ),
            close=lambda: None,
        )

    def iiif_get(self, url, upstream, public=True):
        """GET /iiif with the target's address check and upstream fetch stubbed.

        `public` is the resolves_to_public_address return value, or a list of
        per-hop values. Returns (response, upstream_mock)."""
        resolves = (
            {"side_effect": public}
            if isinstance(public, list)
            else {"return_value": public}
        )
        with patch.object(broker, "resolves_to_public_address", **resolves):
            with patch.object(
                broker.requests, "get", return_value=upstream
            ) as upstream_mock:
                response = self.client.get("/iiif?url=" + url)
        return response, upstream_mock

    def assert_relay_safety_headers(self, response):
        self.assertEqual(response.headers["Content-Disposition"], "attachment")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["Content-Security-Policy"], "sandbox")

    def test_iiif_requires_authentication_and_a_url(self):
        self.assertEqual(
            self.client.get("/iiif?url=https://ex.test/m").status_code, 401
        )
        self.authenticate()
        self.assertEqual(self.client.get("/iiif").status_code, 400)

    def test_iiif_rejects_non_https_and_unroutable_hosts(self):
        self.authenticate()
        # A plain-http target never reaches DNS resolution.
        response = self.client.get("/iiif?url=http://ex.test/m")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.get_json()["error"], "Only https URLs are allowed"
        )

        # Anything resolving to a private/loopback address is refused, so the
        # relay cannot be steered at the broker's own network.
        for address in (
            "127.0.0.1",
            "169.254.169.254",
            "10.0.0.5",
            "::1",
            "100.64.0.1",
            "64:ff9b::a9fe:a9fe",
        ):
            with patch.object(
                broker.socket,
                "getaddrinfo",
                return_value=[(None, None, None, None, (address, 0))],
            ):
                with patch.object(broker.requests, "get") as upstream:
                    response = self.client.get("/iiif?url=https://ex.test/m")
                self.assertEqual(response.status_code, 400, address)
                upstream.assert_not_called()

    def test_iiif_relays_without_credentials_and_caps_the_body(self):
        self.authenticate()
        response, upstream = self.iiif_get(
            "https://ex.test/manifest", self.iiif_response(b'{"ok":1}')
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b'{"ok":1}')
        self.assertEqual(response.headers["X-Lets-Encode-Upstream"], "iiif")
        self.assert_relay_safety_headers(response)
        # The session's GitHub token must never be attached to a third party.
        self.assertNotIn("Authorization", upstream.call_args.kwargs["headers"])
        self.assertFalse(upstream.call_args.kwargs["allow_redirects"])

        response, _ = self.iiif_get(
            "https://ex.test/big.jpg",
            self.iiif_response(
                b"x" * (broker.IIIF_MAX_BYTES + 1), "image/jpeg"
            ),
        )
        self.assertEqual(response.status_code, 413)

    def test_iiif_relays_the_body_undecoded_with_its_coding(self):
        self.authenticate()
        response, upstream = self.iiif_get(
            "https://ex.test/manifest",
            self.iiif_response(
                b"\x1f\x8b gzip bytes", headers={"content-encoding": "gzip"}
            ),
        )
        self.assertEqual(response.data, b"\x1f\x8b gzip bytes")
        self.assertEqual(response.headers["Content-Encoding"], "gzip")
        self.assertEqual(
            upstream.call_args.kwargs["headers"]["accept-encoding"], "identity"
        )

    def test_iiif_counts_bytes_per_login_and_refuses_past_the_allowance(self):
        self.assertTrue(broker.app.logger.isEnabledFor(logging.INFO))
        self.authenticate()
        with patch.dict(
            broker.DAILY_ALLOWANCES, {"iiif_bytes": ("IIIF downloads", 10)}
        ):
            with self.assertLogs(broker.app.logger.name, level="INFO") as logs:
                for _ in range(2):
                    response, _ = self.iiif_get(
                        "https://ex.test/p.jpg",
                        self.iiif_response(b"x" * 8, "image/jpeg"),
                    )
                    self.assertEqual(response.status_code, 200)
            self.assertEqual(self.relay_store.used("alice", "iiif_bytes"), 16)
            self.assertEqual(
                json.loads(logs.output[0].split("relay_use ", 1)[1]),
                {
                    "source": "broker",
                    "user": "alice",
                    "kind": "iiif_bytes",
                    "amount": 8,
                    "host": "ex.test",
                },
            )

            # The request that passed the allowance was completed; the next
            # is refused before anything is fetched.
            response, upstream = self.iiif_get(
                "https://ex.test/p.jpg", self.iiif_response(b"x", "image/jpeg")
            )
            self.assertEqual(response.status_code, 429)
            self.assertEqual(response.headers["X-Lets-Encode-Limit"], "daily")
            self.assertEqual(
                response.headers["X-Lets-Encode-Upstream"], "broker"
            )
            self.assertGreater(int(response.headers["Retry-After"]), 0)
            upstream.assert_not_called()

            # Another login has an allowance of its own.
            self.authenticate("bob")
            response, _ = self.iiif_get(
                "https://ex.test/p.jpg", self.iiif_response(b"x", "image/jpeg")
            )
            self.assertEqual(response.status_code, 200)

    def test_relays_cap_requests_in_flight_per_worker_and_login(self):
        self.authenticate()
        for held in (
            {"alice": broker.RELAY_SLOTS_PER_LOGIN},
            {"bob": broker.RELAY_SLOTS},
        ):
            with patch.dict(broker.relay_use.slots, held, clear=True):
                response, upstream = self.iiif_get(
                    "https://ex.test/m", self.iiif_response()
                )
                self.assertEqual(broker.relay_use.slots, held)
            self.assertEqual(response.status_code, 429, held)
            self.assertEqual(
                response.headers["X-Lets-Encode-Upstream"], "broker"
            )
            upstream.assert_not_called()

        # A request holds its slot while it reads and gives it back after.
        seen = []

        def read1(_size, decode_content=None):
            seen.append(dict(broker.relay_use.slots))
            return b""

        response, _ = self.iiif_get(
            "https://ex.test/m", self.iiif_response(read1=read1)
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(seen, [{"alice": 1}])
        self.assertEqual(broker.relay_use.slots, {})

    def test_relays_hold_their_slot_until_the_answer_is_sent(self):
        self.authenticate()
        with patch.object(
            broker, "resolves_to_public_address", return_value=True
        ):
            with patch.object(
                broker.requests,
                "get",
                return_value=self.iiif_response(b"body", "image/jpeg"),
            ):
                response = self.client.get(
                    "/iiif?url=https://ex.test/p.jpg", buffered=False
                )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(broker.relay_use.slots, {"alice": 1})
        self.assertEqual(broker.relay_use.buffered, 4)
        response.close()
        self.assertEqual(broker.relay_use.slots, {})
        self.assertEqual(broker.relay_use.buffered, 0)

    def test_relays_answer_429_past_the_buffer_budget(self):
        self.authenticate()
        with patch.object(broker, "RELAY_BUFFER_BYTES", 3):
            response, _ = self.iiif_get(
                "https://ex.test/p.jpg",
                self.iiif_response(b"body", "image/jpeg"),
            )
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["X-Lets-Encode-Upstream"], "broker")
        self.assertEqual(broker.relay_use.buffered, 0)

    def test_relays_answer_504_past_their_deadline(self):
        self.authenticate()
        now = [0.0]

        def slow_read1(_size, decode_content=None):
            # Each read returns data, but takes longer than the whole deadline.
            now[0] += broker.RELAY_DEADLINE_S + 1
            return b"x"

        with patch.object(broker.time, "monotonic", lambda: now[0]):
            response, _ = self.iiif_get(
                "https://ex.test/big.jpg",
                self.iiif_response(content_type="image/jpeg", read1=slow_read1),
            )
        self.assertEqual(response.status_code, 504)
        self.assertEqual(broker.relay_use.slots, {})

        def timed_out_read1(_size, decode_content=None):
            raise broker.urllib3.exceptions.ReadTimeoutError(
                None, None, "timed out"
            )

        response, _ = self.iiif_get(
            "https://ex.test/big.jpg",
            self.iiif_response(
                content_type="image/jpeg", read1=timed_out_read1
            ),
        )
        self.assertEqual(response.status_code, 504)

    def test_iiif_rejects_unexpected_content_and_revalidates_redirects(self):
        self.authenticate()
        response, _ = self.iiif_get(
            "https://ex.test/page", self.iiif_response(b"<html>", "text/html")
        )
        self.assertEqual(response.status_code, 415)

        # A redirect to a private address must be caught on the second hop.
        redirect = SimpleNamespace(
            status_code=302,
            is_redirect=True,
            is_permanent_redirect=False,
            headers={"location": "https://internal.test/secret"},
            close=lambda: None,
        )
        response, _ = self.iiif_get(
            "https://ex.test/m", redirect, public=[True, False]
        )
        self.assertEqual(response.status_code, 400)

    def test_omr_api_is_gated_configured_and_allowlisted(self):
        self.assertEqual(self.client.get("/omr/api/pipelines").status_code, 401)
        self.authenticate()
        with patch.object(broker, "MUSIBOT_TOKEN", None):
            response = self.client.get("/omr/api/pipelines")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["source"], "musibot")

        with patch.object(broker, "MUSIBOT_TOKEN", "musibot-token"):
            # The page listing and any unlisted endpoint are refused before
            # anything reaches the service.
            with patch.object(broker.requests, "request") as upstream:
                self.assertEqual(
                    self.client.get("/omr/api/musicorpus-pages").status_code,
                    404,
                )
                self.assertEqual(
                    self.client.post("/omr/api/public-sessions").status_code,
                    404,
                )
                self.assertEqual(
                    self.client.get(
                        "/omr/api/musicorpus-pages/abc/pipeline-executions"
                    ).status_code,
                    404,
                )
                upstream.assert_not_called()

            self.relay_store.add_page("p1", "alice")
            relayed = self.omr_response({"execution_id": 7}, 201)
            with patch.object(
                broker.requests, "request", return_value=relayed
            ) as upstream:
                response = self.client.post(
                    "/omr/api/musicorpus-pages/p1/pipeline-executions",
                    data=b'{"pipeline_name":"mzk-staff"}',
                    content_type="application/json",
                )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()["execution_id"], 7)
        self.assertEqual(response.headers["X-Lets-Encode-Upstream"], "musibot")
        self.assert_relay_safety_headers(response)
        method, url = upstream.call_args.args
        self.assertEqual(
            (method, url),
            (
                "POST",
                f"{broker.MUSIBOT_URL}/musicorpus-pages/p1/pipeline-executions",
            ),
        )
        headers = upstream.call_args.kwargs["headers"]
        # The Musibot token goes upstream; the session's GitHub token never does.
        self.assertEqual(headers["Authorization"], "Bearer musibot-token")
        self.assertEqual(
            upstream.call_args.kwargs["data"], b'{"pipeline_name":"mzk-staff"}'
        )

    @staticmethod
    def omr_response(body, status=200):
        """A Musibot API answer with a JSON body."""
        return SimpleNamespace(
            status_code=status,
            ok=status < 400,
            content=json.dumps(body).encode(),
            headers={"content-type": "application/json"},
            json=lambda: body,
        )

    def omr_call(self, method, path, body=None, status=200):
        """One /omr/api call, the service answering `body` with `status`.
        Returns (response, upstream_mock)."""
        with patch.object(broker, "MUSIBOT_TOKEN", "musibot-token"):
            with patch.object(
                broker.requests,
                "request",
                return_value=self.omr_response(body or {}, status),
            ) as upstream:
                response = self.client.open(
                    f"/omr/api/{path}",
                    method=method,
                    json={} if method == "POST" else None,
                )
        return response, upstream

    def test_omr_pages_and_runs_are_relayed_only_to_their_creator(self):
        self.authenticate()
        created, _ = self.omr_call(
            "POST", "musicorpus-pages", {"page_id": "p1"}, 201
        )
        self.assertEqual(created.status_code, 201)
        started, _ = self.omr_call(
            "POST",
            "musicorpus-pages/p1/pipeline-executions",
            {"execution_id": 7, "state": "running"},
            201,
        )
        self.assertEqual(started.status_code, 201)
        for method, path in (
            ("GET", "musicorpus-pages/p1/files"),
            ("POST", "musicorpus-pages/p1/file-urls"),
            ("GET", "musicorpus-pages/p1/pipeline-executions/7"),
            ("DELETE", "musicorpus-pages/p1"),
        ):
            response, upstream = self.omr_call(method, path)
            self.assertEqual(response.status_code, 200, path)
            upstream.assert_called_once()
        self.assertEqual(self.relay_store.used("alice", "omr_runs"), 1)

        # An execution not started on the page through the relay, and every
        # call on another login's page, are refused before anything reaches
        # the service.
        response, upstream = self.omr_call(
            "GET", "musicorpus-pages/p1/pipeline-executions/8"
        )
        self.assertEqual(response.status_code, 404)
        upstream.assert_not_called()
        self.authenticate("bob")
        for method, path in (
            ("GET", "musicorpus-pages/p1/files"),
            ("POST", "musicorpus-pages/p1/file-urls"),
            ("POST", "musicorpus-pages/p1/pipeline-executions"),
            ("GET", "musicorpus-pages/p1/pipeline-executions/7"),
            ("DELETE", "musicorpus-pages/p1"),
        ):
            response, upstream = self.omr_call(method, path)
            self.assertEqual(response.status_code, 404, path)
            upstream.assert_not_called()

    def test_omr_runs_are_refused_past_the_daily_allowance(self):
        self.authenticate()
        self.omr_call("POST", "musicorpus-pages", {"page_id": "p1"}, 201)
        self.relay_store.add(
            "alice", "omr_runs", broker.DAILY_ALLOWANCES["omr_runs"][1]
        )
        response, upstream = self.omr_call(
            "POST",
            "musicorpus-pages/p1/pipeline-executions",
            {"execution_id": 7},
            201,
        )
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["X-Lets-Encode-Limit"], "daily")
        self.assertEqual(response.headers["X-Lets-Encode-Upstream"], "broker")
        self.assertIn("OMR runs", response.get_json()["error"])
        upstream.assert_not_called()

    def test_omr_blob_is_restricted_to_the_service_host_and_capped(self):
        self.assertEqual(
            self.client.get("/omr/blob?url=https://x.test/f").status_code, 401
        )
        self.authenticate()
        for url in (
            "https://evil.test/f",
            f"http://{broker.MUSIBOT_HOST}/f",
            "",
        ):
            with patch.object(broker.requests, "get") as upstream:
                self.assertEqual(
                    self.client.get(f"/omr/blob?url={url}").status_code,
                    400,
                    url,
                )
                upstream.assert_not_called()

        signed = f"https://{broker.MUSIBOT_HOST}/bucket/p1/image.jpg?X-Amz-Signature=abc"
        with patch.object(
            broker.requests,
            "put",
            return_value=SimpleNamespace(
                ok=True, status_code=200, close=lambda: None
            ),
        ) as upstream:
            response = self.client.put(
                f"/omr/blob?url={signed}",
                data=b"jpeg",
                content_type="image/jpeg",
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(upstream.call_args.args[0], signed)
        self.assertEqual(upstream.call_args.kwargs["data"], b"jpeg")
        self.assertEqual(
            upstream.call_args.kwargs["headers"]["Content-Type"], "image/jpeg"
        )

        with patch.object(broker.requests, "put") as upstream:
            response = self.client.put(
                f"/omr/blob?url={signed}",
                data=b"x" * (broker.OMR_MAX_BYTES + 1),
                content_type="image/jpeg",
            )
            self.assertEqual(response.status_code, 413)
            upstream.assert_not_called()

        downloaded = self.iiif_response(b"<score-partwise/>", "application/xml")
        with patch.object(
            broker.requests, "get", return_value=downloaded
        ) as upstream:
            response = self.client.get(f"/omr/blob?url={signed}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b"<score-partwise/>")
        # Untyped whatever the store says, so a file never runs as a script.
        self.assertEqual(
            response.headers["Content-Type"], "application/octet-stream"
        )
        self.assert_relay_safety_headers(response)
        self.assertNotIn(
            "Authorization", upstream.call_args.kwargs.get("headers", {})
        )
        # Both directions count against the login's daily allowance.
        self.assertEqual(
            self.relay_store.used("alice", "omr_bytes"),
            len(b"jpeg") + len(b"<score-partwise/>"),
        )
        self.relay_store.add(
            "alice", "omr_bytes", broker.DAILY_ALLOWANCES["omr_bytes"][1]
        )
        with patch.object(broker.requests, "get") as upstream:
            response = self.client.get(f"/omr/blob?url={signed}")
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["X-Lets-Encode-Limit"], "daily")
        upstream.assert_not_called()

    def test_cross_origin_writes_are_rejected(self):
        # reject_cross_origin_writes runs before any route: a POST whose Origin
        # names another host is refused even without a session.
        response = self.client.post(
            "/logout", headers={"Origin": "https://evil.test"}
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(
            response.get_json(), {"error": "cross-origin request rejected"}
        )
        # The same write from the request's own origin passes the guard.
        response = self.client.post(
            "/logout", headers={"Origin": "http://localhost"}
        )
        self.assertEqual(response.status_code, 200)

    def test_proxied_write_matches_origin_against_forwarded_host(self):
        # Apache forwards with Host set to the broker's loopback address and
        # the public host in X-Forwarded-Host.
        public = "lets-encode.example"
        response = self.client.post(
            "/logout",
            base_url="http://127.0.0.1:7777",
            headers={
                "Origin": f"https://{public}",
                "X-Forwarded-Host": public,
                "X-Forwarded-Proto": "https",
                "X-Forwarded-For": "203.0.113.5",
            },
        )
        self.assertEqual(response.status_code, 200)

    def test_authorize_rotates_the_session_id(self):
        # A session ID fixed before login must not survive into the
        # authenticated session (see app.session_interface.regenerate).
        self.client.get("/login?return_to=/")
        before = self.client.get_cookie("lets_encode_session").value

        token = {"access_token": "fresh-token"}
        user = SimpleNamespace(ok=True, json=lambda: {"login": "alice"})
        with patch.object(
            broker.github, "authorize_access_token", return_value=token
        ):
            with patch.object(broker.github, "get", return_value=user):
                self.client.get("/authorize")

        after = self.client.get_cookie("lets_encode_session").value
        self.assertNotEqual(before, after)
        with self.client.session_transaction() as current:
            self.assertEqual(current["githubToken"], "fresh-token")

    def test_logout_revokes_then_clears_the_session(self):
        self.authenticate()
        with patch.object(broker, "revoke_github_token") as revoke:
            response = self.client.post("/logout")
        revoke.assert_called_once_with("server-side-token")
        self.assertEqual(response.get_json(), {"ok": True})
        with self.client.session_transaction() as current:
            self.assertNotIn("githubToken", current)
            self.assertNotIn("userLogin", current)


if __name__ == "__main__":
    unittest.main()
