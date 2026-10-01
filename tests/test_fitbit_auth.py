import base64
import builtins
import hashlib
import http.client
import http.server
import importlib
import json
import socket
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser

import pytest

import fitbit_auth


STATE = "state-for-test"


def _forbidden(*args, **kwargs):
    raise AssertionError("テスト中に呼ばれてはいけない")


@pytest.fixture(autouse=True)
def no_browser_or_google(monkeypatch):
    # どのテストでもブラウザ起動と Google への通信を起こさない
    monkeypatch.setattr(webbrowser, "open", _forbidden)
    monkeypatch.setattr(urllib.request, "urlopen", _forbidden)


@pytest.fixture
def callback_server():
    server = fitbit_auth.CallbackServer(("127.0.0.1", 0), STATE)
    t = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
    )
    t.start()
    yield server
    server.shutdown()
    t.join()
    server.server_close()


def _get(server, path):
    host, port = server.server_address[:2]
    conn = http.client.HTTPConnection(host, port, timeout=5)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        return resp.status, resp.read().decode()
    finally:
        conn.close()


def _callback(**params):
    return "/callback?" + urllib.parse.urlencode(params)


def test_import_has_no_side_effects(monkeypatch):
    monkeypatch.delenv("FITBIT_CLIENT_ID", raising=False)
    monkeypatch.delenv("FITBIT_CLIENT_SECRET", raising=False)
    monkeypatch.setattr(builtins, "input", _forbidden)
    monkeypatch.setattr(http.server.HTTPServer, "server_bind", _forbidden)
    monkeypatch.delitem(sys.modules, "fitbit_auth", raising=False)
    threads_before = set(threading.enumerate())

    module = importlib.import_module("fitbit_auth")

    assert not set(threading.enumerate()) - threads_before
    assert callable(module.main)


def test_callback_with_matching_state_accepts_code(callback_server):
    status, body = _get(callback_server, _callback(code="auth-code", state=STATE))

    assert status == 200
    assert "Authorized!" in body
    assert callback_server.code == "auth-code"
    assert callback_server.done.is_set()


@pytest.mark.parametrize(
    "params",
    [
        {"code": "auth-code", "state": "wrong-state"},
        {"code": "auth-code", "state": ""},
        {"code": "auth-code"},
        {"code": "auth-code", "state": "ステート"},
    ],
)
def test_callback_without_valid_state_is_rejected(callback_server, params):
    status, body = _get(callback_server, _callback(**params))

    assert status == 400
    assert "invalid state" in body
    assert callback_server.code is None
    assert not callback_server.done.is_set()
    assert callback_server.error is None


def test_error_parameter_is_escaped(callback_server):
    payload = "<script>alert(1)</script>"

    status, body = _get(callback_server, _callback(error=payload, state=STATE))
    assert status == 400
    assert "<script>" not in body
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in body

    # state が無い場合は error を表示しない
    status, body = _get(callback_server, _callback(error=payload))
    assert status == 400
    assert "<script>" not in body
    assert callback_server.code is None


def test_other_paths_return_404_and_keep_waiting():
    server = fitbit_auth.CallbackServer(("127.0.0.1", 0), STATE)
    result = {}
    waiter = threading.Thread(
        target=lambda: result.update(code=fitbit_auth.wait_for_code(server, 10)),
        daemon=True,
    )
    waiter.start()

    for path in ("/favicon.ico", "/", "/callback/extra?code=x&state=" + STATE):
        status, body = _get(server, path)
        assert status == 404
        assert "<h2>Not Found</h2>" == body
    assert waiter.is_alive()
    assert server.code is None

    status, _ = _get(server, _callback(code="auth-code", state=STATE))
    waiter.join(timeout=5)

    assert status == 200
    assert not waiter.is_alive()
    assert result["code"] == "auth-code"


def test_idle_connection_does_not_block_callback(callback_server):
    # ブラウザの先読み接続のように、接続だけしてリクエストを送らないクライアント
    idle = socket.create_connection(callback_server.server_address[:2], timeout=5)
    try:
        status, _ = _get(callback_server, _callback(code="auth-code", state=STATE))
    finally:
        idle.close()

    assert status == 200
    assert callback_server.code == "auth-code"


def test_wait_for_code_times_out_without_valid_code():
    server = fitbit_auth.CallbackServer(("127.0.0.1", 0), STATE)

    assert fitbit_auth.wait_for_code(server, 0.3) is None


@pytest.mark.parametrize("params", [{"error": "access_denied"}, {"error": "access_denied", "state": "wrong"}])
def test_error_without_valid_state_does_not_end_waiting(params):
    """state を知らない第三者が拒否 (error) を送り込んでも、待ち受けは終わらない。"""
    server = fitbit_auth.CallbackServer(("127.0.0.1", 0), STATE)
    result = {}
    waiter = threading.Thread(
        target=lambda: result.update(code=fitbit_auth.wait_for_code(server, 10)),
        daemon=True,
    )
    waiter.start()

    status, _ = _get(server, _callback(**params))
    assert status == 400
    assert waiter.is_alive()
    assert server.error is None and not server.done.is_set()

    # その後に届いた正しい callback は受理される
    status, _ = _get(server, _callback(code="auth-code", state=STATE))
    waiter.join(timeout=5)
    assert status == 200
    assert result["code"] == "auth-code"


def test_denied_consent_ends_waiting_immediately():
    """同意を拒否されたら (state は正しい error)、タイムアウトまで待たずに終わる。"""
    server = fitbit_auth.CallbackServer(("127.0.0.1", 0), STATE)
    result = {}
    waiter = threading.Thread(
        target=lambda: result.update(code=fitbit_auth.wait_for_code(server, 10)),
        daemon=True,
    )
    waiter.start()

    status, _ = _get(server, _callback(error="access_denied", state=STATE))
    waiter.join(timeout=5)

    assert status == 400
    assert not waiter.is_alive()
    assert result["code"] is None
    assert server.error == "access_denied"


def test_main_exits_with_message_when_consent_is_denied(monkeypatch):
    monkeypatch.setenv("FITBIT_CLIENT_ID", "client-id-test")
    monkeypatch.setenv("FITBIT_CLIENT_SECRET", "client-secret-test")
    monkeypatch.setattr(fitbit_auth, "CALLBACK_ADDRESS", ("127.0.0.1", 0))
    monkeypatch.setattr(fitbit_auth, "TIMEOUT_SECONDS", 10)
    servers = []

    class RecordingServer(fitbit_auth.CallbackServer):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            servers.append(self)

    monkeypatch.setattr(fitbit_auth, "CallbackServer", RecordingServer)

    def deny_in_browser(url):
        state = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["state"][0]
        path = _callback(error="access_denied", state=state)
        threading.Thread(target=_get, args=(servers[0], path), daemon=True).start()
        return True

    monkeypatch.setattr(webbrowser, "open", deny_in_browser)

    with pytest.raises(SystemExit, match="access_denied"):
        fitbit_auth.main()


class _FakeTokenResponse:
    def __init__(self, tokens):
        self._body = json.dumps(tokens).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_main_prints_refresh_token_after_valid_callback(monkeypatch, capsys):
    monkeypatch.setenv("FITBIT_CLIENT_ID", "client-id-test")
    monkeypatch.setenv("FITBIT_CLIENT_SECRET", "client-secret-test")
    monkeypatch.setattr(builtins, "input", _forbidden)
    monkeypatch.setattr(fitbit_auth, "CALLBACK_ADDRESS", ("127.0.0.1", 0))
    monkeypatch.setattr(fitbit_auth, "TIMEOUT_SECONDS", 10)

    servers = []

    class RecordingServer(fitbit_auth.CallbackServer):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            servers.append(self)

    monkeypatch.setattr(fitbit_auth, "CallbackServer", RecordingServer)

    opened = []

    def fake_browser(url):
        # ブラウザの代わりに、認可後のリダイレクトを callback へ送る
        opened.append(url)
        state = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["state"][0]
        path = _callback(code="auth-code-test", state=state)
        threading.Thread(target=_get, args=(servers[0], path), daemon=True).start()
        return True

    token_requests = []

    def fake_urlopen(req):
        token_requests.append(req)
        return _FakeTokenResponse({"access_token": "at-test", "refresh_token": "rt-test"})

    monkeypatch.setattr(webbrowser, "open", fake_browser)
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    fitbit_auth.main()

    auth = urllib.parse.urlparse(opened[0])
    auth_params = urllib.parse.parse_qs(auth.query)
    assert auth.netloc == "accounts.google.com"
    assert auth_params["client_id"] == ["client-id-test"]
    assert auth_params["redirect_uri"] == [fitbit_auth.REDIRECT_URI]
    assert auth_params["code_challenge_method"] == ["S256"]
    assert len(auth_params["state"][0]) >= 32

    (req,) = token_requests
    token_params = urllib.parse.parse_qs(req.data.decode())
    assert req.full_url == "https://oauth2.googleapis.com/token"
    assert token_params["code"] == ["auth-code-test"]
    assert token_params["client_secret"] == ["client-secret-test"]
    verifier = token_params["code_verifier"][0]
    expected_challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    assert auth_params["code_challenge"] == [expected_challenge]

    out = capsys.readouterr().out
    assert "FITBIT_REFRESH_TOKEN=rt-test" in out
    assert "data/fitbit_tokens.json" in out
    assert '"refresh_token": "rt-test"' in out
    # 方法 B はコンテナの実行ユーザー (既定 10001) の所有・0600 で置く案内になっている
    assert "sudo install -o 10001 -g 10001 -m 600 /dev/stdin" in out
