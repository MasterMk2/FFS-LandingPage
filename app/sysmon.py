"""ホストマシンのリソース計測 (psutil + bind-mount /host/proc)。

docker-compose.yml で `/proc:/host/proc:ro` を bind-mount し、`HOST_PROC` を
`/host/proc` にセットしておく。psutil は `PROCFS_PATH` を参照して CPU / 仮想
メモリ / swap / loadavg / boot_time を **ホスト namespace** の /proc から
読むので、コンテナの制限値ではなくホスト全体の状態が取れる。

時系列はプロセス内の deque リングバッファに保持 (postgres など使わず揮発)。
cache.Fetcher が 15 秒毎に `sample()` を呼ぶので、`_HISTORY_MAX=240` で
最大 60 分ぶんのサンプルを保存。コンテナ再起動で履歴は消えるが live 監視
用途では許容。

ネットワーク I/O とディスク使用量は範囲設計上含めていない:
    - /proc/net は netns 別ファイルなので `/host/proc` 経由でもコンテナ側の
      netdev しか見えない。ホスト net I/O が必要なら `/host/proc/1/net/dev` を
      直読みする必要があり、ここでは割愛。
    - ディスクは statvfs 対象を bind-mount しないと取れず、セキュリティ面
      (`/:/host:ro` でのホスト露出) を避けて skip。
"""
from __future__ import annotations

import os
import time
from collections import deque

import psutil

from .charts import sparkline

_HOST_PROC = os.environ.get("HOST_PROC", "/proc")
if _HOST_PROC != "/proc":
    psutil.PROCFS_PATH = _HOST_PROC

# sample() 間隔 15s × 240 = 60 min のリングバッファ。module-level な単一タスクから
# しか書かれないので lock 不要 (cache.Fetcher は 1 ループに 1 回 sample() を呼ぶ)。
_HISTORY_MAX = 240

_hist_cpu: deque[float] = deque(maxlen=_HISTORY_MAX)
_hist_mem: deque[float] = deque(maxlen=_HISTORY_MAX)
_hist_swap: deque[float] = deque(maxlen=_HISTORY_MAX)
_hist_load1: deque[float] = deque(maxlen=_HISTORY_MAX)


def _fmt_bytes(n: int | float) -> str:
    n = float(n)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} PiB"


def _fmt_uptime(sec: float) -> str:
    s = int(sec)
    d, r = divmod(s, 86400)
    h, r = divmod(r, 3600)
    m, _ = divmod(r, 60)
    if d:
        return f"{d}d {h}h {m}m"
    if h:
        return f"{h}h {m}m"
    return f"{m}m"


async def sample() -> dict:
    """fetcher.Fetcher 用の async 取得関数。

    psutil.cpu_percent(interval=None) は前回コール以降の delta を返す。初回は
    0.0 になるが、fetcher の定期 refresh で 2 回目以降は有効値が入る。
    """
    cpu = psutil.cpu_percent(interval=None)
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    la1, la5, la15 = psutil.getloadavg()
    uptime = time.time() - psutil.boot_time()
    cpu_count = psutil.cpu_count() or 0

    _hist_cpu.append(cpu)
    _hist_mem.append(mem.percent)
    _hist_swap.append(swap.percent)
    _hist_load1.append(la1)
    points = len(_hist_cpu)
    window_minutes = round(points * 15 / 60, 1)

    return {
        "cpu_percent": round(cpu, 1),
        "cpu_count": cpu_count,
        "mem_used_str": _fmt_bytes(mem.used),
        "mem_total_str": _fmt_bytes(mem.total),
        "mem_percent": round(mem.percent, 1),
        "swap_used_str": _fmt_bytes(swap.used),
        "swap_total_str": _fmt_bytes(swap.total),
        "swap_percent": round(swap.percent, 1),
        "load1": round(la1, 2),
        "load5": round(la5, 2),
        "load15": round(la15, 2),
        "load_ratio1": round(la1 / cpu_count, 2) if cpu_count else 0.0,
        "uptime_str": _fmt_uptime(uptime),
        "cpu_spark": sparkline(list(_hist_cpu)),
        "mem_spark": sparkline(list(_hist_mem)),
        "swap_spark": sparkline(list(_hist_swap)),
        "load_spark": sparkline(list(_hist_load1)),
        "history_points": points,
        "history_minutes": window_minutes,
    }
