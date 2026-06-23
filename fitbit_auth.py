#!/usr/bin/env python3
"""Google Health API 初回認証スクリプト (一回限り実行)。

認証フロー:
    - Client ID / Secret は Google Cloud Console の OAuth 2.0 クライアント
    - 認証 URL: accounts.google.com/o/oauth2/v2/auth (Google 標準 OAuth)
    - Token URL: oauth2.googleapis.com/token
    - API: health.googleapis.com/v4/

実行:
    python3 fitbit_auth.py

出力:
    refresh_token を .env の FITBIT_REFRESH_TOKEN か data/fitbit_tokens.json に保存。
"""
import base64
import hashlib
import http.server
import json
import os
import secrets
import threading
import urllib.parse
import urllib.request
import webbrowser

CLIENT_ID = (
    os.environ.get("FITBIT_CLIENT_ID") or input("Google Client ID: ").strip()
)
CLIENT_SECRET = (
    os.environ.get("FITBIT_CLIENT_SECRET") or input("Google Client Secret: ").strip()
)
REDIRECT_URI = "http://localhost:8080/callback"

SCOPES = " ".join([
    "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
    "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
])

# PKCE
_verifier = secrets.token_urlsafe(64)
_challenge = (
    base64.urlsafe_b64encode(hashlib.sha256(_verifier.encode()).digest())
    .rstrip(b"=")
    .decode()
)

auth_url = (
    "https://accounts.google.com/o/oauth2/v2/auth?"
    + urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": CLIENT_ID,
            "scope": SCOPES,
            "redirect_uri": REDIRECT_URI,
            "access_type": "offline",
            "prompt": "consent",
            "code_challenge": _challenge,
            "code_challenge_method": "S256",
        }
    )
)

_received: list[str] = []


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        code = (q.get("code") or [None])[0]
        error = (q.get("error") or [None])[0]
        if code:
            _received.append(code)
            body = b"<h2>Authorized! Close this tab and check the terminal.</h2>"
        else:
            body = f"<h2>Error: {error or 'unknown'}</h2>".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


print("Google Health API の認証画面を開きます…")
srv = http.server.HTTPServer(("127.0.0.1", 8080), _CallbackHandler)
t = threading.Thread(target=srv.handle_request, daemon=True)
t.start()

webbrowser.open(auth_url)
print(f"ブラウザが開かない場合は以下の URL にアクセスしてください:\n{auth_url}\n")

t.join(timeout=120)
srv.server_close()

if not _received:
    raise SystemExit("認証コードを受信できませんでした (120 秒タイムアウト)")

# 認証コード → トークン交換 (Google は body パラメータ、Basic 認証不要)
body_data = urllib.parse.urlencode(
    {
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "code": _received[0],
        "redirect_uri": REDIRECT_URI,
        "code_verifier": _verifier,
    }
).encode()

req = urllib.request.Request(
    "https://oauth2.googleapis.com/token",
    data=body_data,
    headers={"Content-Type": "application/x-www-form-urlencoded"},
)

with urllib.request.urlopen(req) as resp:
    tokens = json.loads(resp.read())

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
print(f"【方法 B】data/fitbit_tokens.json に直接保存 (推奨):")
print(f"  mkdir -p data && cat > {token_file} << 'EOF'\n{payload}\nEOF")
print("=" * 60)
