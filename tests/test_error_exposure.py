"""API 仕様とエラー詳細を公開ページに出さないこと (Issue #6)。

上流の応答本文や例外の文字列に目印 (MARKER) を仕込んで失敗させ、FetchResult.error・
cache の error・描画されたパネルのどこにも目印が出ないことを確かめる。
"""
import asyncio

import httpx
import psycopg
import pytest
from fastapi.testclient import TestClient

from app import cache, db, dcssb, fitbit, main, sysmon
from app.main import app


client = TestClient(app)
MARKER = "SECRET-MARKER-c41d"


@pytest.mark.parametrize("path", ["/openapi.json", "/docs", "/redoc", "/docs/oauth2-redirect"])
def test_api_schema_and_docs_are_not_served(path):
    assert client.get(path).status_code == 404


# --- dcssb._get -------------------------------------------------------------

def _upstream(monkeypatch, handler) -> None:
    monkeypatch.setattr(dcssb, "TRANSPORT", httpx.MockTransport(handler))


def _raise(exc_type):
    def handler(request):
        raise exc_type(f"{MARKER} http://10.0.0.5:9876/stats", request=request)

    return handler


@pytest.mark.parametrize(
    ("handler", "expected"),
    [
        (lambda req: httpx.Response(500, text=f"Traceback: {MARKER}"), "HTTP 500"),
        (lambda req: httpx.Response(401, json={"detail": MARKER}), "HTTP 401"),
        (lambda req: httpx.Response(200, text=f"<html>{MARKER}</html>"), "invalid response"),
        (_raise(httpx.ConnectError), "connection error"),
        (_raise(httpx.ReadTimeout), "timeout"),
        (_raise(httpx.RemoteProtocolError), "connection error"),
    ],
)
def test_fetch_result_error_is_a_generic_category(monkeypatch, handler, expected):
    _upstream(monkeypatch, handler)

    result = asyncio.run(dcssb.get_servers())

    assert result.ok is False
    assert result.error == expected
    assert MARKER not in repr(result)


# --- cache.Fetcher ------------------------------------------------------------

@pytest.mark.parametrize(
    ("exc", "expected"),
    [
        (RuntimeError(f"boom {MARKER}"), "unexpected error"),
        (KeyError(MARKER), "unexpected error"),
        (ValueError(f"bad json {MARKER}"), "invalid response"),
        (httpx.ConnectError(f"{MARKER} 10.0.0.5"), "connection error"),
        (TimeoutError(MARKER), "timeout"),
    ],
)
def test_cache_error_hides_exception_text(exc, expected):
    async def fetch():
        raise exc

    fetcher = cache.Fetcher(fetch=fetch, interval=60, name="test")
    asyncio.run(fetcher._refresh_once())

    assert fetcher.get().error == expected
    assert MARKER not in fetcher.get().error


def test_cache_keeps_last_good_value_on_failure():
    calls = 0

    async def fetch():
        nonlocal calls
        calls += 1
        if calls > 1:
            raise RuntimeError(MARKER)
        return "good"

    fetcher = cache.Fetcher(fetch=fetch, interval=60, name="test")
    asyncio.run(fetcher._refresh_once())
    asyncio.run(fetcher._refresh_once())

    assert fetcher.get().value == "good"
    assert fetcher.get().error == "unexpected error"


# --- db -------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("exc", "expected"),
    [
        (psycopg.OperationalError(f"connection to server at 10.0.0.9 failed {MARKER}"), "connection error"),
        (psycopg.errors.UndefinedTable(f'relation "serverstats" {MARKER}'), "database error"),
    ],
)
def test_db_error_hides_exception_text(monkeypatch, exc, expected):
    async def connect(*args, **kwargs):
        raise exc

    monkeypatch.setattr(db, "DCSSB_DB_URL", "postgresql://user:pw@db.invalid/x")
    monkeypatch.setattr(psycopg.AsyncConnection, "connect", connect)

    result = asyncio.run(db.get_server_load_series())

    assert result.ok is False
    assert result.error == expected
    assert MARKER not in repr(result)


# --- fitbit -----------------------------------------------------------------------

def test_fitbit_upstream_failure_does_not_reach_panel_data(monkeypatch):
    monkeypatch.setattr(fitbit, "CLIENT_ID", "cid")
    monkeypatch.setattr(fitbit, "CLIENT_SECRET", "secret")
    monkeypatch.setattr(fitbit, "_refresh_token", "rt")

    async def api_get(path, params=None):
        req = httpx.Request("GET", f"https://health.invalid{path}")
        resp = httpx.Response(403, text=MARKER, request=req)
        raise httpx.HTTPStatusError(f"403 {MARKER}", request=req, response=resp)

    monkeypatch.setattr(fitbit, "_api_get", api_get)

    live = asyncio.run(fitbit.get_fitbit_data())
    seven = asyncio.run(fitbit.get_fitbit_7d())

    assert live["error"] is None and seven["error"] is None
    assert MARKER not in repr(live) and MARKER not in repr(seven)


# --- 描画されたパネル -------------------------------------------------------------

def _fail_upstream(monkeypatch) -> None:
    _upstream(
        monkeypatch,
        lambda req: httpx.Response(500, text=f"Traceback (most recent call last): {MARKER}"),
    )


def _refresh(monkeypatch, fetcher) -> None:
    # 共有の cache を汚さないよう、テスト後に元の状態へ戻す。
    monkeypatch.setattr(fetcher, "_state", cache.CachedValue())
    asyncio.run(fetcher._refresh_once())


@pytest.mark.parametrize(
    ("fetcher_name", "path"),
    [
        ("servers_cache", "/panel/servers"),
        ("highscore_cache", "/leaderboard"),
        ("tracks_cache", "/tracks"),
    ],
)
def test_dcssb_failure_renders_only_the_category(monkeypatch, fetcher_name, path):
    _fail_upstream(monkeypatch)
    _refresh(monkeypatch, getattr(main, fetcher_name))

    r = client.get(path)

    assert r.status_code == 200
    assert "HTTP 500" in r.text
    assert MARKER not in r.text
    assert "Traceback" not in r.text


@pytest.mark.parametrize(
    ("fetcher_name", "path"),
    [
        ("servers_cache", "/panel/servers"),
        ("highscore_cache", "/leaderboard"),
        ("tracks_cache", "/tracks"),
        ("sysmon_cache", "/panel/sysmon"),
        ("fitbit_cache", "/panel/fitbit"),
    ],
)
def test_fetch_exception_renders_only_the_category(monkeypatch, fetcher_name, path):
    fetcher = getattr(main, fetcher_name)

    async def fetch():
        raise RuntimeError(f"{MARKER} /host/proc 10.0.0.5")

    monkeypatch.setattr(fetcher, "_fetch", fetch)
    _refresh(monkeypatch, fetcher)

    r = client.get(path)

    assert r.status_code == 200
    assert "unexpected error" in r.text
    assert MARKER not in r.text
    assert "RuntimeError" not in r.text


# --- sysmon のインターフェース名 ------------------------------------------------------

def test_sysmon_panel_does_not_show_interface_names(monkeypatch, tmp_path):
    iface = "enpsecret7s0"
    net_dir = tmp_path / "1" / "net"
    net_dir.mkdir(parents=True)
    (net_dir / "dev").write_text(
        "Inter-|   Receive                            |  Transmit\n"
        " face |bytes    packets errs drop fifo frame compressed multicast|"
        "bytes    packets errs drop fifo colls carrier compressed\n"
        f"{iface}: 5242880 100 0 0 0 0 0 0 1048576 50 0 0 0 0 0 0\n"
        "    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n"
    )
    monkeypatch.setattr(sysmon, "_HOST_PROC", str(tmp_path))
    monkeypatch.setattr(sysmon, "_prev_net", None)

    m = asyncio.run(sysmon.sample())
    # ファイルは実際に読まれている (NIC の累積が集計に入っている)
    assert m["net_rx_total_str"] == sysmon._fmt_bytes(5242880)
    assert iface not in repr(m)

    monkeypatch.setattr(main.sysmon_cache, "_state", cache.CachedValue(value=m))
    r = client.get("/panel/sysmon")

    assert r.status_code == 200
    assert "total: " in r.text
    assert iface not in r.text
    assert "interfaces" not in r.text
