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


async def _get(path: str, params: dict | None = None) -> FetchResult:
    url = f"{DCSSB_BASE_URL.rstrip('/')}{DCSSB_API_PREFIX}{path}"
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
