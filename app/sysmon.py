"""ホストマシンのリソース計測 (psutil + bind-mount /host/proc)。

docker-compose.yml で `/proc:/host/proc:ro` を bind-mount し、`HOST_PROC` を
`/host/proc` にセットしておく。psutil は `PROCFS_PATH` を参照して CPU / 仮想
メモリ / swap / loadavg / boot_time を **ホスト namespace** の /proc から
読むので、コンテナの制限値ではなくホスト全体の状態が取れる。

時系列はプロセス内の deque リングバッファに保持 (postgres など使わず揮発)。
cache.Fetcher が 15 秒毎に `sample()` を呼ぶので、`_HISTORY_MAX=240` で
最大 60 分ぶんのサンプルを保存。コンテナ再起動で履歴は消えるが live 監視
用途では許容。

ネットワーク I/O は `/host/proc/1/net/dev` (PID 1 = init = ホスト netns) を
直読みして物理 NIC の rx/tx bytes を前回サンプルとの delta で rate 化する。
仮想インタフェース (lo / docker* / veth* / br-* 等) はホスト物理トラフィック
では無いので `_NET_EXCLUDE_PREFIXES` で除外。

ディスク使用量は statvfs 対象を bind-mount しないと取れず、セキュリティ面
(`/:/host:ro` でのホスト露出) を避けて skip。
"""
from __future__ import annotations

import os
import time
from collections import deque

import psutil

from .charts import sparkline, sparkline_pair

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
_hist_net_rx: deque[float] = deque(maxlen=_HISTORY_MAX)  # bytes/sec
_hist_net_tx: deque[float] = deque(maxlen=_HISTORY_MAX)  # bytes/sec

# rate 計算用。前回サンプル時刻 + 累積バイト。初回は rate=0 になる。
_prev_net: dict | None = None

# 仮想 / 内部 NIC を弾くプレフィックス。Docker / KVM / k8s 系の名前を広めに列挙。
_NET_EXCLUDE_PREFIXES = (
    "lo", "docker", "br-", "veth", "vnet", "tap", "tun", "virbr",
    "cali", "flannel", "cni", "kube", "weave",
)


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


def _fmt_rate(bytes_per_sec: float) -> str:
    """bytes/sec を 'X.X MiB/s' 表記へ (ビット換算はしない、IEC 2 進接頭辞)。"""
    return f"{_fmt_bytes(bytes_per_sec)}/s"


def _read_host_net_totals() -> tuple[int, int, list[str]]:
    """/host/proc/1/net/dev を parse し、物理 NIC の累積 (rx_bytes, tx_bytes) を合算。

    Returns:
        (rx_total, tx_total, counted_ifaces)
    """
    path = os.path.join(_HOST_PROC, "1", "net", "dev")
    rx_total, tx_total = 0, 0
    counted: list[str] = []
    try:
        with open(path, "r") as f:
            lines = f.readlines()
    except OSError:
        return 0, 0, []
    for line in lines[2:]:  # ヘッダ 2 行を skip
        if ":" not in line:
            continue
        iface, rest = line.split(":", 1)
        iface = iface.strip()
        if iface.startswith(_NET_EXCLUDE_PREFIXES):
            continue
        fields = rest.split()
        if len(fields) < 9:
            continue
        # /proc/net/dev は rx: [bytes packets errs drop fifo frame compressed multicast]
        # tx: [bytes packets errs drop fifo colls carrier compressed] の 8+8=16 fields。
        try:
            rx_bytes = int(fields[0])
            tx_bytes = int(fields[8])
        except (ValueError, IndexError):
            continue
        rx_total += rx_bytes
        tx_total += tx_bytes
        counted.append(iface)
    return rx_total, tx_total, counted


async def sample() -> dict:
    """fetcher.Fetcher 用の async 取得関数。

    psutil.cpu_percent(interval=None) は前回コール以降の delta を返す。初回は
    0.0 になるが、fetcher の定期 refresh で 2 回目以降は有効値が入る。
    """
    global _prev_net

    cpu = psutil.cpu_percent(interval=None)
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    la1, la5, la15 = psutil.getloadavg()
    uptime = time.time() - psutil.boot_time()
    cpu_count = psutil.cpu_count() or 0

    now = time.time()
    rx_total, tx_total, net_ifaces = _read_host_net_totals()
    if _prev_net is not None:
        dt = max(now - _prev_net["t"], 0.001)
        # counter wrap / iface set 変化で負になりうるので clamp。
        rx_rate = max(rx_total - _prev_net["rx"], 0) / dt
        tx_rate = max(tx_total - _prev_net["tx"], 0) / dt
    else:
        rx_rate = 0.0
        tx_rate = 0.0
    _prev_net = {"t": now, "rx": rx_total, "tx": tx_total}

    _hist_cpu.append(cpu)
    _hist_mem.append(mem.percent)
    _hist_swap.append(swap.percent)
    _hist_load1.append(la1)
    _hist_net_rx.append(rx_rate)
    _hist_net_tx.append(tx_rate)
    points = len(_hist_cpu)
    window_minutes = round(points * 15 / 60, 1)

    net_rx_spark, net_tx_spark = sparkline_pair(
        list(_hist_net_rx), list(_hist_net_tx)
    )

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
        "net_rx_rate_str": _fmt_rate(rx_rate),
        "net_tx_rate_str": _fmt_rate(tx_rate),
        "net_rx_total_str": _fmt_bytes(rx_total),
        "net_tx_total_str": _fmt_bytes(tx_total),
        "net_ifaces": ", ".join(net_ifaces) if net_ifaces else "-",
        "cpu_spark": sparkline(list(_hist_cpu)),
        "mem_spark": sparkline(list(_hist_mem)),
        "swap_spark": sparkline(list(_hist_swap)),
        "load_spark": sparkline(list(_hist_load1)),
        "net_rx_spark": net_rx_spark,
        "net_tx_spark": net_tx_spark,
        "history_points": points,
        "history_minutes": window_minutes,
    }
