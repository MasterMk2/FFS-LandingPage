"""SVG スパークライン生成ヘルパ (postgres 時系列でもメモリ時系列でも共通)。"""
from __future__ import annotations

from dataclasses import dataclass

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
