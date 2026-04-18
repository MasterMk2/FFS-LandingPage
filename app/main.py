"""FFS DCS ランディングページ (FastAPI)."""
from __future__ import annotations

import logging
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from urllib.parse import urlparse

from datetime import datetime as _datetime

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import cache, db, dcssb

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

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
ALL_CACHES = [servers_cache, load_cache, highscore_cache, tracks_cache]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    for c in ALL_CACHES:
        c.start()
    try:
        yield
    finally:
        for c in ALL_CACHES:
            c.stop()


app = FastAPI(
    title="FFS DCS Status", docs_url=None, redoc_url=None, lifespan=lifespan
)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


def _fmt_dt(dt: datetime | None) -> str:
    if dt is None:
        return "—"
    return dt.astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")


# `**Remote Ctrl [18141]**` のような 2 次ポート行を拾うパターン。
# DCSSB Tacview extension がこの形式で複数ポートを 1 値にまとめて返す。
_SUBPORT_RE = re.compile(r"\*\*\s*(.+?)\s*\[(\d+)\]\s*\*\*")
# host:port を先頭行から取り出すパターン (IP / hostname 両対応)。
_HOSTPORT_RE = re.compile(r"^([A-Za-z0-9.\-]+):(\d+)$")


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
                    new_exts.append(
                        {
                            "name": ext.get("name"),
                            "version": ext.get("version"),
                            "value": line.replace("**", ""),
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


# ランディング自体を指す URL は Services バーから除外する (自己リンク防止)。
# DCSSB の `WebSite: url: https://freedomflight.jp/` エントリなどをフィルタする。
_SELF_HOSTS = {"freedomflight.jp", "www.freedomflight.jp"}

# Services バーに出さない extension 名のパターン。過去の nodes.yaml 残骸や
# 上位互換エントリが別名で重複表示されるのを防ぐ。
_SERVICES_EXCLUDED_NAME_SUBSTRINGS = ("Tacview Replay",)


def _services_from_cache() -> list[dict]:
    """base.html の Services バーに渡すグローバルサービス一覧。

    自ホストの **ルート URL** (= ランディング自身) のみ除外する。
    同一ホストでも path 付き (例: `/tracks`) はランディング内の別ページへの
    導線として Services バーに残す。
    """
    services, _ = _split_extensions(_processed_servers_from_cache())
    out: list[dict] = []
    for svc in services:
        name = svc.get("name") or ""
        if any(s in name for s in _SERVICES_EXCLUDED_NAME_SUBSTRINGS):
            continue
        try:
            parsed = urlparse(svc["value"])
            host = (parsed.hostname or "").lower()
            path = (parsed.path or "").strip()
        except Exception:
            host, path = "", ""
        if host in _SELF_HOSTS and path in ("", "/"):
            continue
        out.append(svc)
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
    return templates.TemplateResponse(
        "home.html",
        {
            "request": request,
            "stats": _home_stats(),
            "external_services": _services_from_cache(),
        },
    )


@app.get("/status", response_class=HTMLResponse)
async def status_page(request: Request):
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "poll_seconds": 15,
            "external_services": _services_from_cache(),
        },
    )


@app.get("/panel/servers", response_class=HTMLResponse)
async def panel_servers(request: Request):
    cached = servers_cache.get()
    result = cached.value
    servers: list = []
    error = cached.error
    if result is not None:
        if result.ok and isinstance(result.data, list):
            # serverload パネル (DB 由来、name 昇順) と並びを揃えるため sort。
            servers = sorted(
                _expand_extensions(result.data),
                key=lambda s: s.get("name") or "",
            )
        elif result.error:
            error = result.error
    _, global_ext_names = _split_extensions(servers)
    return templates.TemplateResponse(
        "servers_panel.html",
        {
            "request": request,
            "servers": servers,
            "error": error,
            "updated_at": _fmt_dt(cached.fetched_at),
            "age": _fmt_age(cached.fetched_at),
            "global_ext_names": global_ext_names,
        },
    )


@app.get("/panel/serverload", response_class=HTMLResponse)
async def panel_serverload(request: Request):
    cached = load_cache.get()
    result = cached.value
    series = []
    error = cached.error
    if result is not None:
        series = result.series or []
        if not result.ok and result.error:
            error = result.error
    return templates.TemplateResponse(
        "serverload_panel.html",
        {
            "request": request,
            "series": series,
            "error": error,
            "updated_at": _fmt_dt(cached.fetched_at),
            "age": _fmt_age(cached.fetched_at),
            "window_minutes": db.HISTORY_MINUTES,
        },
    )


# DCSSB /highscore のカテゴリ (順序 = 表示順、データが空のカテゴリは非表示)。
# 上位 10 人のみ表示 (limit=10)。
HIGHSCORE_CATEGORIES = [
    ("playtime", "飛行時間", "Flight Time"),
    ("Air Targets", "空中目標撃破", "Kills"),
    ("Ground Targets", "地上目標撃破", "Kills"),
    # Air Defence は SAM / AAA / MANPADS / 対空レーダーをまとめた DCS カテゴリ。
    ("Air Defence", "対空 (SAM/AAA)", "Kills"),
    ("PvP-KD-Ratio", "PvP KD 比", "Ratio"),
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
    return templates.TemplateResponse(
        "tracks.html",
        {
            "request": request,
            "server_tracks": server_tracks,
            "unavailable": unavailable,
            "error": error,
            "updated_at": _fmt_dt(cached.fetched_at),
            "age": _fmt_age(cached.fetched_at),
            "external_services": _services_from_cache(),
        },
    )


@app.get("/proxy/tracks/{server}/{filename}")
async def proxy_track_download(server: str, filename: str):
    """.trk ダウンロードプロキシ。api_key をヘッダ注入して DCSSB から取得、
    ブラウザに attachment として返す。"""
    if not _TRACK_SERVER_RE.match(server):
        raise HTTPException(400, "invalid server name")
    if not _TRACK_FILENAME_RE.match(filename):
        raise HTTPException(400, "invalid filename")
    try:
        r = await dcssb.fetch_track_file(server, filename)
    except Exception as e:
        raise HTTPException(502, f"upstream error: {type(e).__name__}: {e}")
    if r.status_code == 404:
        raise HTTPException(404, "track not found")
    if r.status_code != 200:
        raise HTTPException(502, f"upstream HTTP {r.status_code}")
    return Response(
        content=r.content,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, max-age=0",
        },
    )


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
    return templates.TemplateResponse(
        "leaderboard.html",
        {
            "request": request,
            "cats": cats,
            "error": error,
            "has_any": has_any,
            "limit": limit,
            "period_label": "過去 30 日",
            "updated_at": _fmt_dt(cached.fetched_at),
            "age": _fmt_age(cached.fetched_at),
            "external_services": _services_from_cache(),
        },
    )
