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


def sparkline(values: list[float]) -> Spark:
    if not values:
        return Spark()
    vmin, vmax = min(values), max(values)
    # 全サンプルが同値のときは視覚的に中央水平線になるよう ±0.5 のマージン。
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
