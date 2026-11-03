"""Pilot Health パネル (/panel/fitbit) の描画。

パネルは 24h (fitbit_cache、60 秒毎) と 7 日 (fitbit7d_cache、10 分毎) の 2 つの
cache を merge して描く。起動直後や 7 日側の取得失敗のように片方しか値が無いときも
500 にせず、ある方のチャートだけ出す。データは偽の心拍で、Google Health API には触れない。
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import main
from app.cache import CachedValue
from app.charts import build_hr_chart

_JST = timezone(timedelta(hours=9))
_NOW = datetime(2026, 11, 3, 12, 0, tzinfo=_JST)

LABEL_24H = "Heart Rate · Last 24 Hours"
LABEL_7D = "Heart Rate · 7 Days"
LABEL_SLEEP = "Sleep · Last 7 Days"


def _chart(hours: int, step_minutes: int):
    start = _NOW - timedelta(hours=hours)
    n = hours * 60 // step_minutes
    points = [(start + timedelta(minutes=step_minutes * i), 60.0 + i % 7) for i in range(n)]
    return build_hr_chart(points, [], start, _NOW, gap_minutes=step_minutes * 3)


def _live() -> dict:
    return {
        "error": None,
        "current_hr": 63,
        "sleep_status": "awake",
        "sleep_summary": [],
        "chart_24h": _chart(24, 2),
        "win24h_start": "11/02 12:00",
        "window_end": "11/03 12:00",
    }


def _seven() -> dict:
    sleep_7day = [
        {"label": f"10/{28 + i}", "minutes": 420, "hours_str": "7h 00m", "in_bed_str": "7h 30m",
         "tip": "実睡眠 7h00m / 就床 7h30m", "is_today": i == 6}
        for i in range(7)
    ]
    return {
        "error": None,
        "chart_7d": _chart(7 * 24, 15),
        "sleep_7day": sleep_7day,
        "win7d_start": "10/27 12:00",
        "window_end": "11/03 12:00",
    }


def _ok(value: dict) -> CachedValue:
    return CachedValue(value=value, fetched_at=_NOW)


@pytest.fixture
def set_caches(monkeypatch):
    def _set(live: CachedValue, seven: CachedValue):
        monkeypatch.setattr(main.fitbit_cache, "_state", live)
        monkeypatch.setattr(main.fitbit7d_cache, "_state", seven)
    return _set


def _panel() -> str:
    r = TestClient(main.app).get("/panel/fitbit")
    assert r.status_code == 200
    return r.text


@pytest.mark.parametrize(
    "seven",
    [CachedValue(), CachedValue(error="HTTP 429")],
    ids=["7d-not-fetched-yet", "7d-failed"],
)
def test_live_only_renders_24h_chart_without_7d(set_caches, seven):
    set_caches(_ok(_live()), seven)
    html = _panel()

    assert ">63<" in html
    assert LABEL_24H in html
    assert LABEL_7D not in html
    assert LABEL_SLEEP not in html


def test_7d_only_renders_7d_chart_without_24h(set_caches):
    set_caches(CachedValue(), _ok(_seven()))
    html = _panel()

    assert LABEL_24H not in html
    assert LABEL_7D in html
    assert LABEL_SLEEP in html


def test_both_caches_render_all_sections(set_caches):
    set_caches(_ok(_live()), _ok(_seven()))
    html = _panel()

    assert html.index(LABEL_24H) < html.index(LABEL_7D) < html.index(LABEL_SLEEP)
    assert "10/27 12:00 – 11/03 12:00 JST" in html
