"""Discord OAuth2 ログイン (scope identify のみ) と署名付き cookie。

- 必要な env (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / DISCORD_REDIRECT_URI /
  SESSION_SECRET) が揃わないときは login_enabled() が False になり、ログイン機能全体が
  無効になる (公開ランキングは影響を受けない)。
- 署名は標準ライブラリの hmac で行う (新規依存は入れない)。用途ごとに purpose 接頭辞を
  変えて、ある用途の cookie を別の用途に流用できないようにする。
- アクセストークンは保存しない。セッションに残るのは Discord ユーザー ID と発行時刻だけ。
- env は要求ごとに読む (テストで monkeypatch.setenv できるように)。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx

log = logging.getLogger(__name__)

AUTHORIZE_URL = "https://discord.com/oauth2/authorize"
TOKEN_URL = "https://discord.com/api/oauth2/token"
USER_URL = "https://discord.com/api/users/@me"

SESSION_COOKIE = "ffs_session"
STATE_COOKIE = "ffs_oauth_state"
SESSION_MAX_AGE = 7 * 24 * 3600
STATE_MAX_AGE = 600
# state cookie は callback 経路にだけ送る。
STATE_COOKIE_PATH = "/auth/discord"

MIN_SECRET_LENGTH = 32
_DISCORD_ID_RE = re.compile(r"[0-9]{5,25}")
_TIMEOUT = httpx.Timeout(5.0)

# Discord への通信先。None なら httpx 既定 (実ネットワーク)。
# テストでは httpx.MockTransport を差し込んで Discord を偽装する。
TRANSPORT: httpx.AsyncBaseTransport | None = None


@dataclass(frozen=True)
class Config:
    client_id: str
    client_secret: str
    redirect_uri: str
    secret: bytes


def config() -> Config | None:
    """ログイン機能の設定。揃っていなければ None (= 機能無効)。"""
    client_id = os.getenv("DISCORD_CLIENT_ID", "").strip()
    client_secret = os.getenv("DISCORD_CLIENT_SECRET", "").strip()
    redirect_uri = os.getenv("DISCORD_REDIRECT_URI", "").strip()
    secret = os.getenv("SESSION_SECRET", "")
    if not (client_id and client_secret and redirect_uri and secret):
        return None
    if len(secret) < MIN_SECRET_LENGTH:
        log.warning("SESSION_SECRET が %d 文字未満のためログインを無効化", MIN_SECRET_LENGTH)
        return None
    if not (
        redirect_uri.startswith("https://")
        or redirect_uri.startswith(("http://localhost", "http://127.0.0.1"))
    ):
        log.warning("DISCORD_REDIRECT_URI の形式が不正なためログインを無効化")
        return None
    return Config(client_id, client_secret, redirect_uri, secret.encode("utf-8"))


def login_enabled() -> bool:
    return config() is not None


# --- 署名付き値 ---------------------------------------------------------------

def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _mac(cfg: Config, purpose: str, body: str) -> str:
    raw = hmac.new(cfg.secret, f"{purpose}:{body}".encode("ascii"), hashlib.sha256).digest()
    return _b64(raw)


def _seal(cfg: Config, purpose: str, payload: dict) -> str:
    body = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    return f"{body}.{_mac(cfg, purpose, body)}"


def _open(cfg: Config, purpose: str, token: str | None, max_age: int) -> dict | None:
    """署名と発行時刻 (iat) を確かめて中身を返す。どれか外れたら None。"""
    if not token or token.count(".") != 1:
        return None
    body, sig = token.split(".", 1)
    if not hmac.compare_digest(sig, _mac(cfg, purpose, body)):
        return None
    try:
        payload = json.loads(_unb64(body))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    iat = payload.get("iat")
    now = int(time.time())
    if not isinstance(iat, int) or isinstance(iat, bool):
        return None
    if iat > now + 60 or now - iat > max_age:
        return None
    return payload


# --- セッション ----------------------------------------------------------------

def make_session(cfg: Config, discord_id: str) -> str:
    return _seal(cfg, "session", {"uid": discord_id, "iat": int(time.time())})


def read_session(cfg: Config, token: str | None) -> str | None:
    """有効なセッションなら Discord ユーザー ID を返す。"""
    payload = _open(cfg, "session", token, SESSION_MAX_AGE)
    if payload is None:
        return None
    uid = payload.get("uid")
    if not isinstance(uid, str) or not _DISCORD_ID_RE.fullmatch(uid):
        return None
    return uid


def csrf_token(cfg: Config, session_token: str) -> str:
    """ログアウト用の CSRF トークン。セッション cookie の値から導く (状態は持たない)。"""
    return _mac(cfg, "csrf", session_token)


def csrf_ok(cfg: Config, session_token: str | None, submitted: str) -> bool:
    if not session_token or not submitted:
        return False
    return hmac.compare_digest(submitted, csrf_token(cfg, session_token))


# --- OAuth state ---------------------------------------------------------------

def new_state(cfg: Config) -> tuple[str, str]:
    """(state の値, state cookie に入れる署名付き値) を返す。"""
    state = secrets.token_urlsafe(24)
    return state, _seal(cfg, "state", {"state": state, "iat": int(time.time())})


def state_matches(cfg: Config, cookie_value: str | None, query_state: str) -> bool:
    payload = _open(cfg, "state", cookie_value, STATE_MAX_AGE)
    if payload is None or not query_state:
        return False
    expected = payload.get("state")
    return isinstance(expected, str) and hmac.compare_digest(expected, query_state)


def authorize_url(cfg: Config, state: str) -> str:
    query = urlencode(
        {
            "client_id": cfg.client_id,
            "redirect_uri": cfg.redirect_uri,
            "response_type": "code",
            "scope": "identify",
            "state": state,
        }
    )
    return f"{AUTHORIZE_URL}?{query}"


# --- Discord との通信 ----------------------------------------------------------

async def exchange_code(cfg: Config, code: str) -> str | None:
    """認可コードを Discord ユーザー ID に変える。失敗したら None。

    コードやトークン、上流の応答本文はログに出さない (型と HTTP ステータスだけ残す)。
    """
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, transport=TRANSPORT) as client:
            token_res = await client.post(
                TOKEN_URL,
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": cfg.redirect_uri,
                    "client_id": cfg.client_id,
                    "client_secret": cfg.client_secret,
                },
                headers={"Accept": "application/json"},
            )
            if token_res.status_code != 200:
                log.warning("discord: token exchange -> HTTP %d", token_res.status_code)
                return None
            access_token = token_res.json().get("access_token")
            if not isinstance(access_token, str) or not access_token:
                log.warning("discord: token response had no access_token")
                return None
            user_res = await client.get(
                USER_URL,
                headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
            )
            if user_res.status_code != 200:
                log.warning("discord: users/@me -> HTTP %d", user_res.status_code)
                return None
            discord_id = str(user_res.json().get("id", ""))
    except (httpx.HTTPError, ValueError, AttributeError) as e:
        log.warning("discord: login request failed: %s", type(e).__name__)
        return None
    if not _DISCORD_ID_RE.fullmatch(discord_id):
        log.warning("discord: user id had an unexpected shape")
        return None
    return discord_id
