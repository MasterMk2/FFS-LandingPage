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
    "theme_switch_aria": {"ja": "表示テーマ", "en": "Color theme"},
    "theme_wakaba": {"ja": "若葉", "en": "Wakaba"},
    "theme_dark": {"ja": "墨", "en": "Dark"},
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
    "home_card_updates_title": {
        "ja": "ダウンロード — Windows アプリの配布",
        "en": "Downloads — Windows App Distribution",
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
    # ── points.html (フライトボード) ──
    # 文中の {n} {rank} などは テンプレート側で str.format() に渡して埋める。
    "pt_title": {"ja": "フライトボード", "en": "Flight Board"},
    "pt_lead": {"ja": "飛んだ分だけ、称号が上がる。", "en": "Fly more, and your title climbs."},
    "pt_note": {
        "ja": (
            "部門ごとのリワードで決まる称号と順位です。数値は公開せず、"
            "順位と称号だけを表示します。"
        ),
        "en": (
            "Titles and ranks are decided by rewards in each department. "
            "Reward totals are not published; only ranks and titles are shown."
        ),
    },
    "pt_closing_fmt": {
        "ja": "今月のランキングは残り {n} {unit}",
        "en": "{n} {unit} left this month",
    },
    "pt_closing_today": {
        "ja": "今月のランキングは今日まで",
        "en": "Last day of this month",
    },
    # 部門ごとの記録のされ方。コマンド名とボタン名は FFS/points/README.md に合わせる。
    "pt_how_total": {
        "ja": "FFS のサーバーで飛ぶと、自動で記録が始まります。",
        "en": "Fly on an FFS server and your record starts automatically.",
    },
    "pt_how_host": {
        "ja": "coop告知に募集を投稿して開催すると記録されます。",
        "en": "Post a call in the COOP announcements and run the event to be recorded.",
    },
    "pt_how_lead": {
        "ja": "募集の「リード」ボタンか、ゲーム内の .coop lead で宣言して飛ぶと記録されます。",
        "en": "Use the Lead button on a COOP call, or .coop lead in game, then fly.",
    },
    "pt_how_coop": {
        "ja": "募集の「参加」ボタンか、ゲーム内の .coop join で宣言して飛ぶと記録されます。",
        "en": "Use the Join button on a COOP call, or .coop join in game, then fly.",
    },
    "pt_how_free": {
        "ja": "FFS のサーバーで飛ぶと、自動で記録されます。",
        "en": "Fly on an FFS server and it is recorded automatically.",
    },
    "pt_how_author": {
        "ja": "ゲーム内の .author で、動いているミッションの制作を宣言すると記録されます。",
        "en": "Use .author in game to declare the running mission as yours.",
    },
    "pt_period_label": {"ja": "期間", "en": "Period"},
    "pt_period_month": {"ja": "今月", "en": "This month"},
    "pt_period_all": {"ja": "累計", "en": "All time"},
    "pt_dept_label": {"ja": "部門", "en": "Department"},
    "pt_dept_total": {"ja": "総合", "en": "Total"},
    "pt_dept_host": {"ja": "主催", "en": "Host"},
    "pt_dept_lead": {"ja": "フライトリード", "en": "Flight Lead"},
    "pt_dept_coop": {"ja": "COOP参加", "en": "COOP"},
    "pt_dept_free": {"ja": "フリーフライト", "en": "Free Flight"},
    "pt_dept_author": {"ja": "ミッション制作", "en": "Mission Author"},
    "pt_dept_hours": {"ja": "飛行時間", "en": "Flight Hours"},
    "pt_title_host": {"ja": "FFS 主催", "en": "FFS Host"},
    "pt_title_lead": {"ja": "FFS リード", "en": "FFS Flight Lead"},
    "pt_title_coop": {"ja": "FFS COOP参加", "en": "FFS COOP"},
    "pt_title_free": {"ja": "FFS フリーフライト", "en": "FFS Free Flight"},
    "pt_title_author": {"ja": "FFS ミッション制作", "en": "FFS Mission Author"},
    "pt_title_hours": {"ja": "FFS 飛行時間", "en": "FFS Flight Hours"},
    "pt_unit_time": {"ja": "回", "en": "time"},
    "pt_unit_times": {"ja": "回", "en": "times"},
    "pt_unit_day": {"ja": "日", "en": "day"},
    "pt_unit_days": {"ja": "日", "en": "days"},
    "pt_unit_hour": {"ja": "時間", "en": "hour"},
    "pt_unit_hours": {"ja": "時間", "en": "hours"},
    "pt_col_rank": {"ja": "順位", "en": "Rank"},
    "pt_col_name": {"ja": "パイロット", "en": "Pilot"},
    "pt_col_title": {"ja": "称号", "en": "Title"},
    "pt_board_empty": {
        "ja": "まだ誰も載っていません。最初の一人になれます。",
        "en": "Nobody here yet. The first spot is open.",
    },
    "pt_board_pending": {
        "ja": "ボードをまだ取得していません。数秒後に再読み込みしてください。",
        "en": "The board has not been fetched yet. Reload in a few seconds.",
    },
    "pt_board_error": {
        "ja": "ボードを取得できません。しばらくしてから再読み込みしてください。",
        "en": "The board is unavailable right now. Please reload later.",
    },
    "pt_login_failed": {
        "ja": "Discord ログインを完了できませんでした。時間をおいてもう一度お試しください。",
        "en": "Discord login could not be completed. Please try again later.",
    },
    "pt_me_title": {"ja": "あなたの状況", "en": "Your standing"},
    "pt_me_hint": {
        "ja": "Discord でログインすると、自分のリワード・称号・順位を確認できます。",
        "en": "Log in with Discord to see your rewards, titles and ranks.",
    },
    "pt_me_login": {"ja": "Discord でログイン", "en": "Log in with Discord"},
    "pt_me_logout": {"ja": "ログアウト", "en": "Log out"},
    "pt_me_name": {"ja": "DCS 名", "en": "DCS name"},
    "pt_me_not_linked": {
        "ja": "DCS サーバーで .linkme により Discord 連携してください。",
        "en": "Link your Discord account on the DCS server with .linkme.",
    },
    "pt_me_preparing": {
        "ja": "リワード集計の準備中です。しばらくしてから再読み込みしてください。",
        "en": "Rewards are being tallied. Reload in a little while.",
    },
    "pt_me_unavailable": {
        "ja": "リワード情報を取得できません。しばらくしてから再読み込みしてください。",
        "en": "Your rewards are unavailable right now. Please reload later.",
    },
    "pt_me_opted_out": {
        "ja": "称号と感謝投稿の公開を停止中です (/rewards_privacy)。",
        "en": "Public titles and thank-you posts are paused (/rewards_privacy).",
    },
    "pt_line_month": {"ja": "今月 {n} リワード", "en": "Rewards this month: {n}"},
    "pt_line_total": {"ja": "累計 {n} リワード", "en": "Rewards all time: {n}"},
    "pt_line_units": {"ja": "実績 {n} {unit}", "en": "{n} {unit} logged"},
    "pt_line_hours": {"ja": "飛行時間 {n} 時間", "en": "Flight time: {n} h"},
    "pt_no_title": {"ja": "称号なし", "en": "No title yet"},
    "pt_next_fmt": {
        "ja": "次の称号 {title} まであと {n} {unit}",
        "en": "{n} more {unit} to {title}",
    },
    "pt_top_title": {"ja": "最上位の称号を獲得済み", "en": "Highest title reached"},
    "pt_rank_none": {"ja": "未獲得", "en": "Not yet"},
    "pt_rank_fmt": {"ja": "{rank} 位 ({of} 人中)", "en": "#{rank} of {of}"},
    "pt_gap_fmt": {"ja": "上の順位に並ぶまであと {gap} リワード", "en": "{gap} more to tie the next rank"},
    "pt_gap_top": {"ja": "首位", "en": "1st place"},
    "pt_rank_month": {"ja": "今月の順位", "en": "Rank this month"},
    "pt_rank_all": {"ja": "累計の順位", "en": "Rank all time"},
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
