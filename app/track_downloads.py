"""Bounded replay proxy; each response owns its upstream connection until closed."""
from __future__ import annotations

import logging
import os
import re
from threading import BoundedSemaphore

import anyio
import httpx
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.types import Receive, Scope, Send

from . import dcssb

logger = logging.getLogger(__name__)
CHUNK_SIZE = 64 * 1024


def _download_limit(value: str) -> int:
    if not re.fullmatch(r"[0-9]+", value) or not 1 <= int(value) <= 64:
        raise ValueError("TRACK_DOWNLOAD_LIMIT must be an integer from 1 to 64")
    return int(value)


# Nonblocking acquire is atomic, including across threads/event loops. This is
# process-local: N workers/replicas can admit N * TRACK_DOWNLOAD_LIMIT downloads.
DOWNLOAD_SLOTS = BoundedSemaphore(
    _download_limit(os.getenv("TRACK_DOWNLOAD_LIMIT", "2"))
)


def _content_length(response: httpx.Response) -> int | None:
    value = response.headers.get("content-length")
    if value is None:
        return None
    # Reject ambiguous/duplicate, signed, non-ASCII or excessively long values.
    if not re.fullmatch(r"[0-9]{1,20}", value):
        raise ValueError("invalid upstream content length")
    return int(value)


async def _chunks(response: httpx.Response, expected: int | None):
    transferred = 0
    # Raw bytes + identity encoding preserve the advertised length exactly.
    # The next upstream read happens only after downstream send has completed.
    async for chunk in response.aiter_raw(chunk_size=CHUNK_SIZE):
        transferred += len(chunk)
        if expected is not None and transferred > expected:
            raise ValueError("upstream content length exceeded")
        yield chunk
    if expected is not None and transferred != expected:
        raise ValueError("incomplete upstream replay")


class TrackDownloadResponse(StreamingResponse):
    """Open lazily inside ASGI so disconnects also cancel connection setup.

    The upstream contexts enclose the entire response send, including failures
    before the first body chunk. BackgroundTask/generator-only cleanup would
    miss some of these paths. No detached cleanup or prefetch task is used.
    """

    def __init__(self, server: str, filename: str):
        self.server = server
        self.filename = filename
        super().__init__(
            content=(),
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Cache-Control": "private, max-age=0",
                "X-Content-Type-Options": "nosniff",
            },
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # Always watch disconnects, including ASGI 2.4 and during upstream
        # connect/header waits, not only while StreamingResponse sends a body.
        async with anyio.create_task_group() as tasks:
            async def watch_disconnect():
                await self.listen_for_disconnect(receive)
                tasks.cancel_scope.cancel()

            tasks.start_soon(watch_disconnect)
            try:
                await self._serve(scope, receive, send)
            finally:
                tasks.cancel_scope.cancel()

    async def _serve(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not DOWNLOAD_SLOTS.acquire(blocking=False):
            await JSONResponse(
                {"detail": "too many downloads; try again later"},
                status_code=503,
                headers={"Retry-After": "5"},
            )(scope, receive, send)
            return

        started = False
        try:
            async with dcssb.stream_track_file(self.server, self.filename) as upstream:
                if upstream.status_code != 200:
                    status, detail = {
                        400: (400, "invalid track request"),
                        404: (404, "track not found"),
                    }.get(upstream.status_code, (502, "upstream unavailable"))
                    started = True
                    await JSONResponse({"detail": detail}, status_code=status)(
                        scope, receive, send
                    )
                    return
                if upstream.headers.get("content-encoding", "identity").lower() != "identity":
                    raise ValueError("unexpected upstream content encoding")
                length = _content_length(upstream)
                if length is not None:
                    self.headers["Content-Length"] = str(length)
                self.body_iterator = _chunks(upstream, length)
                started = True
                await self.stream_response(send)
        except Exception:
            # Neither upstream bodies/URLs nor exception strings belong in the
            # public response or application log (may contain internal details).
            logger.warning("Replay download failed")
            if started:
                # Headers are committed: abort instead of claiming success or
                # appending JSON to the file. Clients detect an incomplete body.
                raise RuntimeError("replay download interrupted") from None
            await JSONResponse(
                {"detail": "upstream unavailable"}, status_code=502
            )(scope, receive, send)
        finally:
            DOWNLOAD_SLOTS.release()
