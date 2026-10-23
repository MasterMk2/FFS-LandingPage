"""/proxy/tracks のストリーミング中継と同時実行制限 (Issue #3)。

上流 DCSSB は dcssb.TRANSPORT に httpx.MockTransport を差し込んで偽装する。
後始末が「ちょうど 1 回」かは、上流本文の aclose 回数・transport (= client)
の aclose 回数・セマフォの acquire/release 回数で確かめる。
"""
import asyncio
import contextlib
import gzip

import anyio
import httpx
import pytest
from fastapi import Request
from fastapi.testclient import TestClient

from app import dcssb, main
from app.main import app


client = TestClient(app)
LIMIT = 2
MARKER = "SECRET-MARKER-7f3a"
PATH = "/proxy/tracks/server1/mission_2026.trk"


class CountingSemaphore(asyncio.BoundedSemaphore):
    """acquire/release の回数を数える。Bounded なので二重 release は ValueError。"""

    def __init__(self, value: int) -> None:
        super().__init__(value)
        self.acquired = 0
        self.released = 0

    async def acquire(self):
        result = await super().acquire()
        self.acquired += 1
        return result

    def release(self) -> None:
        self.released += 1
        super().release()


class UpstreamBody(httpx.AsyncByteStream):
    """上流の本文。gate を渡すと 1 チャンク目の後で gate が開くまで止まる。"""

    def __init__(self, chunks: list[bytes], gate: asyncio.Event | None = None) -> None:
        self.chunks = chunks
        self.gate = gate
        self.iterated = False
        self.closed = 0

    async def __aiter__(self):
        self.iterated = True
        for i, chunk in enumerate(self.chunks):
            if i == 1 and self.gate is not None:
                await self.gate.wait()
            yield chunk

    async def aclose(self) -> None:
        self.closed += 1


class Upstream(httpx.MockTransport):
    """偽の DCSSB。aclose 回数 = open_track_stream が作った client の close 回数。"""

    def __init__(self, handler) -> None:
        super().__init__(handler)
        self.closed = 0

    async def aclose(self) -> None:
        self.closed += 1


@pytest.fixture(autouse=True)
def fresh_client_counts(monkeypatch):
    counts: dict[str, int] = {}
    monkeypatch.setattr(main, "_track_clients", counts)
    return counts


@pytest.fixture
def slots(monkeypatch):
    sem = CountingSemaphore(LIMIT)
    monkeypatch.setattr(main, "_track_slots", sem)
    return sem


def install(monkeypatch, handler) -> Upstream:
    transport = Upstream(handler)
    monkeypatch.setattr(dcssb, "TRANSPORT", transport)
    return transport


def assert_cleaned_up(slots, transport, body=None) -> None:
    assert slots.acquired == slots.released == 1
    assert transport.closed == 1
    if body is not None:
        assert body.closed == 1
    assert main._track_clients == {}


def test_streams_every_byte_and_passes_content_length(monkeypatch, slots):
    chunks = [bytes([i]) * 256 * 1024 for i in range(8)]  # 2 MiB を 8 チャンクで
    payload = b"".join(chunks)
    body = UpstreamBody(chunks)
    seen: list[httpx.Request] = []

    def handler(request):
        seen.append(request)
        return httpx.Response(
            200, headers={"Content-Length": str(len(payload))}, stream=body
        )

    transport = install(monkeypatch, handler)
    r = client.get(PATH)

    assert r.status_code == 200
    assert r.content == payload
    assert r.headers["content-length"] == str(len(payload))
    assert r.headers["content-type"] == "application/octet-stream"
    assert r.headers["content-disposition"] == 'attachment; filename="mission_2026.trk"'
    assert r.headers["cache-control"] == "private, max-age=0"
    assert seen[0].url.path == "/tracks/server1/mission_2026.trk"
    assert seen[0].headers["accept-encoding"] == "identity"
    assert_cleaned_up(slots, transport, body)


def test_upstream_404_is_404(monkeypatch, slots):
    body = UpstreamBody([b"not found"])
    transport = install(monkeypatch, lambda req: httpx.Response(404, stream=body))

    r = client.get(PATH)

    assert r.status_code == 404
    assert r.json() == {"detail": "track not found"}
    assert_cleaned_up(slots, transport, body)


def test_upstream_500_is_generic_502(monkeypatch, slots):
    body = UpstreamBody([f"Traceback ... {MARKER} at 10.0.0.5".encode()])
    transport = install(monkeypatch, lambda req: httpx.Response(500, stream=body))

    r = client.get(PATH)

    assert r.status_code == 502
    assert r.json() == {"detail": "upstream error"}
    assert MARKER not in r.text
    assert_cleaned_up(slots, transport, body)


def test_upstream_connect_error_is_502_without_exception_text(monkeypatch, slots):
    def handler(request):
        raise httpx.ConnectError(f"[Errno 111] {MARKER} dcs-server-1:9876", request=request)

    transport = install(monkeypatch, handler)
    r = client.get(PATH)

    assert r.status_code == 502
    assert r.json() == {"detail": "upstream error"}
    assert MARKER not in r.text
    assert "ConnectError" not in r.text
    assert_cleaned_up(slots, transport)


@pytest.mark.parametrize(
    "path",
    [
        "/proxy/tracks/bad.server/mission.trk",
        "/proxy/tracks/server1/mission.txt",
        "/proxy/tracks/server1/mission%20one.trk",
        "/proxy/tracks/server1/..trk%3Bx",
    ],
)
def test_invalid_server_or_filename_is_400(monkeypatch, slots, path):
    def handler(request):
        raise AssertionError("不正な名前で上流に問い合わせてはいけない")

    install(monkeypatch, handler)
    r = client.get(path)

    assert r.status_code == 400
    assert slots.acquired == slots.released == 0


@pytest.fixture
def anyio_backend():
    return "asyncio"


def asgi_client(client_ip: str = "127.0.0.1") -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, client=(client_ip, 50000)),
        base_url="http://testserver",
    )


@pytest.mark.anyio
async def test_all_slots_busy_is_immediate_503_with_retry_after(monkeypatch):
    sem = CountingSemaphore(0)  # 枠が 1 つも空いていない状態
    monkeypatch.setattr(main, "_track_slots", sem)

    def handler(request):
        raise AssertionError("枠が無いのに上流に接続してはいけない")

    install(monkeypatch, handler)
    # 「待たずに」断ることの確認。空き待ちをすると fail_after で落ちる。
    async with asgi_client() as asgi:
        with anyio.fail_after(5):
            r = await asgi.get(PATH)

    assert r.status_code == 503
    assert r.headers["retry-after"] == "30"
    assert sem.acquired == sem.released == 0


@pytest.mark.anyio
async def test_limit_plus_one_parallel_gets_503_and_slots_are_reused(monkeypatch, slots):
    """上限本数が転送中なら次は 503。転送が終われば枠が戻り、次の要求は通る。"""
    gate = asyncio.Event()
    bodies: list[UpstreamBody] = []

    def handler(request):
        body = UpstreamBody([b"a" * 1024, b"b" * 1024], gate=gate)
        bodies.append(body)
        return httpx.Response(200, headers={"Content-Length": "2048"}, stream=body)

    install(monkeypatch, handler)
    # 接続元ごとの上限に掛からないよう、同時に走らせる分は別の接続元にする。
    async with contextlib.AsyncExitStack() as stack:
        clients = [
            await stack.enter_async_context(asgi_client(f"192.0.2.{i}"))
            for i in range(LIMIT + 1)
        ]
        running = [asyncio.create_task(c.get(PATH)) for c in clients[:LIMIT]]
        asgi = clients[LIMIT]
        # 上限本数がすべて 1 チャンク目を送って gate 待ちになるまで待つ。
        with anyio.fail_after(5):
            while len(bodies) < LIMIT or not all(b.iterated for b in bodies):
                await asyncio.sleep(0.01)

        extra = await asgi.get(PATH)
        assert extra.status_code == 503
        assert extra.headers["retry-after"] == "30"

        gate.set()
        with anyio.fail_after(5):
            done = await asyncio.gather(*running)
        assert [r.status_code for r in done] == [200] * LIMIT
        assert all(r.content == b"a" * 1024 + b"b" * 1024 for r in done)

        again = await asgi.get(PATH)
        assert again.status_code == 200

    assert slots.acquired == slots.released == LIMIT + 1
    assert all(b.closed == 1 for b in bodies)


def _scope(path: str = PATH) -> dict:
    return {
        "type": "http",
        # uvicorn と同じ spec_version (切断は receive の http.disconnect で知る)
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(b"host", b"testserver")],
        "client": ("127.0.0.1", 50000),
        "server": ("testserver", 80),
    }


@pytest.mark.anyio
async def test_client_disconnect_mid_transfer_releases_everything(monkeypatch, slots):
    """転送途中で利用者が切断 → middleware 越しでも上流・client・枠が 1 回ずつ閉じる。"""
    never = asyncio.Event()  # 上流の 2 チャンク目は来ない
    body = UpstreamBody([b"x" * 4096, b"y" * 4096], gate=never)
    transport = install(
        monkeypatch,
        lambda req: httpx.Response(200, headers={"Content-Length": "8192"}, stream=body),
    )
    disconnected = asyncio.Event()
    sent: list[dict] = []
    first = True

    async def receive():
        nonlocal first
        if first:
            first = False
            return {"type": "http.request", "body": b"", "more_body": False}
        await disconnected.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)
        if message["type"] == "http.response.body" and message.get("body"):
            disconnected.set()

    with anyio.fail_after(5):
        await app(_scope(), receive, send)

    assert sent[0]["status"] == 200
    assert b"".join(m.get("body", b"") for m in sent[1:]) == b"x" * 4096
    assert_cleaned_up(slots, transport, body)


class BrokenUpstreamBody(UpstreamBody):
    """1 チャンク目の後で上流の接続が切れる。"""

    async def __aiter__(self):
        self.iterated = True
        yield self.chunks[0]
        raise httpx.ReadError(f"connection reset {MARKER}")


def assert_left_incomplete(sent: list[dict], body: bytes) -> None:
    """応答は始まったが終端 (more_body=False) が送られていない。

    終端を送らずに app が戻ると uvicorn は接続を閉じるので、利用者には
    Content-Length の有無にかかわらず「途中で切れた転送」として見える。
    """
    assert sent[0]["type"] == "http.response.start"
    assert sent[0]["status"] == 200
    assert b"".join(m.get("body", b"") for m in sent[1:]) == body
    assert all(m.get("more_body") is True for m in sent[1:])


@pytest.mark.anyio
@pytest.mark.parametrize(
    "upstream_headers",
    [{"Content-Length": "8192"}, {}],  # 後者は chunked (Content-Length 無し)
    ids=["content-length", "chunked"],
)
async def test_upstream_failure_mid_transfer_is_not_completed(monkeypatch, slots, upstream_headers):
    """上流が途中で切れたら応答を完了させない。

    以前は BaseHTTPMiddleware が例外を握りつぶして終端を送っていたため、
    chunked の上流だと途中までのファイルが正常完了として届いていた。
    """
    body = BrokenUpstreamBody([b"x" * 4096])
    transport = install(
        monkeypatch,
        lambda req: httpx.Response(200, headers=upstream_headers, stream=body),
    )
    sent: list[dict] = []

    async def receive():
        await asyncio.Event().wait()

    async def send(message):
        sent.append(message)

    with anyio.fail_after(5):
        await app(_scope(), receive, send)

    assert_left_incomplete(sent, b"x" * 4096)
    assert_cleaned_up(slots, transport, body)


def assert_aborted_and_client_held(slots, transport, body) -> None:
    """打ち切り後: 全体の枠と上流はすぐ返し、接続元の枠だけ一定時間保持する。"""
    assert slots.acquired == slots.released == 1
    assert transport.closed == 1
    assert body.closed == 1
    assert main._track_clients == {"127.0.0.1": 1}


@pytest.mark.anyio
async def test_stalled_client_is_cut_off_and_releases_slot(monkeypatch, slots):
    """利用者が読まずに接続を保っても、送信が止まったら打ち切って枠を返す。"""
    monkeypatch.setattr(main, "_TRACK_SEND_STALL_SECONDS", 0.2)
    monkeypatch.setattr(main, "_TRACK_ABORT_HOLD_SECONDS", 0.2)
    body = UpstreamBody([b"x" * 4096, b"y" * 4096])
    transport = install(
        monkeypatch,
        lambda req: httpx.Response(200, headers={"Content-Length": "8192"}, stream=body),
    )
    sent: list[dict] = []
    stuck = asyncio.Event()  # 1 チャンク目の後、利用者の受信が止まる

    async def receive():
        await asyncio.Event().wait()

    async def send(message):
        if message["type"] == "http.response.body" and sent[1:]:
            await stuck.wait()
        sent.append(message)

    with anyio.fail_after(5):
        await app(_scope(), receive, send)

    assert_left_incomplete(sent, b"x" * 4096)
    assert_aborted_and_client_held(slots, transport, body)
    # 保持時間が過ぎれば接続元の枠も戻る
    with anyio.fail_after(5):
        while main._track_clients:
            await asyncio.sleep(0.05)


@pytest.mark.anyio
async def test_too_slow_client_is_cut_off(monkeypatch, slots):
    """止まってはいないが、一定時間あたりの送信量が下限を割ったら打ち切る。"""
    monkeypatch.setattr(main, "_TRACK_RATE_WINDOW_SECONDS", 0.2)
    monkeypatch.setattr(main, "_TRACK_MIN_BYTES_PER_WINDOW", 1024 * 1024)
    monkeypatch.setattr(main, "_TRACK_ABORT_HOLD_SECONDS", 60)
    body = UpstreamBody([b"z" * 1024] * 50)
    transport = install(
        monkeypatch,
        lambda req: httpx.Response(200, headers={"Content-Length": str(50 * 1024)}, stream=body),
    )
    sent: list[dict] = []

    async def receive():
        await asyncio.Event().wait()

    async def send(message):
        sent.append(message)
        if message["type"] == "http.response.body":
            await asyncio.sleep(0.05)  # 1 KiB / 50 ms ≒ 20 KiB/s < 1 MiB / 0.2 s

    with anyio.fail_after(5):
        await app(_scope(), receive, send)

    assert 1 < len(sent) < 51
    assert all(m.get("more_body") is True for m in sent[1:])
    assert_aborted_and_client_held(slots, transport, body)


@pytest.mark.anyio
async def test_rate_window_restarts_after_each_window(monkeypatch, slots):
    """窓ごとに数え直す。最初の窓で大量に送っても、後の窓で遅ければ打ち切る。"""
    monkeypatch.setattr(main, "_TRACK_RATE_WINDOW_SECONDS", 0.2)
    monkeypatch.setattr(main, "_TRACK_MIN_BYTES_PER_WINDOW", 64 * 1024)
    monkeypatch.setattr(main, "_TRACK_ABORT_HOLD_SECONDS", 60)
    chunks = [b"a" * (2 * 1024 * 1024)] + [b"z" * 1024] * 40
    body = UpstreamBody(chunks)
    transport = install(
        monkeypatch,
        lambda req: httpx.Response(200, headers={"Content-Length": str(sum(map(len, chunks)))}, stream=body),
    )
    sent: list[dict] = []

    async def receive():
        await asyncio.Event().wait()

    async def send(message):
        sent.append(message)
        if message["type"] == "http.response.body":
            await asyncio.sleep(0.05)

    with anyio.fail_after(5):
        await app(_scope(), receive, send)

    # 2 MiB の最初の窓は通るが、その後の 1 KiB / 50 ms の窓で打ち切られる
    assert 3 < len(sent) < 42
    assert all(m.get("more_body") is True for m in sent[1:])
    assert_aborted_and_client_held(slots, transport, body)


@pytest.mark.anyio
async def test_aborted_client_cannot_reconnect_until_hold_expires(monkeypatch, slots):
    """打ち切った接続元は、保持時間のあいだ接続元ごとの上限に数えたまま (429)。"""
    monkeypatch.setattr(main, "TRACK_DOWNLOAD_PER_CLIENT", 1)
    monkeypatch.setattr(main, "_TRACK_ABORT_HOLD_SECONDS", 60)
    main._track_clients["203.0.113.9"] = 1  # 打ち切り直後の状態
    install(monkeypatch, lambda req: httpx.Response(200, stream=UpstreamBody([b"x"])))

    async with asgi_client("203.0.113.9") as held, asgi_client("203.0.113.10") as other:
        with anyio.fail_after(5):
            assert (await held.get(PATH)).status_code == 429
            assert (await other.get(PATH)).status_code == 200


@pytest.mark.anyio
async def test_close_is_idempotent(monkeypatch, slots):
    """close() を何度呼んでも後始末は 1 回 (Bounded なので二重 release は ValueError)。"""
    await slots.acquire()
    main._track_clients["127.0.0.1"] = 1
    download = main._TrackDownload(slots, "127.0.0.1")

    await download.close()
    await download.close()

    assert slots.acquired == slots.released == 1
    assert main._track_clients == {}


@pytest.mark.anyio
async def test_one_client_cannot_take_every_slot(monkeypatch, slots):
    """接続元ごとの上限を超えた分は 429。別の接続元はまだ使える。"""
    monkeypatch.setattr(main, "TRACK_DOWNLOAD_PER_CLIENT", 1)
    gate = asyncio.Event()
    bodies: list[UpstreamBody] = []

    def handler(request):
        body = UpstreamBody([b"a" * 1024, b"b" * 1024], gate=gate)
        bodies.append(body)
        return httpx.Response(200, headers={"Content-Length": "2048"}, stream=body)

    install(monkeypatch, handler)
    async with asgi_client("198.51.100.7") as same, asgi_client("198.51.100.8") as other:
        first = asyncio.create_task(same.get(PATH))
        with anyio.fail_after(5):
            while not (bodies and bodies[0].iterated):
                await asyncio.sleep(0.01)

        # 上限が効いていないと gate 待ちで止まるので、待たずに返ることも確かめる。
        with anyio.fail_after(5):
            second = await same.get(PATH)
        assert second.status_code == 429
        assert second.headers["retry-after"] == "30"

        third = asyncio.create_task(other.get(PATH))
        with anyio.fail_after(5):
            while not (len(bodies) == 2 and bodies[1].iterated):
                await asyncio.sleep(0.01)
        gate.set()
        with anyio.fail_after(5):
            done = await asyncio.gather(first, third)

    assert [r.status_code for r in done] == [200, 200]
    assert slots.acquired == slots.released == 2
    assert main._track_clients == {}


def test_content_encoding_from_upstream_is_passed_through(monkeypatch, slots):
    """identity を頼んでも圧縮で返ってきたら、raw バイトと符号化方式をそのまま渡す。"""
    original = b"PK\x03\x04" + b"track-data " * 2000
    compressed = gzip.compress(original)
    body = UpstreamBody([compressed])
    transport = install(
        monkeypatch,
        lambda req: httpx.Response(
            200,
            headers={"Content-Encoding": "gzip", "Content-Length": str(len(compressed))},
            stream=body,
        ),
    )

    r = client.get(PATH)

    assert r.status_code == 200
    assert r.headers["content-encoding"] == "gzip"
    assert r.headers["content-length"] == str(len(compressed))
    assert r.content == original  # TestClient (httpx) が展開した結果
    assert_cleaned_up(slots, transport, body)


class FailingCloseBody(UpstreamBody):
    async def aclose(self) -> None:
        self.closed += 1
        raise RuntimeError("close failed")


def test_close_failure_still_releases_slot_exactly_once(monkeypatch, slots):
    body = FailingCloseBody([b"not found"])
    transport = install(monkeypatch, lambda req: httpx.Response(404, stream=body))

    r = client.get(PATH)

    assert r.status_code == 404
    assert_cleaned_up(slots, transport, body)


@pytest.mark.anyio
async def test_client_gone_before_response_start_through_middleware(monkeypatch, slots):
    body = UpstreamBody([b"x" * 4096, b"y" * 4096], gate=asyncio.Event())
    transport = install(
        monkeypatch,
        lambda req: httpx.Response(200, headers={"Content-Length": "8192"}, stream=body),
    )

    async def receive():
        await asyncio.Event().wait()

    async def send(message):
        raise OSError("client went away")

    with anyio.fail_after(5), pytest.raises(OSError):
        await app(_scope(), receive, send)

    assert_cleaned_up(slots, transport, body)


@pytest.mark.anyio
async def test_cleanup_when_body_iterator_never_starts(monkeypatch, slots):
    """http.response.start の送信で失敗し、本文ジェネレータが一度も回らない経路。"""
    body = UpstreamBody([b"x" * 4096])
    transport = install(
        monkeypatch,
        lambda req: httpx.Response(200, headers={"Content-Length": "4096"}, stream=body),
    )
    response = await main.proxy_track_download(
        Request(_scope()), "server1", "mission_2026.trk"
    )
    assert slots.acquired == 1 and slots.released == 0

    async def receive():
        await asyncio.Event().wait()

    async def send(message):
        raise OSError("client went away")

    with anyio.fail_after(5), pytest.raises(OSError):
        await response(_scope(), receive, send)

    assert body.iterated is False
    assert_cleaned_up(slots, transport, body)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(None, 4), ("", 4), ("0", 4), ("-2", 4), ("abc", 4), ("1.5", 4), ("8", 8), (" 3 ", 3)],
)
def test_concurrency_env_falls_back_to_default(monkeypatch, raw, expected):
    if raw is None:
        monkeypatch.delenv("TRACK_DOWNLOAD_CONCURRENCY", raising=False)
    else:
        monkeypatch.setenv("TRACK_DOWNLOAD_CONCURRENCY", raw)
    assert main._env_positive_int("TRACK_DOWNLOAD_CONCURRENCY", 4) == expected
