"""FFS DCS ランディングページ (FastAPI)."""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from datetime import datetime as _datetime

import anyio
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import cache, db, dcssb, fitbit as _fitbit, i18n, sysmon

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent

# バックグラウンド cache。HTTP handler はこれしか読まない。
# interval は各データソースの更新頻度 + UI 表示粒度に合わせて選定。
servers_cache = cache.Fetcher(
    fetch=dcssb.get_servers, interval=15, name="servers"
)
load_cache = cache.Fetcher(
    fetch=db.get_server_load_series, interval=60, name="serverload"
)
highscore_cache = cache.Fetcher(
    fetch=lambda: dcssb.get_highscore(period="month", limit=10),
    interval=300,
    name="highscore",
)


async def _fetch_tracks_all() -> dict:
    """summary + 各サーバの trk 一覧を 1 バッチで取得。"""
    summary_res = await dcssb.get_tracks_summary()
    summary: dict = summary_res.data if summary_res.ok and isinstance(summary_res.data, dict) else {}
    lists: dict[str, list] = {}
    for server in summary.keys():
        if summary[server].get("unavailable"):
            lists[server] = []
            continue
        list_res = await dcssb.get_tracks_list(server)
        lists[server] = (
            list_res.data
            if list_res.ok and isinstance(list_res.data, list)
            else []
        )
    return {
        "summary": summary,
        "lists": lists,
        "error": summary_res.error if not summary_res.ok else None,
    }


tracks_cache = cache.Fetcher(
    fetch=_fetch_tracks_all, interval=60, name="tracks"
)
# ホスト CPU/mem/swap/loadavg。psutil は bind-mount した /host/proc を読む。
sysmon_cache = cache.Fetcher(
    fetch=sysmon.sample, interval=15, name="sysmon"
)
fitbit_cache = cache.Fetcher(
    fetch=_fitbit.get_fitbit_data, interval=60, name="fitbit"
)
# 7 日 HR 履歴は日別分割フェッチで重い + ほぼ変化しないので別 cache で 10 分毎。
fitbit7d_cache = cache.Fetcher(
    fetch=_fitbit.get_fitbit_7d, interval=600, name="fitbit7d"
)
ALL_CACHES = [
    servers_cache, load_cache, highscore_cache, tracks_cache,
    sysmon_cache, fitbit_cache, fitbit7d_cache,
]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    for c in ALL_CACHES:
        c.start()
    try:
        yield
    finally:
        for c in ALL_CACHES:
            c.stop()


# 公開サイトなので API 仕様 (/openapi.json) も docs と一緒に出さない。
app = FastAPI(
    title="FFS DCS Status",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")

# Google Analytics 4 の測定 ID (G-XXXXXXXXXX)。未設定ならタグ自体を出さないので、
# ローカル開発やテストのアクセスが本番の計測に混ざらない。値は base.html の
# <script> 内 JS 文字列にも埋め込むため、形式が正しいものだけを採用する。
_GA_ID_RE = re.compile(r"G-[A-Z0-9]{4,20}")


def _ga_measurement_id(raw: str) -> str | None:
    value = raw.strip()
    if not value:
        return None
    if not _GA_ID_RE.fullmatch(value):
        logging.getLogger(__name__).warning(
            "GA_MEASUREMENT_ID=%r は測定 ID の形式ではないため計測タグを無効化", value
        )
        return None
    return value


templates.env.globals["ga_measurement_id"] = _ga_measurement_id(
    os.getenv("GA_MEASUREMENT_ID", "")
)


def render(request: Request, name: str, ctx: dict | None = None):
    """TemplateResponse の薄いラッパ。lang と翻訳関数 t を全テンプレに注入する。"""
    lang = i18n.resolve_lang(request)
    ctx = {"request": request, **(ctx or {}), "lang": lang, "t": lambda k: i18n.t(lang, k)}
    return templates.TemplateResponse(request, name, ctx)


class _LangCookieMiddleware:
    """`?lang=` が有効値なら cookie (ffs_lang) に永続化する。

    HTMX の polling も cookie で lang を引き継ぐための下地。

    ★ @app.middleware("http") (BaseHTTPMiddleware) に戻さないこと。あれは内側の
      例外を握りつぶして応答を正常終了させるので、/proxy/tracks の中継が途中で
      失敗しても、Content-Length の無い上流なら途中までのファイルが「正常完了」
      として届いてしまう。ここでは応答開始時に Set-Cookie を足すだけにする。
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope)
        lang = i18n.normalize(request.query_params.get("lang"))
        if not lang or request.cookies.get(i18n.COOKIE_NAME) == lang:
            await self.app(scope, receive, send)
            return
        carrier = Response()
        carrier.set_cookie(
            i18n.COOKIE_NAME,
            lang,
            max_age=i18n.COOKIE_MAX_AGE,
            samesite="lax",
            path="/",
        )
        cookies = [h for h in carrier.raw_headers if h[0] == b"set-cookie"]

        async def send_with_cookie(message: Message) -> None:
            if message["type"] == "http.response.start":
                message = {**message, "headers": [*message.get("headers", []), *cookies]}
            await send(message)

        await self.app(scope, receive, send_with_cookie)


app.add_middleware(_LangCookieMiddleware)


def _fmt_dt(dt: datetime | None) -> str:
    if dt is None:
        return "—"
    return dt.astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")


# `**Remote Ctrl [18141]**` のような 2 次ポート行を拾うパターン。
# DCSSB Tacview extension がこの形式で複数ポートを 1 値にまとめて返す。
_SUBPORT_RE = re.compile(r"\*\*\s*(.+?)\s*\[(\d+)\]\s*\*\*")
# host:port を先頭行から取り出すパターン (IP / hostname 両対応)。
_HOSTPORT_RE = re.compile(r"^([A-Za-z0-9.\-]+):(\d+)$")

# DCS Server Bot の Olympus extension は、稼働状況の「値」として各ロールの
# ログインパスワードを平文で返す:
#     https://<host>/olympusN/
#     ▫️ GameMaster: <パスワード>
#     🔹 Commander: <パスワード>
#     🔸 Commander: <パスワード>
# このパネルは `/` から htmx (hx-get="/panel/servers") で読み込まれる公開
# ページなので、そのまま出すとトップページにパスワードが載る。
#
# ★ ロール名を列挙して弾く実装にしないこと。bot が返すラベルは実際には
#   GameMaster と Commander×2 (絵文字だけが違う) で、Olympus には
#   adminPassword もある。ラベルが 1 つ増減しただけで静かに漏れ始める。
#   そこで「Olympus 拡張の 2 行目以降にある `ラベル: 値`」は中身を一律で
#   伏せ、掲示場所だけを出す。接続先 URL は 1 行目なので影響を受けない。
_SECRET_BEARING_EXT_RE = re.compile(r"olympus", re.I)
_LABELLED_VALUE_RE = re.compile(r"^(?P<label>[^:]{1,40}):\s*\S.*$")
_SECRET_NOTICE = "パスワードは Discord に掲示"


def _mask_secret_line(ext_name: object, line: str) -> str:
    """Olympus 拡張の `ラベル: 値` 行から値を落とし、掲示場所に置き換える。"""
    if not _SECRET_BEARING_EXT_RE.search(str(ext_name or "")):
        return line
    m = _LABELLED_VALUE_RE.match(line)
    if not m:
        return line
    return f"{m.group('label').strip()}: {_SECRET_NOTICE}"


def _expand_extensions(servers: list) -> list:
    """`extensions[].value` を 1 chip = 1 エンドポイント に正規化する。

    例: Tacview は ``"111.237.107.64:18131\\n**Remote Ctrl [18141]**\\n"`` の
    ような複合値を返す。これを:
      - Tacview             : 111.237.107.64:18131
      - Tacview Remote Ctrl : 111.237.107.64:18141
    の 2 chip に分解して扱いやすくする。先頭行が host:port 形式なら host を
    継承して副ポートに付ける。
    """
    out: list = []
    for s in servers:
        s2 = dict(s)
        new_exts: list[dict] = []
        for ext in (s.get("extensions") or []):
            raw = (ext.get("value") or "").strip()
            lines = [ln.strip() for ln in raw.split("\n") if ln.strip()]
            if not lines:
                new_exts.append(ext)
                continue
            primary = lines[0]
            host_m = _HOSTPORT_RE.match(primary)
            host = host_m.group(1) if host_m else ""
            new_exts.append(
                {
                    "name": ext.get("name"),
                    "version": ext.get("version"),
                    "value": primary,
                }
            )
            for line in lines[1:]:
                sub = _SUBPORT_RE.search(line)
                if sub:
                    label, port = sub.group(1).strip(), sub.group(2)
                    new_exts.append(
                        {
                            "name": f"{ext.get('name')} {label}",
                            "version": ext.get("version"),
                            "value": f"{host}:{port}" if host else f":{port}",
                        }
                    )
                else:
                    # 想定外の追加行は `**` だけ落として素直に別 chip 化。
                    # Olympus のロール行はここに落ちてくるので、値を伏せる。
                    new_exts.append(
                        {
                            "name": ext.get("name"),
                            "version": ext.get("version"),
                            "value": _mask_secret_line(
                                ext.get("name"), line.replace("**", "")
                            ),
                        }
                    )
        s2["extensions"] = new_exts
        out.append(s2)
    return out


def _split_extensions(servers: list) -> tuple[list[dict], set[str]]:
    """`/servers.extensions` をグローバル / per-server に分離。

    全サーバで value が一致している拡張 = global (Sneaker / Lardoon 等の
    singleton サービス)。異なるもの = per-server (LotAtc / Tacview のポート)。

    Returns:
        (global_services, global_ext_names)
    """
    if not servers:
        return [], set()
    by_name: dict[str, set[str]] = {}
    name_order: list[str] = []
    for s in servers:
        for ext in (s.get("extensions") or []):
            n = ext.get("name")
            if not n:
                continue
            if n not in by_name:
                name_order.append(n)
            by_name.setdefault(n, set()).add((ext.get("value") or "").strip())
    global_services: list[dict] = []
    global_names: set[str] = set()
    for n in name_order:
        values = by_name[n]
        if len(values) == 1:
            (v,) = values
            if v:
                global_names.add(n)
                global_services.append({"name": n, "value": v})
    return global_services, global_names


def _processed_servers_from_cache() -> list:
    """cache から取り出した servers に `_expand_extensions` を適用して返す。"""
    cached = servers_cache.get()
    result = cached.value
    if not result or not result.ok or not isinstance(result.data, list):
        return []
    return _expand_extensions(result.data)


def _sort_players(servers: list) -> list:
    """players をスロット搭乗中 → 観戦中の順に並べ替える。

    DCSSB RestAPI `/servers` の `players[]` は `server.get_active_players()`
    から作られるので、切断済みプレイヤーは含まれない (以前の DCSSB は
    `server.players.values()` をそのまま返していたため、切断者がミッション
    再起動まで残り続けていた。その回避策として入れていた `unit_type` 非空
    フィルタは、接続中でも slot 未選択の人まで消してしまうので撤去済み)。

    `unit_type` が空 = ブリーフィング / slot-select 画面の観戦者。飛んでいる
    人を先に見せたいので後ろに回す。
    """
    out: list = []
    for s in servers:
        players = s.get("players")
        if isinstance(players, list):
            s2 = dict(s)
            s2["players"] = sorted(
                players,
                key=lambda p: (
                    not (p.get("unit_type") or "").strip(),
                    (p.get("nick") or "").lower(),
                ),
            )
            out.append(s2)
        else:
            out.append(s)
    return out


def _fmt_age(dt: datetime | None) -> str:
    if dt is None:
        return "no data yet"
    delta = (datetime.now().astimezone() - dt.astimezone()).total_seconds()
    if delta < 0:
        return "just now"
    if delta < 60:
        return f"{int(delta)}s ago"
    if delta < 3600:
        return f"{int(delta // 60)}m ago"
    return f"{int(delta // 3600)}h ago"


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


def _home_stats() -> dict:
    cached = servers_cache.get()
    servers: list = []
    if cached.value and cached.value.ok and isinstance(cached.value.data, list):
        servers = cached.value.data
    running = sum(
        1 for s in servers if (s.get("status") or "").lower() == "running"
    )
    total_players = sum(len(s.get("players") or []) for s in servers)
    # tracks cache から総数を合算。unavailable サーバは 0 として扱う。
    tracks_c = tracks_cache.get()
    tracks_total = 0
    if tracks_c.value and isinstance(tracks_c.value, dict):
        for info in (tracks_c.value.get("summary") or {}).values():
            tracks_total += int(info.get("count") or 0)
    return {
        "running_count": running,
        "total_servers": len(servers),
        "total_players": total_players,
        "tracks_total": tracks_total,
        "age": _fmt_age(cached.fetched_at),
    }


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return render(request, "home.html", {"stats": _home_stats()})


@app.get("/guide", response_class=HTMLResponse)
async def guide_page(request: Request):
    return render(request, "guide.html")


@app.get("/hermes", response_class=HTMLResponse)
async def hermes_page(request: Request):
    return render(request, "hermes.html")


@app.get("/hermes/privacy", response_class=HTMLResponse)
async def hermes_privacy_page(request: Request):
    return render(request, "hermes_privacy.html")


@app.get("/privacy", response_class=HTMLResponse)
async def privacy_page(request: Request):
    return render(request, "privacy.html")


@app.get("/known-issues", response_class=HTMLResponse)
async def known_issues(request: Request):
    return render(request, "known_issues.html")


@app.get("/status", response_class=HTMLResponse)
async def status_page(request: Request):
    return render(request, "index.html", {"poll_seconds": 15})


def _server_order_key(s: dict) -> tuple:
    """サーバカードの並び順。`address` 末尾のポート (server1=18101, server2=18102, ...) 順。

    表示名で並べると大文字小文字や改名で順番が入れ替わる (2026-09-10、
    "FFS Open Alpha 3" が "FFS open alpha 1" より前に来た)。ポートは nodes.yaml で
    インスタンスごとに固定なので改名しても変わらない。ポートが取れないものは末尾に名前順。
    """
    port = str(s.get("address") or "").rsplit(":", 1)[-1]
    if port.isdigit():
        return (0, int(port), "")
    return (1, 0, (s.get("name") or "").casefold())


@app.get("/panel/servers", response_class=HTMLResponse)
async def panel_servers(request: Request):
    cached = servers_cache.get()
    result = cached.value
    servers: list = []
    error = cached.error
    if result is not None:
        if result.ok and isinstance(result.data, list):
            servers = sorted(
                _sort_players(_expand_extensions(result.data)),
                key=_server_order_key,
            )
        elif result.error:
            error = result.error
    _, global_ext_names = _split_extensions(servers)
    # Server Load (FPS/CPU/Mem/Players の直近 60 分時系列) を同じカードに埋め込む。
    # RestAPI (外形監視の真) の server name をキーに DB 時系列を合流させる。
    load_cached = load_cache.get()
    load_by_name: dict = {}
    if load_cached.value and load_cached.value.ok and load_cached.value.series:
        load_by_name = {s.name: s for s in load_cached.value.series}
    return render(
        request,
        "servers_panel.html",
        {
            "servers": servers,
            "error": error,
            "updated_at": _fmt_dt(cached.fetched_at),
            "age": _fmt_age(cached.fetched_at),
            "global_ext_names": global_ext_names,
            "load_by_name": load_by_name,
            "load_window_minutes": db.HISTORY_MINUTES,
        },
    )


@app.get("/health", response_class=HTMLResponse)
async def health_page(request: Request):
    return render(request, "health.html")


@app.get("/panel/fitbit", response_class=HTMLResponse)
async def panel_fitbit(request: Request):
    c_live = fitbit_cache.get()       # 現在値 + 24h chart (60s)
    c_7d = fitbit7d_cache.get()       # 7 日 chart + 睡眠バー (600s)
    live = c_live.value if (c_live.value and not c_live.value.get("error")) else None
    seven = c_7d.value if (c_7d.value and not c_7d.value.get("error")) else None
    # error は live を優先 (認証エラー等は両者共通)
    error = c_live.error
    if c_live.value and c_live.value.get("error"):
        error = c_live.value["error"]
    # live を後勝ちで merge (window_end / current_hr は live が正)
    data = None
    if live or seven:
        data = {**(seven or {}), **(live or {})}
    return render(
        request,
        "fitbit_panel.html",
        {
            "d": data,
            "error": error,
            "age": _fmt_age(c_live.fetched_at),
        },
    )


@app.get("/panel/sysmon", response_class=HTMLResponse)
async def panel_sysmon(request: Request):
    cached = sysmon_cache.get()
    return render(
        request,
        "sysmon_panel.html",
        {
            "m": cached.value,
            "error": cached.error,
            "age": _fmt_age(cached.fetched_at),
        },
    )


# DCSSB /highscore のカテゴリ (順序 = 表示順、データが空のカテゴリは非表示)。
# 上位 10 人のみ表示 (limit=10)。ラベルは i18n キー (テンプレ側で t() を通す)。
HIGHSCORE_CATEGORIES = [
    ("playtime", "lb_cat_playtime", "Flight Time"),
    ("Air Targets", "lb_cat_air", "Kills"),
    ("Ground Targets", "lb_cat_ground", "Kills"),
    # Air Defence は SAM / AAA / MANPADS / 対空レーダーをまとめた DCS カテゴリ。
    ("Air Defence", "lb_cat_airdef", "Kills"),
    ("PvP-KD-Ratio", "lb_cat_pvp", "Ratio"),
]


_JST = ZoneInfo("Asia/Tokyo")


def _fmt_highscore_date(raw: str) -> str:
    """DCSSB の date 文字列 (ISO 8601 naive, UTC 格納) を JST 表示に整形。"""
    if not raw:
        return ""
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return raw[:16] if len(raw) > 16 else raw
    if dt.tzinfo is None:
        # DCSSB は UTC で保存している想定 (postgres timestamp はデフォで UTC)。
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(_JST).strftime("%Y-%m-%d %H:%M")


def _format_highscore_entry(cat_key: str, entry: dict) -> dict:
    nick = entry.get("nick") or "?"
    date = _fmt_highscore_date(entry.get("date") or "")
    value: str = "-"
    if cat_key == "playtime":
        secs = int(entry.get("playtime") or 0)
        h, rem = divmod(secs, 3600)
        value = f"{h}h {rem // 60:02d}m"
    elif cat_key == "Ground Targets":
        for k, v in entry.items():
            if k in ("nick", "date"):
                continue
            if isinstance(v, bool):
                continue
            if isinstance(v, int):
                value = f"{v}"
                break
            if isinstance(v, float):
                value = f"{int(v)}"  # 小数点以下を切り捨て
                break
            value = str(v)
            break
    else:
        for k, v in entry.items():
            if k in ("nick", "date"):
                continue
            if isinstance(v, bool):
                continue
            if isinstance(v, int):
                value = f"{v}"
                break
            if isinstance(v, float):
                value = f"{v:.2f}"
                break
            value = str(v)
            break
    return {"nick": nick, "value": value, "date": date}


def _fmt_bytes(n: int) -> str:
    n = int(n or 0)
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    if n < 1024**3:
        return f"{n / (1024 * 1024):.1f} MB"
    return f"{n / (1024**3):.2f} GB"


_TRACK_SERVER_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_TRACK_FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.trk$")


def _env_positive_int(name: str, default: int) -> int:
    """環境変数を 1 以上の整数として読む。未設定・不正値・1 未満は default。"""
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if value < 1:
        log.warning("%s=%r は 1 以上の整数ではないため既定値 %d を使う", name, raw, default)
        return default
    return value


# .trk は数百 MB 級で、/proxy/tracks は未認証で叩ける。同時に中継する本数を
# 絞って回線と上流 (DCSSB) を守る。空きが無いときは待たせずに 503 を返す。
TRACK_DOWNLOAD_CONCURRENCY = _env_positive_int("TRACK_DOWNLOAD_CONCURRENCY", 4)
# 接続元 1 つあたりの同時本数。1 人 (1 IP) で全部の枠を埋められないようにする。
TRACK_DOWNLOAD_PER_CLIENT = _env_positive_int("TRACK_DOWNLOAD_PER_CLIENT", 2)
# 超過 release (後始末の二重実行) を ValueError で表に出すため Bounded にする。
_track_slots = asyncio.BoundedSemaphore(TRACK_DOWNLOAD_CONCURRENCY)
_track_clients: dict[str, int] = {}
_TRACK_RETRY_AFTER = "30"
# 読まない・極端に遅い転送が枠を握り続けないための打ち切り条件。
#   - 1 チャンクの送信が _TRACK_SEND_STALL_SECONDS 以上終わらない
#   - _TRACK_RATE_WINDOW_SECONDS ごとの送信量が _TRACK_MIN_BYTES_PER_WINDOW 未満
#     (5 MiB / 5 分 ≒ 17 KiB/s。上流が遅い場合もここで切れる)
# ★ 幅を短くしないこと。送信側のソケットバッファは自動調整で数 MB まで育ち、
#   send は「そのバッファの一部が捌けるまで」待つので、20 KiB/s 程度の正規の
#   利用者でも 1 回の send が 60 秒を超える (Caddy 経由で実測、60 秒幅だと
#   2〜3 分で打ち切っていた)。送信量も数 MB 単位でまとまって進む。
_TRACK_SEND_STALL_SECONDS = 300.0
_TRACK_RATE_WINDOW_SECONDS = 300.0
_TRACK_MIN_BYTES_PER_WINDOW = 5 * 1024 * 1024
# 打ち切った接続元の枠を返すまでの時間。打ち切っても、読まない相手との接続は
# 相手が閉じるまで (送信バッファを抱えたまま) 残る。すぐ枠を返すと、同じ接続元が
# 「張る → 打ち切られる → また張る」でその接続を積み上げられるので、しばらく
# 接続元ごとの上限に数えたままにする。全体の枠と上流の接続はすぐ返す。
_TRACK_ABORT_HOLD_SECONDS = 600.0


def _release_client(key: str) -> None:
    left = _track_clients.get(key, 0) - 1
    if left > 0:
        _track_clients[key] = left
    else:
        _track_clients.pop(key, None)


async def _aclose_quietly(res: httpx.Response | httpx.AsyncClient | None) -> None:
    if res is None:
        return
    try:
        await res.aclose()
    except Exception:
        log.warning("tracks: upstream close failed", exc_info=True)


class _TrackDownload:
    """1 本の .trk 中継が握る資源 (上流レスポンス・client・同時実行枠)。

    close() は冪等で、どの経路から何度呼ばれても後始末は 1 回だけ行う。
    """

    def __init__(self, slots: asyncio.Semaphore, client_key: str) -> None:
        # 呼び出し側で slots の acquire と _track_clients の加算を済ませていること。
        self._slots = slots
        self._client_key = client_key
        self._closed = False
        self.client: httpx.AsyncClient | None = None
        self.upstream: httpx.Response | None = None
        # 真なら接続元の枠を _TRACK_ABORT_HOLD_SECONDS 後に返す (打ち切り時)
        self.hold_client = False

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            # クライアント切断でキャンセルされている最中でも close を最後まで
            # 走らせる (途中で止まると上流の接続が残る)。
            with anyio.CancelScope(shield=True):
                try:
                    await _aclose_quietly(self.upstream)
                finally:
                    # upstream の close が BaseException で抜けても client は閉じる。
                    await _aclose_quietly(self.client)
        finally:
            self._slots.release()
            if self.hold_client:
                asyncio.get_running_loop().call_later(
                    _TRACK_ABORT_HOLD_SECONDS, _release_client, self._client_key
                )
            else:
                _release_client(self._client_key)


class _TrackTransferAborted(Exception):
    """送信が止まった、または転送が遅すぎる (上流か利用者) ので中継を打ち切る。"""


class _TrackStreamingResponse(StreamingResponse):
    """ASGI 送信がどう終わっても (完了・例外・切断) download を閉じる。

    本文ジェネレータの finally だけに頼ると、反復が一度も始まらない経路
    (http.response.start の送信時点でクライアントが消えている等) で漏れる。
    """

    def __init__(self, download: _TrackDownload, label: str, **kwargs) -> None:
        super().__init__(**kwargs)
        self._download = download
        self._label = label

    def _watch(self, send: Send) -> Send:
        window_start = time.monotonic()
        window_bytes = 0

        async def watched_send(message: Message) -> None:
            nonlocal window_start, window_bytes
            if message["type"] != "http.response.body":
                await send(message)
                return
            try:
                with anyio.fail_after(_TRACK_SEND_STALL_SECONDS):
                    await send(message)
            except TimeoutError:
                raise _TrackTransferAborted(
                    f"send stalled for {_TRACK_SEND_STALL_SECONDS:.0f}s"
                ) from None
            window_bytes += len(message.get("body", b""))
            now = time.monotonic()
            if now - window_start >= _TRACK_RATE_WINDOW_SECONDS:
                if window_bytes < _TRACK_MIN_BYTES_PER_WINDOW:
                    raise _TrackTransferAborted(
                        f"transfer too slow (upstream or client): "
                        f"{window_bytes} bytes in {now - window_start:.0f}s"
                    )
                window_start, window_bytes = now, 0

        return watched_send

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, self._watch(send))
        except (_TrackTransferAborted, httpx.HTTPError) as e:
            # 応答は既に始まっている。終端を送らずに戻ると uvicorn が接続を閉じに
            # いき (送信済みの分を吐き切ってから閉じる)、利用者には途中で切れた
            # 転送として見える (chunked でも Content-Length ありでも)。uvicorn は
            # "ASGI callable returned without completing response." を ERROR で
            # 1 行出すが、想定内の打ち切りなのでここではスタックトレースを出さない。
            if isinstance(e, _TrackTransferAborted):
                self._download.hold_client = True
            log.warning(
                "tracks: %s transfer aborted: %s: %s",
                self._label, type(e).__name__, e,
            )
        finally:
            await self._download.close()


async def _relay_track(upstream: httpx.Response):
    """上流の raw バイトをそのまま流す (Accept-Encoding: identity なので本文)。"""
    async for chunk in upstream.aiter_raw():
        yield chunk


@app.get("/tracks", response_class=HTMLResponse)
async def tracks_page(request: Request):
    cached = tracks_cache.get()
    data = cached.value or {}
    error = data.get("error") or cached.error
    summary = data.get("summary") or {}
    raw_lists = data.get("lists") or {}
    server_tracks: dict[str, list[dict]] = {}
    unavailable: dict[str, bool] = {}
    for server in sorted(summary.keys()):
        unavailable[server] = bool(summary[server].get("unavailable"))
        files = []
        for f in raw_lists.get(server) or []:
            files.append(
                {
                    "name": f.get("name"),
                    "size": f.get("size") or 0,
                    "size_human": _fmt_bytes(f.get("size") or 0),
                    "mtime": f.get("mtime"),
                    "mtime_str": (
                        _datetime.fromtimestamp(int(f.get("mtime") or 0))
                        .astimezone()
                        .strftime("%Y-%m-%d %H:%M")
                        if f.get("mtime")
                        else "-"
                    ),
                }
            )
        server_tracks[server] = files
    return render(
        request,
        "tracks.html",
        {
            "server_tracks": server_tracks,
            "unavailable": unavailable,
            "error": error,
            "updated_at": _fmt_dt(cached.fetched_at),
            "age": _fmt_age(cached.fetched_at),
        },
    )


@app.get("/proxy/tracks/{server}/{filename}")
async def proxy_track_download(request: Request, server: str, filename: str):
    """.trk ダウンロードプロキシ。api_key をヘッダ注入して DCSSB から取得、
    ブラウザに attachment として返す。

    本文はメモリに溜めずチャンクごとに中継する。エラー応答には上流の詳細を
    出さず、詳細はログにだけ残す。
    """
    if not _TRACK_SERVER_RE.match(server):
        raise HTTPException(400, "invalid server name")
    if not _TRACK_FILENAME_RE.match(filename):
        raise HTTPException(400, "invalid filename")
    # 接続元。uvicorn の --proxy-headers により X-Forwarded-For の先頭になるが、
    # Caddy は利用者が送ってきた XFF を信用せず接続元のアドレスで作り直すので
    # 偽装できない。
    client_key = request.client.host if request.client else ""
    # 空きが無ければ待たずに断る。asyncio は単一スレッドで、locked() が偽なら
    # acquire() は待たずに返るので、この間に他の要求は割り込まない。
    if _track_slots.locked():
        raise HTTPException(
            503,
            "too many downloads in progress",
            headers={"Retry-After": _TRACK_RETRY_AFTER},
        )
    if _track_clients.get(client_key, 0) >= TRACK_DOWNLOAD_PER_CLIENT:
        raise HTTPException(
            429,
            "too many downloads from this client",
            headers={"Retry-After": _TRACK_RETRY_AFTER},
        )
    await _track_slots.acquire()
    _track_clients[client_key] = _track_clients.get(client_key, 0) + 1
    download = _TrackDownload(_track_slots, client_key)
    label = f"{server}/{filename}"
    response: _TrackStreamingResponse | None = None
    try:
        try:
            download.client, download.upstream = await dcssb.open_track_stream(
                server, filename
            )
        except Exception as e:
            log.warning("tracks: %s upstream request failed: %s: %s", label, type(e).__name__, e)
            raise HTTPException(502, "upstream error") from None
        upstream = download.upstream
        if upstream.status_code == 404:
            raise HTTPException(404, "track not found")
        if upstream.status_code != 200:
            log.warning("tracks: %s upstream HTTP %d", label, upstream.status_code)
            raise HTTPException(502, "upstream error")
        headers = {
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, max-age=0",
        }
        content_length = upstream.headers.get("content-length", "")
        if content_length.isascii() and content_length.isdigit():
            headers["Content-Length"] = content_length
        # identity を頼んでも圧縮で返された場合は、raw バイト (= 圧縮済み) と
        # 整合するよう符号化方式も伝えてブラウザに展開させる。
        content_encoding = upstream.headers.get("content-encoding", "")
        if content_encoding and content_encoding.lower() != "identity":
            headers["Content-Encoding"] = content_encoding
        response = _TrackStreamingResponse(
            download,
            label,
            content=_relay_track(upstream),
            media_type="application/octet-stream",
            headers=headers,
        )
        return response
    finally:
        # 応答オブジェクトに渡せなかった経路 (エラー・キャンセル) はここで閉じる。
        # 渡した後の後始末は _TrackStreamingResponse.__call__ が持つ。
        if response is None:
            await download.close()


@app.get("/leaderboard", response_class=HTMLResponse)
async def leaderboard(request: Request):
    limit = 10
    cached = highscore_cache.get()
    result = cached.value
    raw: dict = {}
    error = cached.error
    if result is not None:
        if result.ok and isinstance(result.data, dict):
            raw = result.data
        elif result.error:
            error = result.error
    cats = []
    for key, label, metric in HIGHSCORE_CATEGORIES:
        entries = [_format_highscore_entry(key, e) for e in (raw.get(key) or [])]
        cats.append({"key": key, "label": label, "metric": metric, "entries": entries})
    has_any = any(c["entries"] for c in cats)
    return render(
        request,
        "leaderboard.html",
        {
            "cats": cats,
            "error": error,
            "has_any": has_any,
            "limit": limit,
            "period_label": "lb_period",
            "updated_at": _fmt_dt(cached.fetched_at),
            "age": _fmt_age(cached.fetched_at),
        },
    )
