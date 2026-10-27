"""Home 先頭のサーバ一覧 (servers_cache の状態ごとの表示)。"""
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app import main
from app.cache import CachedValue
from app.dcssb import FetchResult

MARKER = "internal-detail-9f3a"


@pytest.fixture
def set_servers(monkeypatch):
    def _set(state: CachedValue):
        monkeypatch.setattr(main.servers_cache, "_state", state)
    return _set


def _home() -> str:
    r = TestClient(main.app).get("/?lang=ja")
    assert r.status_code == 200
    return r.text


def test_not_fetched_yet_shows_pending(set_servers):
    set_servers(CachedValue())

    assert "まだ取得していません" in _home()


def test_fetch_failure_hides_raw_error(set_servers):
    set_servers(CachedValue(error=f"connection error {MARKER}"))
    html = _home()

    assert "取得できません" in html
    assert MARKER not in html


def test_rows_follow_port_order_with_status_and_players(set_servers):
    servers = [
        {"name": "alpha 2", "status": "Shutdown", "address": "host:18102", "password": "x",
         "mission": {"name": "M2", "theatre": "Syria"}},
        {"name": "alpha 1", "status": "Running", "address": "host:18101",
         "mission": {"name": "M1", "theatre": "Caucasus"}, "players": [{"nick": "a"}, {"nick": "b"}]},
        {"name": "alpha 3", "status": "Paused", "address": "host:18103", "num_players": 3},
    ]
    set_servers(CachedValue(value=FetchResult(ok=True, data=servers),
                            fetched_at=datetime.now().astimezone()))
    html = _home()

    assert html.index("alpha 1") < html.index("alpha 2") < html.index("alpha 3")
    assert html.count('class="server-row status-up"') == 2
    assert 'class="server-row status-down"' in html
    assert "2 人" in html
    # 見出しの件数は行のバッジ (Paused も緑) と人数 (num_players 優先) に一致する
    assert "稼働 2 / 3" in html
    assert "接続中 5 人" in html
    assert "秒前" in html
    assert "パスワードあり" in html


def test_status_page_lists_servers_before_host_load():
    html = TestClient(main.app).get("/status").text

    assert html.index('id="servers"') < html.index('id="sysmon"')
