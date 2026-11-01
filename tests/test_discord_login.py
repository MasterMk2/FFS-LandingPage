"""Discord ログイン (OAuth2 + 署名付き cookie) と本人欄。

Discord と DCSSB は auth.TRANSPORT / dcssb.TRANSPORT に httpx.MockTransport を差し込んで
偽装する (実通信はしない)。Secure cookie を通すため base_url は https にする。
リダイレクトは follow_redirects=False で追い、Discord の画面へは行かない。
"""
import re
import time
from datetime import datetime
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient

from app import auth, cache, dcssb, main
from app.cache import CachedValue
from app.dcssb import FetchResult
from app.main import app


DISCORD_ID = "123456789012345678"
TOKEN = "ACCESS-TOKEN-MARKER-5d2e"
SECRET = "test-session-secret-0123456789abcdef"
MARKER = "internal-detail-3e9a"
BASE = "https://testserver"

MEMBER_OK = {
    "name": "Bravo",
    "month": "2026-10",
    "opted_out": False,
    "total": {"points": 40, "points_month": 12},
    "departments": {
        "free": {"points": 6, "points_month": 2, "units": 6, "tier": 1,
                  "next": 20, "remaining": 14},
        "host": {"points": 0, "points_month": 0, "units": 0, "tier": 0,
                 "next": 1, "remaining": 1},
        "lead": {"points": 0, "points_month": 0, "units": 0, "tier": 0,
                 "next": 1, "remaining": 1},
        "coop": {"points": 10, "points_month": 10, "units": 5, "tier": 2,
                 "next": 15, "remaining": 10},
        "author": {"points": 24, "points_month": 0, "units": 3, "tier": 3,
                   "next": 5, "remaining": 2},
    },
    "free_hours": {"hours": 12.5, "tier": 1, "next": 50, "remaining": 37.5},
    "standing": {
        "month": {
            "free": {"rank": 2, "of": 3, "gap": 1},
            "total": {"rank": 2, "of": 3, "gap": 4},
            "coop": {"rank": 1, "of": 2, "gap": None},
            "host": {"rank": None, "of": 3, "gap": None},
        },
        "all": {
            "free": {"rank": None, "of": 3, "gap": None},
            "total": {"rank": 3, "of": 3, "gap": 9},
        },
    },
}


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in ("DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET",
                 "DISCORD_REDIRECT_URI", "SESSION_SECRET", "DCSSB_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(main.points_cache, "_state", CachedValue())


@pytest.fixture
def discord_on(monkeypatch):
    monkeypatch.setenv("DISCORD_CLIENT_ID", "111222333")
    monkeypatch.setenv("DISCORD_CLIENT_SECRET", "client-secret-for-tests")
    monkeypatch.setenv("DISCORD_REDIRECT_URI", "https://freedomflight.jp/auth/discord/callback")
    monkeypatch.setenv("SESSION_SECRET", SECRET)


@pytest.fixture
def discord(monkeypatch):
    """Discord の偽装。status を変えて失敗系も作れる。calls に呼ばれた経路を残す。"""
    state = {"calls": [], "token_status": 200, "token_body": None}

    def handler(request: httpx.Request) -> httpx.Response:
        state["calls"].append(request.url.path)
        if request.url.path == "/api/oauth2/token":
            if state["token_status"] != 200:
                return httpx.Response(state["token_status"], text=state["token_body"] or MARKER)
            return httpx.Response(200, json={"access_token": TOKEN, "token_type": "Bearer"})
        if request.url.path == "/api/users/@me":
            if request.headers.get("authorization") != f"Bearer {TOKEN}":
                return httpx.Response(401)
            return httpx.Response(200, json={"id": DISCORD_ID, "username": "tester"})
        return httpx.Response(404)

    monkeypatch.setattr(auth, "TRANSPORT", httpx.MockTransport(handler))
    return state


@pytest.fixture
def upstream(monkeypatch):
    """DCSSB の偽装。member_status / member_body を変えて本人欄の状態を作る。"""
    state = {"member_status": 200, "member_body": MEMBER_OK, "seen": [],
             "link_status": 404, "link_body": {"detail": "Not Found"}}

    def handler(request: httpx.Request) -> httpx.Response:
        state["seen"].append(request)
        if request.url.path.startswith("/points/member/"):
            return httpx.Response(state["member_status"], json=state["member_body"])
        if request.url.path.startswith("/points/link/"):
            return httpx.Response(state["link_status"], json=state["link_body"])
        if request.url.path == "/points/board":
            return httpx.Response(200, json={"boards": {"month": {}, "all": {}}})
        return httpx.Response(404)

    monkeypatch.setattr(dcssb, "TRANSPORT", httpx.MockTransport(handler))
    monkeypatch.setattr(dcssb, "DCSSB_API_KEY", "test-api-key")
    return state


def _client() -> TestClient:
    return TestClient(app, base_url=BASE)


def _login(c: TestClient) -> TestClient:
    r = c.get("/auth/discord/login", follow_redirects=False)
    assert r.status_code == 303
    state = parse_qs(urlsplit(r.headers["location"]).query)["state"][0]
    r2 = c.get("/auth/discord/callback", params={"code": "CODE-XYZ", "state": state},
               follow_redirects=False)
    assert r2.status_code == 303
    assert r2.headers["location"] == "/rewards"
    return c


def _set_cookies(r) -> list[str]:
    return r.headers.get_list("set-cookie")


def _cookie_line(r, name: str) -> str:
    [line] = [c for c in _set_cookies(r) if c.startswith(name + "=")]
    return line


def _csrf(html: str) -> str:
    m = re.search(r'name="csrf" value="([^"]+)"', html)
    assert m, "logout form (csrf) が見つからない"
    return m.group(1)


# --- ログイン開始 ----------------------------------------------------------------

def test_login_redirects_to_discord_authorize_with_identify_only(discord_on):
    r = _client().get("/auth/discord/login", follow_redirects=False)

    assert r.status_code == 303
    loc = urlsplit(r.headers["location"])
    assert f"{loc.scheme}://{loc.netloc}{loc.path}" == "https://discord.com/oauth2/authorize"
    query = parse_qs(loc.query)
    assert query["client_id"] == ["111222333"]
    assert query["redirect_uri"] == ["https://freedomflight.jp/auth/discord/callback"]
    assert query["response_type"] == ["code"]
    assert query["scope"] == ["identify"]
    assert len(query["state"][0]) >= 32


def test_state_cookie_is_short_lived_and_scoped_to_callback(discord_on):
    r = _client().get("/auth/discord/login", follow_redirects=False)

    line = _cookie_line(r, auth.STATE_COOKIE).lower()
    assert "httponly" in line
    assert "secure" in line
    assert "samesite=lax" in line
    assert "path=/auth/discord" in line
    assert "max-age=600" in line


def test_login_is_404_when_discord_env_is_missing(discord):
    c = _client()

    assert c.get("/auth/discord/login", follow_redirects=False).status_code == 404
    assert c.get("/auth/discord/callback?code=x&state=y", follow_redirects=False).status_code == 404
    assert c.post("/auth/discord/logout", content=b"csrf=x").status_code == 404
    assert discord["calls"] == []


@pytest.mark.parametrize(
    "missing", ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_REDIRECT_URI", "SESSION_SECRET"]
)
def test_any_missing_discord_setting_disables_login(discord_on, monkeypatch, missing):
    monkeypatch.delenv(missing)

    assert _client().get("/auth/discord/login", follow_redirects=False).status_code == 404


def test_short_session_secret_disables_login(discord_on, monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "too-short")

    assert _client().get("/auth/discord/login", follow_redirects=False).status_code == 404


def test_non_https_redirect_uri_disables_login(discord_on, monkeypatch):
    monkeypatch.setenv("DISCORD_REDIRECT_URI", "http://evil.example/callback")

    assert _client().get("/auth/discord/login", follow_redirects=False).status_code == 404


def test_points_page_hides_login_button_when_disabled(upstream):
    html = TestClient(app).get("/rewards?lang=ja").text

    assert "/auth/discord/login" not in html
    assert 'class="pts-me"' not in html


# --- callback の拒否 ---------------------------------------------------------------

def test_state_mismatch_is_rejected_before_contacting_discord(discord_on, discord):
    c = _client()
    c.get("/auth/discord/login", follow_redirects=False)

    r = c.get("/auth/discord/callback", params={"code": "CODE", "state": "forged"},
              follow_redirects=False)

    assert r.status_code == 303
    assert r.headers["location"] == "/rewards?login=failed"
    assert discord["calls"] == []
    assert not any(line.startswith(auth.SESSION_COOKIE + "=") for line in _set_cookies(r))


def test_callback_without_state_cookie_is_rejected(discord_on, discord):
    r = _client().get("/auth/discord/callback", params={"code": "CODE", "state": "abc"},
                      follow_redirects=False)

    assert r.headers["location"] == "/rewards?login=failed"
    assert discord["calls"] == []


def test_callback_with_discord_error_is_rejected(discord_on, discord):
    c = _client()
    r = c.get("/auth/discord/login", follow_redirects=False)
    state = parse_qs(urlsplit(r.headers["location"]).query)["state"][0]

    r2 = c.get("/auth/discord/callback",
               params={"error": "access_denied", "state": state}, follow_redirects=False)

    assert r2.headers["location"] == "/rewards?login=failed"
    assert discord["calls"] == []


def test_expired_state_is_rejected(discord_on, discord):
    cfg = auth.config()
    stale = auth._seal(cfg, "state", {"state": "s1", "iat": int(time.time()) - 3600})
    c = TestClient(app, base_url=BASE, cookies={auth.STATE_COOKIE: stale})

    r = c.get("/auth/discord/callback", params={"code": "CODE", "state": "s1"},
              follow_redirects=False)

    assert r.headers["location"] == "/rewards?login=failed"
    assert discord["calls"] == []


def test_token_failure_shows_generic_message_without_detail(discord_on, discord, upstream):
    discord["token_status"] = 500
    discord["token_body"] = f"upstream says {MARKER}"
    c = _client()
    r = c.get("/auth/discord/login", follow_redirects=False)
    state = parse_qs(urlsplit(r.headers["location"]).query)["state"][0]

    r2 = c.get("/auth/discord/callback", params={"code": "CODE", "state": state},
               follow_redirects=False)
    assert r2.headers["location"] == "/rewards?login=failed"
    html = c.get("/rewards?login=failed&lang=ja").text

    assert "Discord ログインを完了できませんでした" in html
    assert MARKER not in html
    assert not any(line.startswith(auth.SESSION_COOKIE + "=") for line in _set_cookies(r2))


# --- 成功後の本人欄 ---------------------------------------------------------------

def test_successful_login_shows_own_standing(discord_on, discord, upstream):
    c = _login(_client())

    html = c.get("/rewards?lang=ja").text

    assert 'class="pts-me"' in html
    assert "Bravo" in html
    assert "今月 2 リワード" in html
    assert "累計 6 リワード" in html
    assert "FFS フリーフライト 二等空士" in html
    assert "上の順位に並ぶまであと 1 リワード" in html
    assert "FFS 飛行時間 二等空士" in html
    assert "12.5 時間" in html
    assert "次の称号 FFS 飛行時間 一等空士 まであと 37.5 時間" in html
    assert "2 位 (3 人中)" in html  # free の今月と総合の今月


def test_member_request_uses_discord_id_and_api_key(discord_on, discord, upstream):
    _login(_client()).get("/rewards")

    member_calls = [r for r in upstream["seen"] if r.url.path.startswith("/points/member/")]
    assert member_calls
    assert member_calls[-1].url.path == f"/points/member/{DISCORD_ID}"
    assert member_calls[-1].headers["x-api-key"] == "test-api-key"


def test_logged_in_page_is_not_shared_by_cache(discord_on, discord, upstream):
    c = _login(_client())

    r = c.get("/rewards")

    assert r.headers["cache-control"] == "private, no-store"
    assert "Cookie" in r.headers["vary"]


def test_session_cookie_holds_only_the_discord_id(discord_on, discord, upstream):
    c = _client()
    r = c.get("/auth/discord/login", follow_redirects=False)
    state = parse_qs(urlsplit(r.headers["location"]).query)["state"][0]
    r2 = c.get("/auth/discord/callback", params={"code": "CODE", "state": state},
               follow_redirects=False)

    session_line = _cookie_line(r2, auth.SESSION_COOKIE)
    value = session_line.split(";", 1)[0].split("=", 1)[1]
    assert TOKEN not in session_line
    assert "CODE" not in value
    assert "httponly" in session_line.lower()
    assert "secure" in session_line.lower()
    assert "samesite=lax" in session_line.lower()
    assert "max-age=604800" in session_line.lower()
    assert auth.read_session(auth.config(), value) == DISCORD_ID


def test_not_linked_shows_linkme_guidance(discord_on, discord, upstream):
    upstream["member_status"] = 404
    upstream["member_body"] = {"detail": "not_linked"}
    c = _login(_client())

    html = c.get("/rewards?lang=ja").text

    assert "DCS サーバーで .linkme により Discord 連携してください" in html
    assert 'class="pts-card"' not in html


def test_multiple_links_are_explained_apart_from_not_linked(discord_on, discord, upstream):
    upstream["member_status"] = 409
    upstream["member_body"] = {"detail": "multiple_links"}
    c = _login(_client())

    html = c.get("/rewards?lang=ja").text

    assert "複数の DCS アカウントが連携している" in html
    assert ".linkme" not in html
    assert 'class="pts-card"' not in html


def test_discord_only_member_sees_their_record_and_how_to_link(discord_on, discord, upstream):
    upstream["member_body"] = {**MEMBER_OK, "name": "テスト作者", "dcs_linked": False}
    c = _login(_client())

    html = c.get("/rewards?lang=ja").text

    assert "Discord 名: テスト作者" in html
    assert "DCS アカウントと未連携" in html
    assert "飛行時間" not in html.split('class="pts-me"')[1].split("pts-logout")[0]
    assert 'class="pts-card"' in html


def test_several_accounts_are_shown_one_after_another(discord_on, discord, upstream):
    first, second = {**MEMBER_OK, "name": "Bravo"}, {**MEMBER_OK, "name": "Alpha"}
    upstream["member_body"] = {**first, "accounts": [first, second]}
    c = _login(_client())

    html = c.get("/rewards?lang=ja").text

    assert html.index("DCS 名: Bravo") < html.index("DCS 名: Alpha")
    assert html.count("DCS 名:") == 2
    assert "複数の DCS アカウントが連携している" not in html


def test_preparing_503_is_reported_as_preparing(discord_on, discord, upstream):
    upstream["member_status"] = 503
    upstream["member_body"] = {"detail": "not ready"}
    c = _login(_client())

    assert "リワード集計の準備中です" in c.get("/rewards?lang=ja").text


def test_opted_out_shows_privacy_notice(discord_on, discord, upstream):
    upstream["member_body"] = {**MEMBER_OK, "opted_out": True}
    c = _login(_client())

    assert "称号と感謝投稿の公開を停止中です (/rewards_privacy)" in c.get("/rewards?lang=ja").text


def test_member_failure_is_generic_and_does_not_break_board(discord_on, discord, upstream):
    upstream["member_status"] = 500
    upstream["member_body"] = {"detail": MARKER}
    c = _login(_client())

    r = c.get("/rewards?lang=ja")

    assert r.status_code == 200
    assert "リワード情報を取得できません" in r.text
    assert MARKER not in r.text
    assert 'class="pts-board"' in r.text


def test_member_name_is_escaped(discord_on, discord, upstream):
    upstream["member_body"] = {**MEMBER_OK, "name": "<img src=x onerror=alert(1)>"}
    c = _login(_client())

    html = c.get("/rewards?lang=ja").text

    assert "&lt;img src=x onerror=alert(1)&gt;" in html
    assert "<img src=x" not in html


# --- セッションの扱い ---------------------------------------------------------------

def test_tampered_session_is_ignored(discord_on, discord, upstream):
    c = _login(_client())
    session = c.cookies.get(auth.SESSION_COOKIE)
    body, sig = session.split(".", 1)
    forged = f"{body}.{'A' if sig[0] != 'A' else 'B'}{sig[1:]}"
    # 偽造値は constructor の cookies で渡す (jar に後から足すと正規の cookie と併存する)。
    html = TestClient(app, base_url=BASE, cookies={auth.SESSION_COOKIE: forged})         .get("/rewards?lang=ja").text

    assert 'class="pts-me"' in html
    assert "/auth/discord/login" in html
    assert "Bravo" not in html


def test_expired_session_is_ignored(discord_on, discord, upstream):
    cfg = auth.config()
    old = auth._seal(cfg, "session", {"uid": DISCORD_ID,
                                      "iat": int(time.time()) - 8 * 24 * 3600})
    html = TestClient(app, base_url=BASE, cookies={auth.SESSION_COOKIE: old})         .get("/rewards?lang=ja").text

    assert "/auth/discord/login" in html
    assert upstream["seen"] == []


def test_session_with_bad_discord_id_is_ignored(discord_on, discord, upstream):
    cfg = auth.config()
    bad = auth._seal(cfg, "session", {"uid": "../board", "iat": int(time.time())})
    c = TestClient(app, base_url=BASE, cookies={auth.SESSION_COOKIE: bad})

    assert "/auth/discord/login" in c.get("/rewards?lang=ja").text
    assert upstream["seen"] == []


def test_state_cookie_cannot_be_used_as_session(discord_on, discord, upstream):
    cfg = auth.config()
    state_value = auth._seal(cfg, "state", {"state": "s", "iat": int(time.time())})
    payload = {"uid": DISCORD_ID, "iat": int(time.time())}
    assert auth.read_session(cfg, state_value) is None
    assert auth.read_session(cfg, auth._seal(cfg, "session", payload)) == DISCORD_ID


# --- ログアウト ---------------------------------------------------------------------

def test_logout_requires_matching_csrf(discord_on, discord, upstream):
    c = _login(_client())

    assert c.post("/auth/discord/logout", content=b"csrf=wrong").status_code == 403
    assert c.post("/auth/discord/logout", content=b"").status_code == 403
    assert "Bravo" in c.get("/rewards?lang=ja").text


def test_logout_with_csrf_clears_session(discord_on, discord, upstream):
    c = _login(_client())
    token = _csrf(c.get("/rewards?lang=ja").text)

    r = c.post("/auth/discord/logout", content=f"csrf={token}".encode(),
               headers={"content-type": "application/x-www-form-urlencoded"},
               follow_redirects=False)

    assert r.status_code == 303
    assert r.headers["location"] == "/rewards"
    line = _cookie_line(r, auth.SESSION_COOKIE).lower()
    assert "max-age=0" in line or "expires=" in line
    assert "Bravo" not in c.get("/rewards?lang=ja").text
    assert "/auth/discord/login" in c.get("/rewards?lang=ja").text


def test_logout_is_post_only(discord_on, discord):
    assert _client().get("/auth/discord/logout").status_code == 405


def test_csrf_token_is_bound_to_the_session(discord_on, discord, upstream):
    c = _login(_client())
    session = c.cookies.get(auth.SESSION_COOKIE)
    other = auth._seal(auth.config(), "session", {"uid": "987654321098765432",
                                                  "iat": int(time.time())})

    assert auth.csrf_ok(auth.config(), session, auth.csrf_token(auth.config(), session))
    assert not auth.csrf_ok(auth.config(), other, auth.csrf_token(auth.config(), session))


def test_logged_out_points_page_shows_login_button(discord_on, discord, upstream):
    html = _client().get("/rewards?lang=ja").text

    assert 'href="/auth/discord/login"' in html
    assert upstream["seen"] == []


def test_board_still_renders_when_login_is_on(discord_on, discord, upstream, monkeypatch):
    from datetime import datetime as _dt

    monkeypatch.setattr(main.points_cache, "_state", CachedValue(
        value=FetchResult(ok=True, data={"boards": {"month": {"host": [
            {"rank": 1, "name": "Charlie", "tier": 1}]}, "all": {}}}),
        fetched_at=_dt.now().astimezone(),
    ))
    html = _client().get("/rewards?lang=ja&dept=host").text

    assert "Charlie" in html
    assert "FFS 主催 二等空士" in html


# --- 正の対照 (拒否のテストが「cookie が届かなかった」で通っていないことの確認) ----

def test_fresh_state_cookie_is_accepted_positive_control(discord_on, discord, upstream):
    cfg = auth.config()
    fresh = auth._seal(cfg, "state", {"state": "s1", "iat": int(time.time())})
    c = TestClient(app, base_url=BASE, cookies={auth.STATE_COOKIE: fresh})

    r = c.get("/auth/discord/callback", params={"code": "CODE", "state": "s1"},
              follow_redirects=False)

    assert r.headers["location"] == "/rewards"
    assert discord["calls"] == ["/api/oauth2/token", "/api/users/@me"]


def test_valid_session_cookie_is_accepted_positive_control(discord_on, discord, upstream):
    session = auth._seal(auth.config(), "session", {"uid": DISCORD_ID, "iat": int(time.time())})
    c = TestClient(app, base_url=BASE, cookies={auth.SESSION_COOKIE: session})

    assert 'class="pts-me"' in c.get("/rewards?lang=ja").text
    assert "Bravo" in c.get("/rewards?lang=ja").text


# --- 本人欄からの DCS 連携 ---------------------------------------------------------

def _link(upstream, state="none", code=None, in_guild=True):
    upstream["link_status"] = 200
    upstream["link_body"] = {
        "state": state, "code": code, "in_guild": in_guild,
        "expires_at": "2026-11-04T00:00:00+00:00" if code else None,
    }


def _me(html: str) -> str:
    return html.split('class="pts-me"')[1].split("pts-logout")[0]


def _posts(upstream) -> list[str]:
    return [r.url.path for r in upstream["seen"] if r.method == "POST"]


def test_unlinked_member_is_offered_the_link(discord_on, discord, upstream):
    upstream["member_status"] = 404
    upstream["member_body"] = {"detail": "not_linked"}
    _link(upstream)

    html = _login(_client()).get("/rewards?lang=ja").text

    assert "DCS と連携" in _me(html) and 'action="/rewards/link"' in html
    assert "DCS サーバーで .linkme により" not in html


def test_pending_code_shows_command_and_deadline_in_jst(discord_on, discord, upstream):
    upstream["member_status"] = 404
    upstream["member_body"] = {"detail": "not_linked"}
    _link(upstream, code="1234")

    r = _login(_client()).get("/rewards?lang=ja")

    assert ".linkme 1234" in _me(r.text)
    assert "11/4 09:00" in _me(r.text) and "期限を延ばす" in _me(r.text)
    assert r.headers["cache-control"] == "private, no-store"


def test_english_page_uses_english_link_text(discord_on, discord, upstream):
    _link(upstream, code="1234")

    html = _login(_client()).get("/rewards?lang=en").text

    assert "Valid until 11/4 09:00 JST" in html and "Extend the deadline" in html


def test_name_matched_member_keeps_the_record_and_gets_one_line(discord_on, discord, upstream):
    _link(upstream, state="name_match")

    html = _me(_login(_client()).get("/rewards?lang=ja").text)

    assert "名前で自動連携しています" in html and "本人確認" in html
    assert "pts-btn-primary" not in html
    assert 'class="pts-card"' in html


def test_verified_member_sees_nothing_new(discord_on, discord, upstream):
    _link(upstream, state="verified")

    html = _login(_client()).get("/rewards?lang=ja&link=failed").text

    assert "/rewards/link" not in html and "pts-link" not in html
    assert "コードを発行できませんでした" not in html


def test_multiple_links_warn_before_verifying(discord_on, discord, upstream):
    _link(upstream, state="multiple")
    html = _me(_login(_client()).get("/rewards?lang=ja").text)
    assert "他のアカウントの実績は本人欄から外れます" in html and "本人確認" in html

    _link(upstream, state="multiple", code="1234")
    html = _me(_login(_client()).get("/rewards?lang=ja").text)
    assert "他のアカウントの実績は本人欄から外れます" in html and ".linkme 1234" in html


def test_member_outside_the_discord_is_invited(discord_on, discord, upstream):
    upstream["member_status"] = 404
    upstream["member_body"] = {"detail": "not_linked"}
    _link(upstream, in_guild=False)

    html = _me(_login(_client()).get("/rewards?lang=ja").text)

    assert "https://discord.gg/h7VkMbUycE" in html and "/rewards/link" not in html


def test_old_bot_hides_the_link_and_keeps_the_old_guidance(discord_on, discord, upstream):
    upstream["member_status"] = 404
    upstream["member_body"] = {"detail": "not_linked"}

    html = _login(_client()).get("/rewards?lang=ja").text

    assert "/rewards/link" not in html and "DCS サーバーで .linkme により" in html


@pytest.mark.parametrize("body", [
    {"state": "other"}, {"code": "1234"}, ["none"], "none",
])
def test_unexpected_link_shape_is_hidden(discord_on, discord, upstream, body):
    upstream["link_status"] = 200
    upstream["link_body"] = body

    assert "/rewards/link" not in _login(_client()).get("/rewards?lang=ja").text


def test_issue_requires_login_and_csrf(discord_on, discord, upstream):
    _link(upstream)
    c = _client()
    assert c.post("/rewards/link", content=b"csrf=x", follow_redirects=False).status_code == 403
    _login(c)
    assert c.post("/rewards/link", content=b"csrf=wrong", follow_redirects=False).status_code == 403
    assert c.post("/rewards/link", content=b"", follow_redirects=False).status_code == 403
    assert c.post("/rewards/link", content=b"x" * 5000, follow_redirects=False).status_code == 413
    assert not _posts(upstream)


def test_issue_is_404_when_discord_env_is_missing(upstream):
    assert _client().post("/rewards/link", content=b"csrf=x").status_code == 404


def test_issue_uses_the_session_id_and_returns_to_the_same_tab(discord_on, discord, upstream):
    _link(upstream, code="1234")
    c = _login(_client())
    token = _csrf(c.get("/rewards?lang=ja").text)

    r = c.post("/rewards/link", follow_redirects=False,
               content=f"csrf={token}&dept=free&period=all&discord_id=999999".encode(),
               headers={"content-type": "application/x-www-form-urlencoded"})

    assert r.status_code == 303
    assert r.headers["location"] == "/rewards?dept=free&period=all#pts-me"
    assert r.headers["cache-control"] == "no-store"
    assert _posts(upstream) == [f"/points/link/{DISCORD_ID}"]


def test_issue_ignores_unknown_tabs(discord_on, discord, upstream):
    _link(upstream, code="1234")
    c = _login(_client())
    token = _csrf(c.get("/rewards?lang=ja").text)

    r = c.post("/rewards/link", follow_redirects=False,
               content=f"csrf={token}&dept=//evil&period=x".encode())

    assert r.headers["location"] == "/rewards?dept=total&period=month#pts-me"


@pytest.mark.parametrize("status,body", [
    (503, {"detail": "not ready"}), (500, {"detail": MARKER}), (200, {"state": "other"}),
])
def test_failed_issue_is_shown_in_the_section_with_a_retry(discord_on, discord, upstream, status, body, caplog):
    upstream["link_status"], upstream["link_body"] = status, body
    c = _login(_client())
    token = _csrf(c.get("/rewards?lang=ja").text)

    r = c.post("/rewards/link", follow_redirects=False, content=f"csrf={token}".encode())

    assert r.status_code == 303 and "link=failed" in r.headers["location"]
    html = _me(c.get(r.headers["location"]).text)
    assert "コードを発行できませんでした" in html and "もう一度" in html
    assert 'class="pts-card"' in html and MARKER not in html


def test_unreachable_bot_does_not_break_the_page(discord_on, discord, monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to internal-host")

    monkeypatch.setattr(dcssb, "TRANSPORT", httpx.MockTransport(handler))
    c = _login(_client())
    token = _csrf(c.get("/rewards?lang=ja").text)

    r = c.post("/rewards/link", follow_redirects=False, content=f"csrf={token}".encode())
    page = c.get(r.headers["location"])

    assert page.status_code == 200 and "コードを発行できませんでした" in page.text
    assert "internal-host" not in page.text


def test_link_failures_keep_the_discord_id_and_code_out_of_the_log(discord_on, discord, upstream, caplog):
    upstream["link_status"], upstream["link_body"] = 500, {"code": "1234", "detail": MARKER}
    c = _login(_client())
    token = _csrf(c.get("/rewards?lang=ja").text)
    c.post("/rewards/link", content=f"csrf={token}".encode())

    log = "\n".join(r.getMessage() for r in caplog.records if r.name in ("app.dcssb", "httpx"))
    assert "points link -> HTTP 500" in log
    assert DISCORD_ID not in log and "1234" not in log and MARKER not in log
