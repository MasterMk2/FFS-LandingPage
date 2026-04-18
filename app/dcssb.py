"""DCSServerBot RestAPI client.

WebService (master node) は netns 共有により dcs-server-1 内で listen する。
同じ dcs_network に参加している当コンテナからは http://dcs-server-1:9876 で到達可能。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import httpx

DCSSB_BASE_URL = os.getenv("DCSSB_BASE_URL", "http://dcs-server-1:9876")
DCSSB_API_PREFIX = os.getenv("DCSSB_API_PREFIX", "/stats")
# Track 配布 endpoint の prefix (同 WebService に相乗り、同 api_key)。
DCSSB_TRACKS_PREFIX = os.getenv("DCSSB_TRACKS_PREFIX", "/tracks")
DCSSB_API_KEY = os.getenv("DCSSB_API_KEY", "")
DCSSB_TIMEOUT = float(os.getenv("DCSSB_TIMEOUT", "3.0"))


@dataclass
class FetchResult:
    ok: bool
    data: Any = None
    error: str | None = None
    status_code: int | None = None


def _headers() -> dict[str, str]:
    h = {"Accept": "application/json"}
    if DCSSB_API_KEY:
        h["X-API-KEY"] = DCSSB_API_KEY
    return h


async def _get(
    path: str, params: dict | None = None, prefix: str | None = None
) -> FetchResult:
    eff_prefix = DCSSB_API_PREFIX if prefix is None else prefix
    url = f"{DCSSB_BASE_URL.rstrip('/')}{eff_prefix}{path}"
    try:
        async with httpx.AsyncClient(timeout=DCSSB_TIMEOUT) as client:
            r = await client.get(url, headers=_headers(), params=params)
    except httpx.HTTPError as e:
        return FetchResult(ok=False, error=f"{type(e).__name__}: {e}")
    if r.status_code != 200:
        return FetchResult(
            ok=False,
            status_code=r.status_code,
            error=f"HTTP {r.status_code}: {r.text[:200]}",
        )
    try:
        return FetchResult(ok=True, data=r.json(), status_code=r.status_code)
    except ValueError as e:
        return FetchResult(ok=False, error=f"JSON decode error: {e}")


async def get_servers() -> FetchResult:
    """RestAPI: GET /stats/servers — 全サーバのステータス + 任意で weather。"""
    return await _get("/servers")


async def get_serverstats() -> FetchResult:
    """RestAPI: GET /stats/serverstats — 全体統計 (unique players, 総 playtime 等)。"""
    return await _get("/serverstats")


async def get_highscore(
    period: str = "month", limit: int = 10, server_name: str | None = None
) -> FetchResult:
    """RestAPI: GET /stats/highscore — カテゴリ別ランキング。period: day/week/month。"""
    params: dict = {"period": period, "limit": limit}
    if server_name:
        params["server_name"] = server_name
    return await _get("/highscore", params=params)


async def get_tracks_summary() -> FetchResult:
    """Tracks API: GET /tracks/ — 各サーバの trk ファイル件数。"""
    return await _get("/", prefix=DCSSB_TRACKS_PREFIX)


async def get_tracks_list(server: str) -> FetchResult:
    """Tracks API: GET /tracks/{server} — 個別サーバの trk 一覧 (newest first)。"""
    return await _get(f"/{server}", prefix=DCSSB_TRACKS_PREFIX)


async def fetch_track_file(server: str, filename: str) -> httpx.Response:
    """Tracks API: GET /tracks/{server}/{filename} — .trk バイナリを同期取得。

    呼び出し側で status_code を確認すること (200 以外なら 404/400 等を伝搬)。
    """
    url = (
        f"{DCSSB_BASE_URL.rstrip('/')}{DCSSB_TRACKS_PREFIX}/{server}/{filename}"
    )
    async with httpx.AsyncClient(timeout=60.0) as client:
        return await client.get(url, headers=_headers())
