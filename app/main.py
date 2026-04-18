"""FFS DCS ランディングページ (FastAPI)."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import dcssb

BASE_DIR = Path(__file__).parent

app = FastAPI(title="FFS DCS Status", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "poll_seconds": 15},
    )


@app.get("/panel/servers", response_class=HTMLResponse)
async def panel_servers(request: Request):
    """HTMX が周期 GET するサーバ状況パネル。"""
    result = await dcssb.get_servers()
    servers = result.data if result.ok and isinstance(result.data, list) else []
    return templates.TemplateResponse(
        "servers_panel.html",
        {
            "request": request,
            "servers": servers,
            "error": result.error,
            "updated_at": _now_iso(),
        },
    )
