"""Offline replay proxy tests. No lifespan tasks or external services are started."""
from __future__ import annotations

import ast
import asyncio
from contextlib import asynccontextmanager
import gc
import importlib.util
from pathlib import Path
from threading import BoundedSemaphore
import tracemalloc
import unittest
from unittest.mock import patch

import anyio
from fastapi import FastAPI, HTTPException
import httpx

from app import dcssb, track_downloads as downloads


class ReplayStream(httpx.AsyncByteStream):
    def __init__(self, chunks=(), *, error=None, block=None):
        self.chunks = chunks
        self.error = error
        self.block = block
        self.reads = 0
        self.closed = False
        self.read_started = asyncio.Event()

    async def __aiter__(self):
        self.read_started.set()
        if self.block:
            await self.block.wait()
        for chunk in self.chunks:
            self.reads += 1
            yield chunk
        if self.error:
            raise self.error

    async def aclose(self):
        # A checkpoint proves cleanup survives AnyIO level cancellation.
        await anyio.sleep(0)
        self.closed = True


class Harness:
    def __init__(self, stream=None, *, status=200, headers=None, open_error=None):
        self.stream = stream if stream is not None else ReplayStream([b"track"])
        self.response = httpx.Response(status, headers=headers, stream=self.stream)
        self.open_error = open_error
        self.opens = 0
        self.exited = False
        self.sent = []
        self.disconnect = asyncio.Event()
        self.scope = {"type": "http", "asgi": {"spec_version": "2.4"}}

    @asynccontextmanager
    async def upstream(self, *args):
        self.opens += 1
        try:
            if self.open_error:
                raise self.open_error
            yield self.response
        finally:
            with anyio.CancelScope(shield=True):
                await self.response.aclose()
                self.exited = True

    async def receive(self):
        await self.disconnect.wait()
        return {"type": "http.disconnect"}

    async def send(self, message):
        self.sent.append(message)

    async def run(self, send=None):
        with patch.object(dcssb, "stream_track_file", self.upstream):
            await self.execute(send)

    async def execute(self, send=None):
        await downloads.TrackDownloadResponse("server1", "replay.trk")(
            self.scope, self.receive, send or self.send
        )

    @property
    def status(self):
        return self.sent[0]["status"]

    @property
    def headers(self):
        return dict(self.sent[0]["headers"])

    @property
    def body(self):
        return b"".join(x.get("body", b"") for x in self.sent)


class DownloadTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.slots = BoundedSemaphore(2)
        self.patch_slots = patch.object(downloads, "DOWNLOAD_SLOTS", self.slots)
        self.patch_slots.start()
        self.addCleanup(self.patch_slots.stop)

    def assert_slots_released(self):
        self.assertTrue(self.slots.acquire(blocking=False))
        self.assertTrue(self.slots.acquire(blocking=False))
        self.assertFalse(self.slots.acquire(blocking=False))
        self.slots.release()
        self.slots.release()

    async def test_success_raw_chunks_headers_and_cleanup(self):
        body = b"x" * (downloads.CHUNK_SIZE * 2 + 17)
        h = Harness(ReplayStream([body]), headers={"Content-Length": str(len(body)), "X-Internal": "secret", "Set-Cookie": "secret"})
        await h.run()
        self.assertEqual(h.status, 200)
        self.assertEqual(h.body, body)
        self.assertEqual(h.headers[b"content-length"], str(len(body)).encode())
        self.assertEqual(h.headers[b"content-type"], b"application/octet-stream")
        self.assertEqual(h.headers[b"content-disposition"], b'attachment; filename="replay.trk"')
        self.assertNotIn(b"x-internal", h.headers)
        self.assertNotIn(b"set-cookie", h.headers)
        self.assertLessEqual(max(len(x.get("body", b"")) for x in h.sent), downloads.CHUNK_SIZE)
        self.assertTrue(h.exited and h.stream.closed)
        self.assert_slots_released()

    async def test_no_upstream_open_before_asgi_execution(self):
        h = Harness()
        with patch.object(dcssb, "stream_track_file", h.upstream):
            downloads.TrackDownloadResponse("server1", "replay.trk")
        self.assertEqual(h.opens, 0)
        self.assert_slots_released()

    async def test_missing_length_streams_without_inventing_length(self):
        h = Harness()
        await h.run()
        self.assertEqual(h.body, b"track")
        self.assertNotIn(b"content-length", h.headers)
        self.assert_slots_released()

    async def test_empty_file(self):
        h = Harness(ReplayStream([]), headers={"content-length": "0"})
        await h.run()
        self.assertEqual(h.status, 200)
        self.assertEqual(h.body, b"")
        self.assertEqual(h.headers[b"content-length"], b"0")
        self.assert_slots_released()

    async def test_bad_statuses_do_not_read_or_expose_error_body(self):
        for status, expected in [(400, 400), (404, 404), (401, 502), (403, 502), (302, 502), (500, 502), (206, 502)]:
            with self.subTest(status=status):
                h = Harness(ReplayStream([b"http://internal/?key=secret"]), status=status)
                await h.run()
                self.assertEqual(h.status, expected)
                self.assertEqual(h.stream.reads, 0)
                self.assertNotIn(b"secret", h.body)
                self.assertTrue(h.exited and h.stream.closed)
                self.assert_slots_released()

    async def test_connect_and_timeout_errors_are_sanitized(self):
        for error in [httpx.ConnectError("internal key secret"), httpx.ReadTimeout("internal key secret"), RuntimeError("internal key secret")]:
            with self.subTest(error=type(error)):
                h = Harness(open_error=error)
                with self.assertLogs(downloads.logger, level="WARNING") as logs:
                    await h.run()
                self.assertEqual(h.status, 502)
                self.assertNotIn(b"secret", h.body)
                self.assertNotIn("secret", "".join(logs.output))
                self.assert_slots_released()

    async def test_invalid_lengths_rejected_before_success_headers(self):
        for length in ["-1", "+3", "3, 3", "3x", "", "9" * 21]:
            with self.subTest(length=length):
                h = Harness(headers={"content-length": length})
                await h.run()
                self.assertEqual(h.status, 502)
                self.assertEqual(h.stream.reads, 0)
                self.assert_slots_released()

    async def test_non_identity_encoding_rejected(self):
        for encoding in ["gzip", "br", "identity, gzip"]:
            with self.subTest(encoding=encoding):
                h = Harness(headers={"content-encoding": encoding})
                await h.run()
                self.assertEqual(h.status, 502)
                self.assertEqual(h.stream.reads, 0)
                self.assert_slots_released()

    async def test_short_or_long_body_aborts_without_final_success(self):
        for length in ["1", "10"]:
            with self.subTest(length=length):
                h = Harness(headers={"content-length": length})
                with self.assertRaises(BaseExceptionGroup) as caught:
                    await h.run()
                self.assertIn("replay download interrupted", str(caught.exception.exceptions[0]))
                self.assertEqual(h.status, 200)
                self.assertFalse(any(x.get("more_body") is False for x in h.sent))
                self.assertTrue(h.exited and h.stream.closed)
                self.assert_slots_released()

    async def test_midstream_read_failure_aborts_and_cleans_up(self):
        h = Harness(ReplayStream([b"x" * downloads.CHUNK_SIZE], error=httpx.ReadError("secret internal URL")))
        with self.assertRaises(BaseExceptionGroup) as caught:
            await h.run()
        self.assertNotIn("secret", str(caught.exception.exceptions[0]))
        self.assertFalse(any(x.get("more_body") is False for x in h.sent))
        self.assertTrue(h.exited and h.stream.closed)
        self.assert_slots_released()

    async def test_send_failure_before_first_chunk_cleans_up(self):
        for fail_on in ["http.response.start", "http.response.body"]:
            h = Harness()
            async def send(message):
                if message["type"] == fail_on:
                    raise OSError("client disconnected")
            with self.assertRaises(BaseExceptionGroup):
                await h.run(send)
            self.assertTrue(h.exited and h.stream.closed)
            self.assert_slots_released()

    async def test_error_response_send_failure_never_starts_twice(self):
        h = Harness(status=404)
        async def broken_send(message):
            await h.send(message)
            raise OSError("client disconnected")
        with self.assertRaises(BaseExceptionGroup):
            await h.run(broken_send)
        self.assertEqual(len(h.sent), 1)
        self.assertEqual(h.status, 404)
        self.assertTrue(h.stream.closed)
        self.assert_slots_released()

    async def test_disconnect_while_waiting_for_first_chunk(self):
        h = Harness(ReplayStream(block=asyncio.Event()))
        task = asyncio.create_task(h.run())
        await asyncio.wait_for(h.stream.read_started.wait(), 1)
        h.disconnect.set()
        await asyncio.wait_for(task, 1)
        self.assertTrue(h.exited and h.stream.closed)
        self.assert_slots_released()

    async def test_disconnect_during_upstream_connection_setup(self):
        h = Harness()
        opened = asyncio.Event()
        closed = asyncio.Event()
        @asynccontextmanager
        async def waiting_upstream(*args):
            try:
                opened.set()
                await asyncio.Event().wait()
                yield h.response
            finally:
                with anyio.CancelScope(shield=True):
                    await anyio.sleep(0)
                    closed.set()
        h.upstream = waiting_upstream
        task = asyncio.create_task(h.run())
        await asyncio.wait_for(opened.wait(), 1)
        h.disconnect.set()
        await asyncio.wait_for(task, 1)
        self.assertTrue(closed.is_set())
        self.assertEqual(h.sent, [])
        self.assert_slots_released()

    async def test_outer_cancellation_closes_and_releases(self):
        h = Harness(ReplayStream(block=asyncio.Event()))
        task = asyncio.create_task(h.run())
        await asyncio.wait_for(h.stream.read_started.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(h.exited and h.stream.closed)
        self.assert_slots_released()

    async def test_backpressure_does_not_prefetch(self):
        h = Harness(ReplayStream([b"a" * downloads.CHUNK_SIZE] * 3))
        sending = asyncio.Event()
        resume = asyncio.Event()
        async def slow_send(message):
            if message.get("body"):
                sending.set()
                await resume.wait()
            await h.send(message)
        task = asyncio.create_task(h.run(slow_send))
        await asyncio.wait_for(sending.wait(), 1)
        self.assertEqual(h.stream.reads, 1)
        await anyio.sleep(0.01)
        self.assertEqual(h.stream.reads, 1)
        h.disconnect.set()
        await asyncio.wait_for(task, 1)
        self.assertTrue(h.stream.closed)
        self.assert_slots_released()

    async def test_real_concurrent_admission_fails_fast_and_recovers(self):
        opened = 0
        ready = asyncio.Event()
        resume = asyncio.Event()
        streams = []
        @asynccontextmanager
        async def upstream(*args):
            nonlocal opened
            opened += 1
            stream = ReplayStream([b"ok"], block=resume)
            streams.append(stream)
            if opened == 2:
                ready.set()
            try:
                yield httpx.Response(200, stream=stream)
            finally:
                with anyio.CancelScope(shield=True):
                    await stream.aclose()
        a, b, excess = Harness(), Harness(), Harness()
        with patch.object(dcssb, "stream_track_file", upstream):
            first = asyncio.create_task(a.execute())
            second = asyncio.create_task(b.execute())
            await asyncio.wait_for(ready.wait(), 1)
            await asyncio.wait_for(excess.execute(), 1)
            self.assertEqual(excess.status, 503)
            self.assertEqual(excess.headers[b"retry-after"], b"5")
            self.assertEqual(opened, 2)
            resume.set()
            await asyncio.gather(first, second)
            excess.sent.clear()
            await excess.execute()
        self.assertEqual(excess.status, 200)
        self.assertEqual(excess.body, b"ok")
        self.assertEqual(opened, 3)
        self.assertTrue(all(s.closed for s in streams))
        self.assert_slots_released()

    async def test_cleanup_failure_still_releases_slot(self):
        h = Harness()
        @asynccontextmanager
        async def broken_close(*args):
            yield h.response
            raise RuntimeError("secret close error")
        h.upstream = broken_close
        with self.assertRaises(BaseExceptionGroup):
            await h.run()
        self.assert_slots_released()

    async def test_large_generated_transfer_has_bounded_python_memory(self):
        # Generate 256 MiB lazily and discard each downstream chunk. Never store
        # the file or ASGI messages. This would catch r.content/list accumulation.
        count = 4096
        stream = ReplayStream((bytes(downloads.CHUNK_SIZE) for _ in range(count)))
        h = Harness(stream, headers={"content-length": str(count * downloads.CHUNK_SIZE)})
        total = 0
        largest = 0
        async def discard(message):
            nonlocal total, largest
            chunk = message.get("body", b"")
            total += len(chunk)
            largest = max(largest, len(chunk))
            await anyio.sleep(0)
        gc.collect()
        tracemalloc.start()
        try:
            await h.run(discard)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(total, 256 * 1024 * 1024)
        self.assertEqual(largest, downloads.CHUNK_SIZE)
        self.assertLess(peak, 3 * 1024 * 1024, f"peak Python allocations: {peak}")
        print(f"256 MiB replay: peak traced Python allocations={peak:,} bytes")
        self.assertTrue(stream.closed)
        self.assert_slots_released()


class HelperTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_client_stream_options_and_close(self):
        stream = ReplayStream([b"file"])
        requests = []
        options = []
        clients = []
        actual_client = httpx.AsyncClient
        async def handle(request):
            requests.append(request)
            return httpx.Response(200, headers={"content-length": "4"}, stream=stream)
        def factory(**kwargs):
            options.append(kwargs)
            client = actual_client(**kwargs, transport=httpx.MockTransport(handle))
            clients.append(client)
            return client
        with patch.object(dcssb.httpx, "AsyncClient", factory), patch.object(dcssb, "DCSSB_API_KEY", "test-key"):
            async with dcssb.stream_track_file("server1", "test.trk") as response:
                self.assertEqual(stream.reads, 0)
                self.assertEqual(b"".join([c async for c in response.aiter_raw()]), b"file")
                self.assertFalse(clients[0].is_closed)
        self.assertTrue(clients[0].is_closed and stream.closed)
        self.assertFalse(options[0]["follow_redirects"])
        self.assertFalse(options[0]["trust_env"])
        self.assertEqual(options[0]["limits"].max_connections, 1)
        self.assertEqual(options[0]["timeout"].read, 60.0)
        self.assertEqual(requests[0].headers["accept-encoding"], "identity")
        self.assertEqual(requests[0].headers["x-api-key"], "test-key")
        self.assertEqual(requests[0].url.path, "/tracks/server1/test.trk")

    async def test_actual_helper_closes_client_on_open_error(self):
        clients = []
        actual_client = httpx.AsyncClient
        async def handle(request):
            raise httpx.ConnectError("test failure")
        def factory(**kwargs):
            client = actual_client(**kwargs, transport=httpx.MockTransport(handle))
            clients.append(client)
            return client
        with patch.object(dcssb.httpx, "AsyncClient", factory):
            with self.assertRaises(httpx.ConnectError):
                async with dcssb.stream_track_file("server1", "test.trk"):
                    self.fail("must not yield")
        self.assertTrue(clients[0].is_closed)

    async def test_actual_helper_closes_client_on_connect_cancellation(self):
        clients = []
        connecting = asyncio.Event()
        actual_client = httpx.AsyncClient
        async def handle(request):
            connecting.set()
            await asyncio.Event().wait()
        def factory(**kwargs):
            client = actual_client(**kwargs, transport=httpx.MockTransport(handle))
            clients.append(client)
            return client
        h = Harness()
        with patch.object(dcssb.httpx, "AsyncClient", factory):
            task = asyncio.create_task(h.execute())
            await asyncio.wait_for(connecting.wait(), 1)
            h.disconnect.set()
            await asyncio.wait_for(task, 1)
        self.assertTrue(clients[0].is_closed)
        self.assertEqual(h.sent, [])

    async def test_actual_client_closes_when_send_fails(self):
        stream = ReplayStream([b"file"])
        clients = []
        actual_client = httpx.AsyncClient
        async def handle(request):
            return httpx.Response(200, stream=stream)
        def factory(**kwargs):
            client = actual_client(**kwargs, transport=httpx.MockTransport(handle))
            clients.append(client)
            return client
        h = Harness()
        async def broken_send(message):
            raise OSError("client disconnected")
        with patch.object(dcssb.httpx, "AsyncClient", factory):
            with self.assertRaises(BaseExceptionGroup):
                await h.execute(broken_send)
        self.assertTrue(stream.closed and clients[0].is_closed)

    async def test_actual_helper_closes_under_anyio_cancellation(self):
        stream = ReplayStream(block=asyncio.Event())
        clients = []
        actual_client = httpx.AsyncClient
        async def handle(request):
            return httpx.Response(200, stream=stream)
        def factory(**kwargs):
            client = actual_client(**kwargs, transport=httpx.MockTransport(handle))
            clients.append(client)
            return client
        with patch.object(dcssb.httpx, "AsyncClient", factory):
            with anyio.CancelScope() as scope:
                async with dcssb.stream_track_file("server1", "test.trk"):
                    scope.cancel()
                    await anyio.sleep(0)
        self.assertTrue(stream.closed and clients[0].is_closed)


class ConfigurationTests(unittest.TestCase):
    def test_download_limit_validation(self):
        for valid in ["1", "2", "64"]:
            self.assertEqual(downloads._download_limit(valid), int(valid))
        for invalid in ["0", "-1", "65", "2.0", "", " 2", "two", "１２"]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                downloads._download_limit(invalid)


class RouteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Compile the exact route/validators independently of unrelated optional
        # DB/template dependencies. FullApplicationTests also imports the app.
        tree = ast.parse(Path("app/main.py").read_text())
        names = {"_TRACK_SERVER_RE", "_TRACK_FILENAME_RE", "proxy_track_download"}
        nodes = [n for n in tree.body if (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in names for t in n.targets)) or (isinstance(n, ast.AsyncFunctionDef) and n.name in names)]
        import re
        self.app = FastAPI()
        namespace = {"re": re, "HTTPException": HTTPException, "TrackDownloadResponse": downloads.TrackDownloadResponse, "app": self.app}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "app/main.py", "exec"), namespace)
        self.route = namespace["proxy_track_download"]

    async def test_valid_route_returns_stream(self):
        response = await self.route("server-1", "replay_2026.10.trk")
        self.assertIsInstance(response, downloads.TrackDownloadResponse)

    async def test_invalid_names_rejected_before_open(self):
        bad = [("a\n", "x.trk"), ("../a", "x.trk"), ("a", "../x.trk"), ("a", "x.trk\n"), ("a", 'x".trk'), ("a", "x\\y.trk"), ("a", "x.txt"), ("a", "x.trk?secret"), ("a", "x.trk\x00")]
        for server, filename in bad:
            with self.subTest(server=server, filename=filename), self.assertRaises(HTTPException) as caught:
                await self.route(server, filename)
            self.assertEqual(caught.exception.status_code, 400)

    async def test_fastapi_asgi_success_and_error(self):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test") as client:
            for upstream_status, expected in [(200, 200), (404, 404), (500, 502)]:
                h = Harness(status=upstream_status)
                with patch.object(dcssb, "stream_track_file", h.upstream):
                    response = await client.get("/proxy/tracks/server1/replay.trk")
                self.assertEqual(response.status_code, expected)
                self.assertTrue(h.stream.closed)


@unittest.skipUnless(importlib.util.find_spec("psycopg") and importlib.util.find_spec("jinja2"), "full app requires repository psycopg/Jinja2 dependencies")
class FullApplicationTests(unittest.IsolatedAsyncioTestCase):
    async def test_full_app_health_and_download(self):
        from app.main import app
        # ASGITransport does not run lifespan, so no background production calls.
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            self.assertEqual((await client.get("/healthz")).status_code, 200)
            h = Harness(headers={"content-length": "5"})
            with patch.object(dcssb, "stream_track_file", h.upstream):
                response = await client.get("/proxy/tracks/server1/replay.trk")
            self.assertEqual(response.content, b"track")
            self.assertTrue(h.stream.closed)


if __name__ == "__main__":
    unittest.main()
