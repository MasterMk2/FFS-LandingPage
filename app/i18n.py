"""JA/EN i18n.  UI chrome strings live here; long prose is handled inline in
templates with ``{% if lang == 'ja' %}`` blocks.

Language resolution order:
  1. ``?lang=`` query param (the middleware also persists it to a cookie)
  2. ``ffs_lang`` cookie
  3. ``Accept-Language`` header (first recognized tag)
  4. ``ja`` (default)
"""
from __future__ import annotations

LANGS = ("ja", "en")
COOKIE_NAME = "ffs_lang"
COOKIE_MAX_AGE = 365 * 24 * 3600

MESSAGES: dict[str, dict[str, str]] = {
    # ── base.html ──
    "dbar_text": {
        "ja": "FFS Discord に参加しませんか？",
        "en": "Join the FFS Discord?",
    },
    "dbar_sub": {
        "ja": " — サーバー起動・音声・イベントの連絡はこちらで",
        "en": " — server startup, voice comms and event announcements",
    },
    "dbar_cta": {
        "ja": "参加する →",
        "en": "Join →",
    },
    "dbar_close": {
        "ja": "閉じる",
        "en": "Close",
    },
    "dbar_close_aria": {
        "ja": "このお知らせを閉じる",
        "en": "Dismiss this notice",
    },
    # ── home.html ──
    "home_lead": {
        "ja": (
            "FFS は DCS World の専用サーバを運営するコミュニティです。"
            "常時稼働しているマルチプレイヤー環境で、飛行訓練・合同作戦・シナリオベースのミッションを行っています。"
            "サーバの稼働状況・ミッション・気象・負荷はリアルタイムで公開、飛行時間や戦果のランキングもご覧いただけます。"
        ),
        "en": (
            "FFS is a community operating dedicated DCS World servers. "
            "It runs an always-online multiplayer environment for flight training, joint operations "
            "and scenario-based missions. Server status, missions, weather and load are published in "
            "real time, and flight-time / combat rankings are available to browse."
        ),
    },
    "home_card_gca_title": {
        "ja": "Web GCA — 管制コンソール",
        "en": "Web GCA — ATC Console",
    },
    "home_card_olympus_title": {
        "ja": "DCS Olympus — ブラウザ管制 / ユニット配置",
        "en": "DCS Olympus — Browser Control / Unit Placement",
    },
    "home_card_lt_title": {
        "ja": "Landing Teacher — 着陸/着艦レビュー",
        "en": "Landing Teacher — Landing/Trap Review",
    },
    "home_card_replays_title": {
        "ja": "リプレイダウンロード",
        "en": "Replay Downloads",
    },
    "cta_status": {"ja": "ステータスを見る →", "en": "View status →"},
    "cta_lb": {"ja": "ランキングを見る →", "en": "View leaderboard →"},
    "cta_open_sneaker": {
        "ja": "sneaker.freedomflight.jp を開く ↗",
        "en": "Open sneaker.freedomflight.jp ↗",
    },
    "cta_open_gca": {"ja": "管制卓を開く ↗", "en": "Open the console ↗"},
    "cta_olympus_how": {"ja": "使い方を見る →", "en": "How to use →"},
    "cta_open_lt": {"ja": "Landing Teacher を開く ↗", "en": "Open Landing Teacher ↗"},
    "cta_open_lardoon": {
        "ja": "lardoon.freedomflight.jp を開く ↗",
        "en": "Open lardoon.freedomflight.jp ↗",
    },
    "cta_view_replays": {"ja": "リプレイを見る →", "en": "View replays →"},
    "cta_open_gm": {
        "ja": "gravitymap.freedomflight.jp を開く ↗",
        "en": "Open gravitymap.freedomflight.jp ↗",
    },
    # ── leaderboard.html ──
    "lb_period": {"ja": "過去 30 日", "en": "Last 30 days"},
    "lb_error": {
        "ja": "Leaderboard 取得失敗: ",
        "en": "Failed to fetch leaderboard: ",
    },
    "lb_empty": {
        "ja": "データ蓄積待ち (戦闘ログがまだありません)",
        "en": "Waiting for data (no combat log yet)",
    },
    "lb_cat_playtime": {"ja": "飛行時間", "en": "Flight Time"},
    "lb_cat_air": {"ja": "空中目標撃破", "en": "Air Targets"},
    "lb_cat_ground": {"ja": "地上目標撃破", "en": "Ground Targets"},
    "lb_cat_airdef": {"ja": "対空 (SAM/AAA)", "en": "Air Defence (SAM/AAA)"},
    "lb_cat_pvp": {"ja": "PvP KD 比", "en": "PvP KD Ratio"},
    # ── tracks.html ──
    "tr_error": {"ja": "取得失敗: ", "en": "Fetch failed: "},
    "tr_unavailable": {
        "ja": "サーバが一時的に利用不可のためリストを取得できません。",
        "en": "This server is temporarily unavailable; the list cannot be fetched.",
    },
    "tr_empty": {
        "ja": "このサーバに保存されたリプレイはありません。",
        "en": "No replays saved on this server.",
    },
    # ── servers_panel.html ──
    "sp_error_upstream": {
        "ja": "DCSSB API に到達できません:",
        "en": "Cannot reach the DCSSB API:",
    },
    "sp_error_empty": {
        "ja": "サーバ情報が取得できませんでした。",
        "en": "No server information could be fetched.",
    },
    # ── fitbit_panel.html ──
    "fit_sleep_note": {
        "ja": "実睡眠 (覚醒除く)",
        "en": "Actual sleep (excludes awake time)",
    },
    # ── health.html live badge ──
    "health_loading": {"ja": "読み込み中", "en": "Loading"},
    "health_nodata": {"ja": "データなし", "en": "No data"},
    "health_failed": {"ja": "取得できません", "en": "Unavailable"},
    # "{min}" is replaced by the minute count in JS.
    "health_ago_min": {"ja": "{min} 分前", "en": "{min} min ago"},
}


def normalize(raw: str | None) -> str | None:
    if not raw:
        return None
    v = raw.strip().lower()
    return v if v in LANGS else None


def resolve_lang(request) -> str:
    """query param → cookie → Accept-Language → ja.

    query param は middleware が cookie 化するので次回以降も同じ言語になる。
    """
    lang = normalize(request.query_params.get("lang"))
    if lang:
        return lang
    lang = normalize(request.cookies.get(COOKIE_NAME))
    if lang:
        return lang
    header = request.headers.get("accept-language") or ""
    for part in header.split(","):
        tag = part.split(";")[0].strip().lower()
        if tag.startswith("en"):
            return "en"
        if tag.startswith("ja"):
            return "ja"
    return "ja"


def t(lang: str, key: str) -> str:
    entry = MESSAGES.get(key)
    if entry is None:
        return key
    return entry.get(lang) or entry.get("ja") or key
