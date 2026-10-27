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
    "footer_privacy": {
        "ja": "プライバシーポリシー",
        "en": "Privacy Policy",
    },
    # ── home.html ──
    "home_lead": {
        "ja": (
            "FFS は DCS World の専用サーバを常時運営しているコミュニティです。"
            "飛行訓練・合同作戦・シナリオミッションをマルチプレイで行っています。"
            "サーバの起動や集まりの連絡は Discord で流れます。"
        ),
        "en": (
            "FFS is a community running always-online dedicated DCS World servers "
            "for flight training, joint operations and scenario missions. "
            "Server starts and meet-ups are announced on Discord."
        ),
    },
    "home_servers_title": {"ja": "サーバ", "en": "Servers"},
    "home_servers_meta": {
        "ja": "稼働 {running} / {total} ・ 接続中 {players} 人 ・ 取得 {age}",
        "en": "{running} of {total} running · {players} online · fetched {age}",
    },
    "home_servers_pending": {
        "ja": "サーバの情報をまだ取得していません。数秒後に再読み込みしてください。",
        "en": "Server info has not been fetched yet. Reload in a few seconds.",
    },
    "home_servers_error": {
        "ja": "サーバの情報を取得できません。稼働状況は Discord でも確認できます。",
        "en": "Server info is unavailable right now. Check Discord for server status.",
    },
    "home_servers_empty": {"ja": "登録されているサーバがありません。", "en": "No servers are registered."},
    "home_players": {"ja": "{n} 人", "en": "{n} online"},
    "home_password": {"ja": "パスワードあり", "en": "password required"},
    "home_link_status": {"ja": "負荷・気象を含む詳しい状況", "en": "Full status with load and weather"},
    "home_link_lb": {"ja": "リーダーボード", "en": "Leaderboard"},
    "home_link_tracks": {"ja": "リプレイ ({n} 件)", "en": "Replays ({n})"},
    "home_tools_dcs": {"ja": "DCS で使うツール", "en": "Tools for DCS"},
    "home_tools_apps": {"ja": "アプリとゲーム", "en": "Apps and games"},
    "home_tools_other": {"ja": "DCS 以外の個人プロジェクト", "en": "Personal projects outside DCS"},
    "home_new_tab": {"ja": "新しいタブで開く", "en": "opens in a new tab"},
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
    "home_card_gatchan_title": {
        "ja": "GATCHAN — 大判ポスターの分割印刷",
        "en": "GATCHAN — Tiled Poster Printing",
    },
    "home_card_komagire_title": {
        "ja": "こま切れ印刷 — PDFの小分け印刷",
        "en": "KOMAGIRE — Small-batch PDF Printing",
    },
    "home_card_dsv_title": {
        "ja": "DCS Skin Viewer — リバリー制作用 3D・UV ビューアー",
        "en": "DCS Skin Viewer — 3D/UV Viewer for Livery Painting",
    },
    "home_card_dms_title": {
        "ja": "DCS Mission Studio — 原本を残して編集するミッションエディター",
        "en": "DCS Mission Studio — Mission Editing That Keeps the Original",
    },
    "home_card_skyrunner_title": {
        "ja": "Sunset Skyrunner — ブラウザ・フライトゲーム",
        "en": "Sunset Skyrunner — Browser Flight Game",
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
