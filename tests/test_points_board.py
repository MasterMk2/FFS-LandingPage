"""フライトボード (/points) の公開ボード。点数を出さないこと、エスケープ、上流障害時の表示を確かめる。

上流 DCSSB は dcssb.TRANSPORT に httpx.MockTransport を差し込んで偽装する (実通信はしない)。
"""
import asyncio
import re

import httpx
import pytest
from fastapi.testclient import TestClient

from app import dcssb, main, points
from app.cache import CachedValue
from app.dcssb import FetchResult
from app.main import app


MARKER = "internal-detail-7c21"

BOARD = {
    "month": "2026-10",
    "labels": {"host": "主催", "lead": "フライトリード", "coop": "COOP参加",
               "free": "フリーフライト", "author": "ミッション制作", "total": "総合"},
    "boards": {
        "month": {
            "host": [{"rank": 1, "name": "Charlie", "tier": 1, "points": 999}],
            "lead": [],
            "coop": [],
            "free": [
                {"rank": 1, "name": "Delta", "tier": 2},
                {"rank": 2, "name": "Bravo", "tier": 0},
            ],
            "author": [],
            "total": [{"rank": 1, "name": "Charlie", "tier": None, "points": 999}],
        },
        "all": {
            "host": [],
            "lead": [],
            "coop": [],
            "free": [{"rank": 1, "name": "Delta", "tier": 3}],
            "author": [],
            "total": [{"rank": 1, "name": "Delta", "tier": None}],
        },
    },
}


@pytest.fixture
def set_board(monkeypatch):
    def _set(state: CachedValue):
        monkeypatch.setattr(main.points_cache, "_state", state)
    return _set


@pytest.fixture
def discord_off(monkeypatch):
    for name in ("DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET",
                 "DISCORD_REDIRECT_URI", "SESSION_SECRET"):
        monkeypatch.delenv(name, raising=False)


def _ok_board(data=BOARD) -> CachedValue:
    from datetime import datetime

    return CachedValue(value=FetchResult(ok=True, data=data),
                       fetched_at=datetime.now().astimezone())


def _section(html: str, cls: str) -> str:
    start = html.index(f'class="{cls}"')
    return html[start:html.index("</section>", start)]


def _points(query: str = "") -> str:
    r = TestClient(app).get(f"/points{query}")
    assert r.status_code == 200
    return r.text


def test_not_fetched_yet_shows_pending_message(set_board, discord_off):
    set_board(CachedValue())

    assert "まだ取得していません" in _points("?lang=ja")


def test_fetch_failure_shows_generic_message_without_detail(set_board, discord_off):
    set_board(CachedValue(error=f"connection error {MARKER}"))
    html = _points("?lang=ja")

    assert "ボードを取得できません" in html
    assert MARKER not in html


def test_upstream_error_body_is_not_shown(set_board, discord_off):
    set_board(CachedValue(value=FetchResult(ok=False, error=f"HTTP 500 {MARKER}")))
    html = _points("?lang=ja")

    assert "ボードを取得できません" in html
    assert MARKER not in html


def test_public_ranking_shows_rank_name_and_title_but_no_points(set_board, discord_off):
    set_board(_ok_board())
    section = _section(_points("?lang=ja&dept=host"), "pts-board")

    assert "Charlie" in section
    assert "FFS 主催 I" in section
    assert "999" not in section
    assert "pt" not in re.split(r'[ <>"=/]+', section)


def test_total_ranking_has_no_title_and_no_points(set_board, discord_off):
    set_board(_ok_board())
    section = _section(_points("?lang=ja&dept=total"), "pts-board")

    assert "Charlie" in section
    assert "999" not in section
    assert "pt" not in re.split(r'[ <>"=/]+', section)
    assert "—" in section


def test_names_are_html_escaped(set_board, discord_off):
    evil = dict(BOARD)
    evil["boards"] = {
        "month": {**BOARD["boards"]["month"],
                  "host": [{"rank": 1, "name": "<script>alert(1)</script>", "tier": 1}]},
        "all": BOARD["boards"]["all"],
    }
    set_board(_ok_board(evil))
    html = _points("?lang=ja&dept=host")

    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html
    assert "<script>alert(1)</script>" not in html


def test_free_flight_titles_use_flight_day_and_period_switch(set_board, discord_off):
    set_board(_ok_board())

    month = _section(_points("?lang=ja&dept=free&period=month"), "pts-board")
    assert "Delta" in month and "FFS 飛行日 II" in month
    assert "Bravo" in month

    all_time = _section(_points("?lang=ja&dept=free&period=all"), "pts-board")
    assert "FFS 飛行日 III" in all_time
    assert "Bravo" not in all_time


def test_unknown_tab_values_fall_back_to_defaults(set_board, discord_off):
    set_board(_ok_board())
    html = _points("?lang=ja&dept=bogus&period=weekly")

    assert 'href="/points?dept=total&amp;period=month" aria-current="true"' in html
    assert 'href="/points?dept=total&amp;period=all"' in html


def test_tabs_keep_the_other_setting(set_board, discord_off):
    set_board(_ok_board())
    html = _points("?lang=ja&dept=coop&period=all")

    assert 'href="/points?dept=coop&amp;period=month"' in html
    assert 'href="/points?dept=host&amp;period=all"' in html
    assert 'href="/points?dept=coop&amp;period=all" aria-current="true"' in html


def test_nav_links_to_points_page(set_board, discord_off):
    set_board(_ok_board())
    html = TestClient(app).get("/?lang=ja").text

    assert 'href="/points"' in html


def test_login_is_not_offered_when_discord_env_is_missing(set_board, discord_off):
    set_board(_ok_board())
    html = _points("?lang=ja")

    assert "/auth/discord/login" not in html
    assert 'class="pts-me"' not in html
    assert TestClient(app).get("/auth/discord/login").status_code == 404


def test_parse_board_drops_points_and_limits_rows():
    parsed = points.parse_board(BOARD)

    assert parsed is not None
    rows = parsed["month"]["host"]
    assert rows == [{"rank": 1, "name": "Charlie", "tier": 1}]
    assert "points" not in str(parsed)


def test_parse_board_rejects_unexpected_shape():
    assert points.parse_board(["not", "a", "dict"]) is None
    assert points.parse_board({"boards": "x"}) is None


def test_title_is_none_for_zero_missing_or_out_of_range_tiers():
    assert points.title("ja", "host", 0) is None
    assert points.title("ja", "host", None) is None
    assert points.title("ja", "host", 5) is None  # 主催は IV まで
    assert points.title("ja", "coop", 5) == "FFS COOP参加 V"
    assert points.title("ja", "total", 1) is None


# --- dcssb (上流クライアント) --------------------------------------------------

@pytest.fixture
def upstream(monkeypatch):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/points/board":
            return httpx.Response(200, json=BOARD)
        if request.url.path == "/points/member/123456789012345678":
            return httpx.Response(404, json={"detail": "not_linked"})
        return httpx.Response(500, text=MARKER)

    monkeypatch.setattr(dcssb, "TRANSPORT", httpx.MockTransport(handler))
    monkeypatch.setattr(dcssb, "DCSSB_API_KEY", "test-api-key")
    return seen


def test_board_is_fetched_from_points_prefix_with_api_key(upstream):
    res = asyncio.run(dcssb.get_points_board())

    assert res.ok
    assert upstream[0].url.path == "/points/board"
    assert upstream[0].headers["x-api-key"] == "test-api-key"


def test_member_lookup_rejects_non_numeric_id_without_request(upstream):
    res = asyncio.run(dcssb.get_points_member("../board"))

    assert not res.ok
    assert upstream == []


def test_member_not_linked_is_reported_as_404(upstream):
    res = asyncio.run(dcssb.get_points_member("123456789012345678"))

    assert not res.ok
    assert res.status_code == 404
