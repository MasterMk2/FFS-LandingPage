"""`?lang=` を cookie に保存する middleware (純 ASGI 化した _LangCookieMiddleware)。"""
from fastapi.testclient import TestClient

from app.main import app


def test_valid_lang_query_sets_cookie():
    r = TestClient(app).get("/privacy?lang=en")

    assert r.status_code == 200
    cookie = r.headers.get("set-cookie", "")
    assert cookie.startswith("ffs_lang=en;")
    assert "Path=/" in cookie
    assert "SameSite=lax" in cookie


def test_no_cookie_when_same_lang_is_already_saved():
    r = TestClient(app, cookies={"ffs_lang": "en"}).get("/privacy?lang=en")

    assert r.status_code == 200
    assert "set-cookie" not in r.headers


def test_no_cookie_without_lang_or_with_unknown_lang():
    c = TestClient(app)

    assert "set-cookie" not in c.get("/privacy").headers
    assert "set-cookie" not in c.get("/privacy?lang=xx").headers


def test_cookie_is_added_to_htmx_panels_too():
    r = TestClient(app).get("/panel/sysmon?lang=ja")

    assert r.status_code == 200
    assert r.headers.get("set-cookie", "").startswith("ffs_lang=ja;")
