"""DCSServerBot postgres read-only client (serverstats テーブル)。

直近 HISTORY_MINUTES 分のサンプルを server 別に取得し、最新値 + FPS/Memory の
SVG スパークライン用パスを返す。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime

import psycopg
from psycopg.rows import dict_row

DCSSB_DB_URL = os.getenv("DCSSB_DB_URL", "")

# 時系列ウィンドウ。DCSSB Monitoring は約 1 分毎に 1 行書く。
HISTORY_MINUTES = 60

HISTORY_SQL = f"""
SELECT server_name, time, fps, cpu, mem_ram, users, status
  FROM serverstats
 WHERE time > NOW() - INTERVAL '{HISTORY_MINUTES} minutes'
 ORDER BY server_name, time ASC
"""

SPARK_WIDTH = 180
SPARK_HEIGHT = 36


@dataclass
class Spark:
    path: str = ""
    area: str = ""
    vmin: float = 0.0
    vmax: float = 0.0
    n: int = 0


@dataclass
class ServerSeries:
    name: str
    status: str
    latest_time: datetime
    latest_fps: float
    latest_cpu: float
    latest_mem_gb: float
    latest_users: int
    fps_spark: Spark = field(default_factory=Spark)
    mem_spark: Spark = field(default_factory=Spark)


@dataclass
class LoadResult:
    ok: bool
    series: list[ServerSeries] | None = None
    error: str | None = None


def _sparkline(values: list[float]) -> Spark:
    if not values:
        return Spark()
    vmin, vmax = min(values), max(values)
    # 全サンプルが同値のときは視覚的に中央水平線になるよう ±1 のマージン。
    if vmax == vmin:
        vmin -= 0.5
        vmax += 0.5
    n = len(values)
    step = SPARK_WIDTH / max(n - 1, 1)
    coords: list[tuple[float, float]] = []
    for i, v in enumerate(values):
        x = i * step
        y = SPARK_HEIGHT - (v - vmin) / (vmax - vmin) * SPARK_HEIGHT
        coords.append((x, y))
    if len(coords) == 1:
        x, y = coords[0]
        path = f"M {x:.1f} {y:.1f} L {x + 0.1:.1f} {y:.1f}"
    else:
        path = "M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in coords)
    area = (
        f"{path} "
        f"L {coords[-1][0]:.1f} {SPARK_HEIGHT} "
        f"L {coords[0][0]:.1f} {SPARK_HEIGHT} Z"
    )
    return Spark(path=path, area=area, vmin=vmin, vmax=vmax, n=n)


async def get_server_load_series() -> LoadResult:
    if not DCSSB_DB_URL:
        return LoadResult(ok=False, error="DCSSB_DB_URL not configured")
    try:
        async with await psycopg.AsyncConnection.connect(
            DCSSB_DB_URL, connect_timeout=3
        ) as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(HISTORY_SQL)
                rows = await cur.fetchall()
    except psycopg.Error as e:
        return LoadResult(ok=False, error=f"{type(e).__name__}: {e}")

    by_server: dict[str, list[dict]] = {}
    for r in rows:
        by_server.setdefault(r["server_name"], []).append(r)

    series_list: list[ServerSeries] = []
    for name in sorted(by_server):
        samples = by_server[name]
        if not samples:
            continue
        latest = samples[-1]
        fps_values = [float(s["fps"]) for s in samples]
        mem_gb_values = [float(s["mem_ram"]) / (1024**3) for s in samples]
        series_list.append(
            ServerSeries(
                name=name,
                status=latest["status"],
                latest_time=latest["time"],
                latest_fps=float(latest["fps"]),
                latest_cpu=float(latest["cpu"]),
                latest_mem_gb=float(latest["mem_ram"]) / (1024**3),
                latest_users=latest["users"],
                fps_spark=_sparkline(fps_values),
                mem_spark=_sparkline(mem_gb_values),
            )
        )
    return LoadResult(ok=True, series=series_list)
