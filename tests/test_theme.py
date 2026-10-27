"""表示テーマ (若葉 / 墨) の切り替え。既定は若葉で、`?theme=` を cookie に保存する。"""
from fastapi.testclient import TestClient

from app.main import app


def _set_cookies(r) -> list[str]:
    return r.headers.get_list("set-cookie")


def test_default_theme_is_wakaba():
    r = TestClient(app).get("/privacy")

    assert r.status_code == 200
    assert 'data-theme="wakaba"' in r.text
    assert 'href="/privacy?theme=wakaba" aria-current="true"' in r.text
    assert _set_cookies(r) == []


def test_theme_query_sets_cookie_and_renders_dark():
    r = TestClient(app).get("/privacy?theme=dark")

    assert 'data-theme="dark"' in r.text
    assert 'href="/privacy?theme=dark" aria-current="true"' in r.text
    [cookie] = _set_cookies(r)
    assert cookie.startswith("ffs_theme=dark;")
    assert "Path=/" in cookie
    assert "SameSite=lax" in cookie


def test_saved_cookie_is_used_without_query():
    r = TestClient(app, cookies={"ffs_theme": "dark"}).get("/privacy")

    assert 'data-theme="dark"' in r.text
    assert _set_cookies(r) == []


def test_unknown_theme_is_ignored():
    r = TestClient(app, cookies={"ffs_theme": "dark"}).get("/privacy?theme=neon")

    assert 'data-theme="dark"' in r.text
    assert _set_cookies(r) == []


def test_lang_and_theme_together_set_both_cookies():
    r = TestClient(app).get("/privacy?lang=en&theme=dark")

    cookies = sorted(c.split(";", 1)[0] for c in _set_cookies(r))
    assert cookies == ["ffs_lang=en", "ffs_theme=dark"]
