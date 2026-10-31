"""フライトボード (/points) の公開ボード。点数を出さないこと、エスケープ、上流障害時の表示を確かめる。

上流 DCSSB は dcssb.TRANSPORT に httpx.MockTransport を差し込んで偽装する (実通信はしない)。
"""
import asyncio
import re
from datetime import datetime

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
    return CachedValue(value=FetchResult(ok=True, data=data),
                       fetched_at=datetime.now().astimezone())


def _section(html: str, cls: str) -> str:
    start = html.index(f'class="{cls}"')
    return html[start:html.index("</section>", start)]


def _points(query: str = "") -> str:
    r = TestClient(app).get(f"/rewards{query}")
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
    assert "FFS 主催 二等空士" in section
    assert "999" not in section
    assert "pt" not in re.split(r'[ <>"=/]+', section)


def test_total_ranking_has_no_title_and_no_points(set_board, discord_off):
    set_board(_ok_board())
    section = _section(_points("?lang=ja&dept=total"), "pts-board")

    assert "Charlie" in section
    assert "主催 二等空士" in section  # 総合の称号は部門ボードから補う
    assert "999" not in section
    assert "pt" not in re.split(r'[ <>"=/]+', section)


def test_total_ranking_collects_titles_from_every_department(set_board, discord_off):
    set_board(_ok_board())
    section = _section(_points("?lang=ja&dept=total&period=all"), "pts-board")

    assert "Delta" in section
    assert "フリーフライト 空士長" in section


def test_rank_is_shown_as_text_with_ties_and_tier_gauge_matches_the_title(set_board, discord_off):
    tied = dict(BOARD)
    tied["boards"] = {
        "month": {**BOARD["boards"]["month"],
                  "free": [{"rank": 2, "name": "Echo", "tier": 3},
                           {"rank": 2, "name": "Foxtrot", "tier": 0}]},
        "all": BOARD["boards"]["all"],
    }
    set_board(_ok_board(tied))
    section = _section(_points("?lang=ja&dept=free"), "pts-board")

    assert section.count('class="pts-row pts-rank-2"') == 2
    assert section.count("</i>") == 5  # ゲージは 5 階級
    assert section.count('<i class="on">') == 1  # 3 段目までは最初の階級


def test_empty_department_invites_the_first_entry(set_board, discord_off):
    set_board(_ok_board())
    section = _section(_points("?lang=ja&dept=lead"), "pts-board")

    assert "最初の一人" in section
    assert ".coop lead" in section


def test_closing_shows_only_on_the_monthly_board(set_board, discord_off):
    set_board(_ok_board())

    assert "pts-closing" in _points("?lang=ja&period=month")
    assert "pts-closing" not in _points("?lang=ja&period=all")


@pytest.mark.parametrize("day, lang, expected", [
    (30, "ja", "今月のランキングは残り 1 日"),
    (31, "ja", "今月のランキングは今日まで"),
    (29, "en", "2 days left this month"),
    (30, "en", "1 day left this month"),
])
def test_month_closing_counts_days_left(day, lang, expected):
    assert points.month_closing(lang, datetime(2026, 10, day, 12)) == expected


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


def test_free_flight_titles_use_department_name_and_period_switch(set_board, discord_off):
    set_board(_ok_board())

    month = _section(_points("?lang=ja&dept=free&period=month"), "pts-board")
    assert "Delta" in month and "FFS フリーフライト 一等空士" in month
    assert "Bravo" in month

    all_time = _section(_points("?lang=ja&dept=free&period=all"), "pts-board")
    assert "FFS フリーフライト 空士長" in all_time
    assert "Bravo" not in all_time


def test_unknown_tab_values_fall_back_to_defaults(set_board, discord_off):
    set_board(_ok_board())
    html = _points("?lang=ja&dept=bogus&period=weekly")

    assert 'href="/rewards?dept=total&amp;period=month" aria-current="true"' in html
    assert 'href="/rewards?dept=total&amp;period=all"' in html


def test_tabs_keep_the_other_setting(set_board, discord_off):
    set_board(_ok_board())
    html = _points("?lang=ja&dept=coop&period=all")

    assert 'href="/rewards?dept=coop&amp;period=month"' in html
    assert 'href="/rewards?dept=host&amp;period=all"' in html
    assert 'href="/rewards?dept=coop&amp;period=all" aria-current="true"' in html


def test_nav_links_to_points_page(set_board, discord_off):
    set_board(_ok_board())
    html = TestClient(app).get("/?lang=ja").text

    assert 'href="/rewards"' in html


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
    assert rows == [{"rank": 1, "name": "Charlie", "tier": 1, "stars": 0, "medal": None}]
    assert "points" not in str(parsed)


def test_parse_board_rejects_unexpected_shape():
    assert points.parse_board(["not", "a", "dict"]) is None
    assert points.parse_board({"boards": "x"}) is None


def test_title_is_none_for_zero_missing_or_out_of_range_tiers():
    assert points.title("ja", "host", 0) is None
    assert points.title("ja", "host", None) is None
    assert points.title("ja", "host", 16) is None  # 全部門 15 段まで
    assert points.title("ja", "coop", 5) == "FFS COOP参加 二等空曹"
    assert points.title("ja", "total", 1) is None


def test_top_rank_shows_stars_in_both_languages():
    assert points.title("ja", "free", 15, 2) == "FFS フリーフライト 航空幕僚長 ★2"
    assert points.title("en", "free", 15) == "FFS Free Flight Chief of Staff"


SEASON_BOARD = {
    **BOARD,
    "season": {"id": "2027Q1", "ends": "2027-03-31"},
    "boards": {**BOARD["boards"], "season": {
        "total": [{"rank": 1, "name": "Charlie", "tier": None, "medal": 3, "points": 999},
                  {"rank": 2, "name": "Delta", "tier": None, "medal": 0}],
    }},
}


def test_season_tab_stays_hidden_until_a_season_is_running(set_board, discord_off):
    set_board(_ok_board())
    html = _points("?lang=ja&period=season")

    assert "period=season" not in html
    assert 'href="/rewards?dept=total&amp;period=month" aria-current="true"' in html


def test_season_board_shows_medals_without_points(set_board, discord_off):
    set_board(_ok_board(SEASON_BOARD))
    html = _points("?lang=ja&period=season")
    section = _section(html, "pts-board")

    assert 'href="/rewards?dept=total&amp;period=season" aria-current="true"' in html
    assert "ゴールド" in section and "pts-closing" in section
    assert "999" not in section
    assert section.count("pts-season-medal") == 1  # メダルの無い人には出さない


def test_season_closing_counts_days_to_the_last_day():
    ends = "2027-03-31"

    assert points.season_closing("ja", ends, datetime(2027, 3, 29, 12)) == "今シーズンは残り 2 日"
    assert points.season_closing("en", ends, datetime(2027, 3, 30, 12)) == "1 day left this season"
    assert points.season_closing("ja", ends, datetime(2027, 3, 31, 12)) == "今シーズンは今日まで"


def test_member_view_shows_the_season_and_past_medals():
    view = points.member_view({
        "departments": {},
        "season": {"id": "2027Q2", "points": 12, "medal": 2, "next": 20, "remaining": 8},
        "season_history": [{"season": "2027Q1", "medal": 4}, {"season": "2026Q4", "medal": 9}],
    }, "ja")

    assert view["season"]["medal"]["label"] == "シルバー"
    assert view["season"]["next_medal"]["label"] == "ゴールド"
    assert view["season_history"] == [
        {"season": "2027Q1", "medal": {"key": "platinum", "label": "プラチナ"}}]


def test_member_view_at_the_top_medal_has_no_next_goal():
    view = points.member_view({
        "departments": {},
        "season": {"id": "2027Q2", "points": 40, "medal": 4, "next": None, "remaining": None},
    }, "ja")

    assert view["season"]["next_medal"] is None


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


def test_old_url_redirects_and_keeps_the_query():
    client = TestClient(app, follow_redirects=False)
    assert client.get("/points").headers["location"] == "/rewards"
    r = client.get("/points?dept=coop&period=all")
    assert r.status_code == 301
    assert r.headers["location"] == "/rewards?dept=coop&period=all"
