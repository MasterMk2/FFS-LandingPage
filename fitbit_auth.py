#!/usr/bin/env python3
"""Google Health API 初回認証スクリプト (一回限り実行)。

認証フロー:
    - Client ID / Secret は Google Cloud Console の OAuth 2.0 クライアント
    - 認証 URL: accounts.google.com/o/oauth2/v2/auth (Google 標準 OAuth)
    - Token URL: oauth2.googleapis.com/token
    - API: health.googleapis.com/v4/
    - PKCE (S256) に加えて state で callback の送り主を検証する

実行:
    python3 fitbit_auth.py

出力:
    refresh_token を .env の FITBIT_REFRESH_TOKEN か data/fitbit_tokens.json に保存。
"""
from __future__ import annotations

import base64
import hashlib
import html
import http.server
import json
import os
import secrets
import threading
import urllib.parse
import urllib.request
import webbrowser

REDIRECT_URI = "http://localhost:8080/callback"
CALLBACK_PATH = urllib.parse.urlparse(REDIRECT_URI).path
# callback の待ち受け先 (REDIRECT_URI と同じポート、ループバックのみ)
CALLBACK_ADDRESS = ("127.0.0.1", 8080)
# 有効な code が届くまで待ち受ける上限 (秒)
TIMEOUT_SECONDS = 120

SCOPES = " ".join([
    "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
    "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
])


def make_pkce_pair() -> tuple[str, str]:
    """PKCE の (code_verifier, code_challenge) を作る。"""
    verifier = secrets.token_urlsafe(64)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    return verifier, challenge


def build_auth_url(client_id: str, challenge: str, state: str) -> str:
    return (
        "https://accounts.google.com/o/oauth2/v2/auth?"
        + urllib.parse.urlencode(
            {
                "response_type": "code",
                "client_id": client_id,
                "scope": SCOPES,
                "redirect_uri": REDIRECT_URI,
                "access_type": "offline",
                "prompt": "consent",
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "state": state,
            }
        )
    )


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    # リクエストを送らない接続 (ブラウザの先読み接続など) を長く抱えない
    timeout = 10

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        # /favicon.ico などは 404 を返し、待ち受けは続ける
        if parsed.path != CALLBACK_PATH:
            self._reply(404, "<h2>Not Found</h2>")
            return

        q = urllib.parse.parse_qs(parsed.query)
        code = (q.get("code") or [None])[0]
        error = (q.get("error") or [None])[0]
        state = (q.get("state") or [None])[0]
        # 認可リクエストで渡した state と一致しない callback は、別セッションや
        # 第三者が踏ませた URL の可能性があるので code を受理しない
        if not state or not secrets.compare_digest(
            state.encode(), self.server.expected_state.encode()
        ):
            self._reply(400, "<h2>Error: invalid state</h2>")
            return

        if code:
            self.server.accept_code(code)
            self._reply(200, "<h2>Authorized! Close this tab and check the terminal.</h2>")
        else:
            # 同意の拒否 (access_denied) など。待ち続けても code は来ないので終わらせる。
            self.server.accept_error(error or "unknown")
            # error はクエリ由来の値なのでエスケープしてから埋め込む
            self._reply(400, f"<h2>Error: {html.escape(error or 'unknown')}</h2>")

    def _reply(self, status: int, body_html: str) -> None:
        body = body_html.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class CallbackServer(http.server.ThreadingHTTPServer):
    """期待する state を持ち、最初に届いた有効な callback (code か error) を記録する。"""

    def __init__(self, server_address, expected_state: str):
        super().__init__(server_address, _CallbackHandler)
        self.expected_state = expected_state
        self.code: str | None = None
        self.error: str | None = None
        # state が一致する callback (code か error) が届いたら set する
        self.done = threading.Event()
        self._lock = threading.Lock()

    def accept_code(self, code: str) -> None:
        with self._lock:
            if not self.done.is_set():
                self.code = code
                self.done.set()

    def accept_error(self, error: str) -> None:
        with self._lock:
            if not self.done.is_set():
                self.error = error
                self.done.set()


def wait_for_code(server: CallbackServer, timeout: float) -> str | None:
    """state が一致する callback が届くか timeout 秒経つまで待ち受ける。

    code を返す。拒否などで error が届いた場合は None を返し、server.error に残る。
    """
    t = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True
    )
    t.start()
    try:
        server.done.wait(timeout)
    finally:
        server.shutdown()
        t.join()
        server.server_close()
    return server.code


def exchange_code(client_id: str, client_secret: str, code: str, verifier: str) -> dict:
    # 認証コード → トークン交換 (Google は body パラメータ、Basic 認証不要)
    body_data = urllib.parse.urlencode(
        {
            "grant_type": "authorization_code",
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "redirect_uri": REDIRECT_URI,
            "code_verifier": verifier,
        }
    ).encode()

    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=body_data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )

    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def print_tokens(tokens: dict) -> None:
    print("\n✓ 認証成功!\n")
    print("=" * 60)
    print("【方法 A】.env に以下を追記:")
    print(f"FITBIT_REFRESH_TOKEN={tokens['refresh_token']}")
    print()
    token_file = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "data", "fitbit_tokens.json"
    )
    payload = json.dumps(
        {"access_token": tokens["access_token"], "refresh_token": tokens["refresh_token"]},
        indent=2,
    )
    # ffs-website は APP_UID:APP_GID (既定 10001:10001) で動き、/data にはその
    # ユーザーしか書けない。ファイルもその所有にしておかないと、コンテナが
    # 更新後のトークンを保存できない。
    uid = os.environ.get("APP_UID") or "10001"
    gid = os.environ.get("APP_GID") or "10001"
    data_dir = os.path.dirname(token_file)
    print("【方法 B】data/fitbit_tokens.json に直接保存 (推奨):")
    print(
        f"  (コンテナの実行ユーザー {uid}:{gid} の所有、0600 で置く。"
        ".env で APP_UID / APP_GID を変えている場合はその値に置き換える)"
    )
    print(f"  sudo install -d -o {uid} -g {gid} -m 700 {data_dir}")
    print(
        f"  sudo install -o {uid} -g {gid} -m 600 /dev/stdin {token_file} << 'EOF'\n"
        f"{payload}\nEOF"
    )
    print("=" * 60)


def main() -> None:
    client_id = (
        os.environ.get("FITBIT_CLIENT_ID") or input("Google Client ID: ").strip()
    )
    client_secret = (
        os.environ.get("FITBIT_CLIENT_SECRET") or input("Google Client Secret: ").strip()
    )

    verifier, challenge = make_pkce_pair()
    state = secrets.token_urlsafe(32)
    auth_url = build_auth_url(client_id, challenge, state)

    print("Google Health API の認証画面を開きます…")
    # 待ち受けソケットはここで listen 済みなので、ブラウザが先に戻ってきても取りこぼさない
    server = CallbackServer(CALLBACK_ADDRESS, state)

    webbrowser.open(auth_url)
    print(f"ブラウザが開かない場合は以下の URL にアクセスしてください:\n{auth_url}\n")

    code = wait_for_code(server, TIMEOUT_SECONDS)
    if server.error is not None:
        raise SystemExit(f"認可されませんでした: {server.error!r}")
    if code is None:
        raise SystemExit(f"認証コードを受信できませんでした ({TIMEOUT_SECONDS} 秒タイムアウト)")

    tokens = exchange_code(client_id, client_secret, code, verifier)
    print_tokens(tokens)


if __name__ == "__main__":
    main()
