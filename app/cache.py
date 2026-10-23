"""Background-refreshed in-memory cache。

目的:
    F5 連打でも DCSSB API / postgres に負荷をかけないよう、handler は常に
    cache を読むだけにする。cache は起動時から独立した asyncio タスクで
    periodic refresh される (interval 秒ごと)。

使い方:
    fetcher = Fetcher(fetch=coroutine_factory, interval=60, name='foo')
    fetcher.start()        # FastAPI lifespan で startup 時に呼ぶ
    cached = fetcher.get() # handler で同期取得 (I/O なし)
    fetcher.stop()         # shutdown 時
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Awaitable, Callable, Generic, TypeVar

import httpx

T = TypeVar("T")
log = logging.getLogger(__name__)


def public_error(e: BaseException) -> str:
    """画面や応答に出してよい短いエラー分類を返す。

    例外の文字列には上流の URL・応答本文・接続先アドレスが入りうるので、
    公開ページには例外の型から決めた汎用の分類だけを出す。詳細は呼び出し側で
    ログに残すこと。
    """
    if isinstance(e, httpx.HTTPStatusError):
        return f"HTTP {e.response.status_code}"
    # httpx.TimeoutException は TransportError の一種なので先に判定する。
    if isinstance(e, (httpx.TimeoutException, TimeoutError)):
        return "timeout"
    if isinstance(e, httpx.TransportError):
        return "connection error"
    # json の decode 失敗 (JSONDecodeError) は ValueError。
    if isinstance(e, ValueError):
        return "invalid response"
    return "unexpected error"


@dataclass
class CachedValue(Generic[T]):
    value: T | None = None
    fetched_at: datetime | None = None
    error: str | None = None


class Fetcher(Generic[T]):
    def __init__(
        self,
        fetch: Callable[[], Awaitable[T]],
        interval: int,
        name: str,
    ) -> None:
        self._fetch = fetch
        self._interval = interval
        self._name = name
        self._state: CachedValue[T] = CachedValue()
        self._task: asyncio.Task | None = None

    async def _refresh_once(self) -> None:
        try:
            v = await self._fetch()
            self._state = CachedValue(value=v, fetched_at=datetime.now().astimezone())
            log.debug("[cache:%s] refreshed", self._name)
        except Exception as e:
            log.exception("[cache:%s] fetch failed", self._name)
            # 直近の成功値は保持したまま error 情報だけ更新。error は公開ページに
            # そのまま出るので汎用の分類だけにする (詳細は上の log.exception)。
            self._state = CachedValue(
                value=self._state.value,
                fetched_at=self._state.fetched_at,
                error=public_error(e),
            )

    async def _loop(self) -> None:
        log.info("[cache:%s] starting (interval=%ds)", self._name, self._interval)
        await self._refresh_once()
        while True:
            try:
                await asyncio.sleep(self._interval)
            except asyncio.CancelledError:
                log.info("[cache:%s] stopping", self._name)
                raise
            await self._refresh_once()

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._loop(), name=f"cache-{self._name}")

    def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()

    def get(self) -> CachedValue[T]:
        return self._state
