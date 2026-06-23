"""SVG スパークライン生成ヘルパ (postgres 時系列でもメモリ時系列でも共通)。"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime as _dt, timedelta as _td

SPARK_WIDTH = 180
SPARK_HEIGHT = 36


@dataclass
class Spark:
    path: str = ""
    area: str = ""
    vmin: float = 0.0
    vmax: float = 0.0
    n: int = 0


def _build_spark(values: list[float], vmin: float, vmax: float) -> Spark:
    if not values:
        return Spark()
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


def sparkline(values: list[float]) -> Spark:
    if not values:
        return Spark()
    return _build_spark(values, min(values), max(values))


HR_CHART_W = 720
HR_CHART_H = 80
_HR_DISPLAY_MIN = 40
_HR_DISPLAY_MAX = 170


@dataclass
class HrChart:
    hr_path: str = ""
    sleep_rects: list = field(default_factory=list)  # [{x, w}]
    day_markers: list = field(default_factory=list)  # [{x, label}]
    vmin: float = 0.0
    vmax: float = 0.0
    points: int = 0


def build_hr_chart(
    hr_points: list,       # [(datetime, float)] — ダウンサンプル済み
    sleep_periods: list,   # [(datetime, datetime)]
    window_start: _dt,
    window_end: _dt,
) -> HrChart:
    """任意ウィンドウの HR + 睡眠帯を SVG パスデータに変換する
    (7 日 / 直近 24h など window_start〜window_end で汎用化)。"""
    total_secs = (window_end - window_start).total_seconds()
    if total_secs <= 0 or not hr_points:
        return HrChart()

    def ts_x(dt: _dt) -> float:
        return (dt - window_start).total_seconds() / total_secs * HR_CHART_W

    def hr_y(v: float) -> float:
        v = max(_HR_DISPLAY_MIN, min(_HR_DISPLAY_MAX, v))
        return HR_CHART_H - (v - _HR_DISPLAY_MIN) / (_HR_DISPLAY_MAX - _HR_DISPLAY_MIN) * HR_CHART_H

    # ウィンドウ内データを時刻順で SVG パスに変換 (ギャップ > 15 分は M でリセット)
    filtered = [(dt, v) for dt, v in hr_points if window_start <= dt <= window_end]
    if not filtered:
        return HrChart()

    path_parts: list[str] = []
    prev_dt: _dt | None = None
    for dt, v in filtered:
        x, y = ts_x(dt), hr_y(v)
        if prev_dt is None or (dt - prev_dt) > _td(minutes=15):
            path_parts.append(f"M {x:.1f} {y:.1f}")
        else:
            path_parts.append(f"L {x:.1f} {y:.1f}")
        prev_dt = dt

    # 睡眠帯 (ウィンドウ端でクリップ)
    sleep_rects = []
    for s, e in sleep_periods:
        x1 = max(0.0, ts_x(s))
        x2 = min(float(HR_CHART_W), ts_x(e))
        if x2 > x1:
            sleep_rects.append({"x": round(x1, 1), "w": round(x2 - x1, 1)})

    # 日付区切り線
    day_markers = []
    d_cursor = window_start.date() + _td(days=1)
    tz = window_start.tzinfo
    while True:
        dt_mid = _dt(d_cursor.year, d_cursor.month, d_cursor.day, tzinfo=tz)
        if dt_mid > window_end:
            break
        if dt_mid > window_start:
            day_markers.append({"x": round(ts_x(dt_mid), 1), "label": d_cursor.strftime("%m/%d")})
        d_cursor += _td(days=1)

    values = [v for dt, v in filtered]
    return HrChart(
        hr_path=" ".join(path_parts),
        sleep_rects=sleep_rects,
        day_markers=day_markers,
        vmin=min(values),
        vmax=max(values),
        points=len(filtered),
    )


def sparkline_pair(a: list[float], b: list[float]) -> tuple[Spark, Spark]:
    """RX/TX のように 2 系列を同一 y スケールで比較可能にする。

    それぞれ `sparkline()` すると各系列の max で個別正規化され、RX >> TX の
    ようなケースで小さい側が過大表示される。両系列を合算した vmin/vmax で
    共通正規化し、相対的な大きさを維持する。
    """
    combined = (a or []) + (b or [])
    if not combined:
        return Spark(), Spark()
    vmin, vmax = min(combined), max(combined)
    return _build_spark(a, vmin, vmax), _build_spark(b, vmin, vmax)
