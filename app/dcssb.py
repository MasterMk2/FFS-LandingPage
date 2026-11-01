"""DCSServerBot RestAPI client.

WebService (master node) は netns 共有により dcs-server-1 内で listen する。
同じ dcs_network に参加している当コンテナからは http://dcs-server-1:9876 で到達可能。
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Any

import anyio
import httpx

from .cache import public_error

log = logging.getLogger(__name__)

DCSSB_BASE_URL = os.getenv("DCSSB_BASE_URL", "http://dcs-server-1:9876")
DCSSB_API_PREFIX = os.getenv("DCSSB_API_PREFIX", "/stats")
# Track 配布 endpoint の prefix (同 WebService に相乗り、同 api_key)。
DCSSB_TRACKS_PREFIX = os.getenv("DCSSB_TRACKS_PREFIX", "/tracks")
# 部門別ポイント (ffs_points プラグイン) の prefix。同じ WebService に相乗り、同 api_key。
DCSSB_POINTS_PREFIX = os.getenv("DCSSB_POINTS_PREFIX", "/points")
DCSSB_API_KEY = os.getenv("DCSSB_API_KEY", "")
DCSSB_TIMEOUT = float(os.getenv("DCSSB_TIMEOUT", "3.0"))
# .trk 転送用。接続は短めに打ち切り、read は「1 回の読み取り (チャンク) ごと」の上限。
# 全体の所要時間はファイルサイズと利用者の回線次第なので上限を設けない。
TRACK_TIMEOUT = httpx.Timeout(connect=5.0, read=60.0, write=10.0, pool=5.0)

# 上流への transport。None なら httpx 既定 (実ネットワーク)。
# テストでは httpx.MockTransport を差し込んで DCSSB を偽装する。
TRANSPORT: httpx.AsyncBaseTransport | None = None


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
    # FetchResult.error は公開ページにそのまま出る。上流の応答本文や例外の文字列
    # (接続先アドレス等を含みうる) はログにだけ残し、error は汎用の分類にする。
    try:
        async with httpx.AsyncClient(
            timeout=DCSSB_TIMEOUT, transport=TRANSPORT
        ) as client:
            r = await client.get(url, headers=_headers(), params=params)
    except httpx.HTTPError as e:
        log.warning(
            "dcssb: GET %s%s failed: %s: %s", eff_prefix, path, type(e).__name__, e
        )
        return FetchResult(ok=False, error=public_error(e))
    if r.status_code != 200:
        log.warning(
            "dcssb: GET %s%s -> HTTP %d: %r",
            eff_prefix, path, r.status_code, r.text[:200],
        )
        return FetchResult(
            ok=False,
            status_code=r.status_code,
            error=f"HTTP {r.status_code}",
        )
    try:
        return FetchResult(ok=True, data=r.json(), status_code=r.status_code)
    except ValueError as e:
        log.warning("dcssb: GET %s%s -> invalid JSON: %s", eff_prefix, path, e)
        return FetchResult(ok=False, error="invalid response")


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


async def get_points_board() -> FetchResult:
    """Points API: GET /points/board — 公開用の部門別ランキング (点数は含まない)。"""
    return await _get("/board", prefix=DCSSB_POINTS_PREFIX)


# Discord user id (snowflake)。パスに入れる前に必ず確かめる。
_DISCORD_ID_RE = re.compile(r"[0-9]{5,25}")


async def _points_personal(method: str, kind: str, discord_id: str) -> FetchResult:
    """本人用の API。_get と違い、ログに Discord ID を含むパスと応答本文を残さない。"""
    if not _DISCORD_ID_RE.fullmatch(discord_id or ""):
        return FetchResult(ok=False, error="invalid id")
    url = f"{DCSSB_BASE_URL.rstrip('/')}{DCSSB_POINTS_PREFIX}/{kind}/{discord_id}"
    try:
        async with httpx.AsyncClient(
            timeout=DCSSB_TIMEOUT, transport=TRANSPORT
        ) as client:
            r = await client.request(method, url, headers=_headers())
    except httpx.HTTPError as e:
        log.warning("dcssb: %s points %s failed: %s", method, kind, type(e).__name__)
        return FetchResult(ok=False, error=public_error(e))
    if r.status_code != 200:
        log.warning("dcssb: %s points %s -> HTTP %d", method, kind, r.status_code)
        return FetchResult(
            ok=False, status_code=r.status_code, error=f"HTTP {r.status_code}"
        )
    try:
        return FetchResult(ok=True, data=r.json(), status_code=r.status_code)
    except ValueError:
        log.warning("dcssb: %s points %s -> invalid JSON", method, kind)
        return FetchResult(ok=False, error="invalid response")


async def get_points_member(discord_id: str) -> FetchResult:
    """Points API: GET /points/member/{discord_id} — 本人用。ログイン済みのときだけ呼ぶ。

    404 は「DCS と連携していない」、409 は「複数の DCS アカウントが連携している」、
    503 は「集計の準備中」。
    """
    return await _points_personal("GET", "member", discord_id)


async def get_points_link(discord_id: str) -> FetchResult:
    """Points API: GET /points/link/{discord_id} — 連携の状態と発行中のコード。本人用。

    404 は旧版の Bot。
    """
    return await _points_personal("GET", "link", discord_id)


async def post_points_link(discord_id: str) -> FetchResult:
    """Points API: POST /points/link/{discord_id} — コードの発行。発行中なら期限が延びる。"""
    return await _points_personal("POST", "link", discord_id)


async def open_track_stream(
    server: str, filename: str
) -> tuple[httpx.AsyncClient, httpx.Response]:
    """Tracks API: GET /tracks/{server}/{filename} — .trk をストリーミングで開く。

    応答ヘッダを受け取った時点で (client, response) を返す。本文はまだ読んで
    いないので、呼び出し側が response.aiter_raw() でチャンクごとに読み、最後に
    response.aclose() と client.aclose() を必ず呼ぶこと。status_code の確認
    (200 以外なら 404/502 等に変換) も呼び出し側で行う。

    Accept-Encoding: identity を送り、raw バイト = ファイル本文 (= 上流の
    Content-Length と一致) になるようにする。
    """
    url = (
        f"{DCSSB_BASE_URL.rstrip('/')}{DCSSB_TRACKS_PREFIX}/{server}/{filename}"
    )
    client = httpx.AsyncClient(timeout=TRACK_TIMEOUT, transport=TRANSPORT)
    try:
        request = client.build_request(
            "GET", url, headers={**_headers(), "Accept-Encoding": "identity"}
        )
        response = await client.send(request, stream=True)
    except BaseException:
        # 接続失敗・キャンセル時も client は閉じる。キャンセル中でも close が
        # 中断されないよう shield する。
        with anyio.CancelScope(shield=True):
            await client.aclose()
        raise
    return client, response
