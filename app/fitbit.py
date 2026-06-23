"""Google Health API — Charge 6 の心拍 7 日分 + 睡眠ログを取得。
HR は 7 日スケールと直近 24h スケールの 2 チャートを生成する。

認証フロー:
    - Client ID / Secret は Google Cloud Console の OAuth 2.0 クライアント
    - Token 更新: oauth2.googleapis.com/token (body パラメータ、Basic 認証不要)
    - API: health.googleapis.com/v4/

fitbit_auth.py を実行して refresh_token を取得してから使う。

環境変数:
    FITBIT_CLIENT_ID      — Google Cloud Console の OAuth クライアント ID
    FITBIT_CLIENT_SECRET  — Google Cloud Console の OAuth クライアント シークレット
    FITBIT_REFRESH_TOKEN  — 初回認証で取得した refresh_token (seed 用)
    FITBIT_TOKEN_FILE     — token 保存先 (デフォルト: /data/fitbit_tokens.json)
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

from .charts import HrChart, build_hr_chart

log = logging.getLogger(__name__)

_JST = ZoneInfo("Asia/Tokyo")
_TOKEN_URL = "https://oauth2.googleapis.com/token"
_API_BASE = "https://health.googleapis.com"

CLIENT_ID: str = os.environ.get("FITBIT_CLIENT_ID", "")
CLIENT_SECRET: str = os.environ.get("FITBIT_CLIENT_SECRET", "")
_TOKEN_FILE = Path(os.environ.get("FITBIT_TOKEN_FILE", "/data/fitbit_tokens.json"))

_access_token: str = ""
_refresh_token: str = os.environ.get("FITBIT_REFRESH_TOKEN", "")


def _load_tokens() -> None:
    global _access_token, _refresh_token
    if not _TOKEN_FILE.exists():
        return
    try:
        data = json.loads(_TOKEN_FILE.read_text())
        _access_token = data.get("access_token", "")
        if data.get("refresh_token"):
            _refresh_token = data["refresh_token"]
    except Exception as e:
        log.warning("fitbit: token file read error: %s", e)


def _save_tokens(access: str, refresh: str) -> None:
    global _access_token, _refresh_token
    _access_token = access
    _refresh_token = refresh
    try:
        _TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        _TOKEN_FILE.write_text(
            json.dumps({"access_token": access, "refresh_token": refresh})
        )
    except Exception as e:
        log.warning("fitbit: token file write error: %s", e)


async def _do_refresh() -> None:
    """Google OAuth token エンドポイントで refresh する。"""
    async with httpx.AsyncClient() as client:
        r = await client.post(
            _TOKEN_URL,
            data={
                "grant_type": "refresh_token",
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_SECRET,
                "refresh_token": _refresh_token,
            },
            timeout=10.0,
        )
        r.raise_for_status()
        d = r.json()
    _save_tokens(d["access_token"], d.get("refresh_token", _refresh_token))
    log.info("fitbit: access token refreshed")


async def _api_get(path: str, params: dict | None = None) -> dict:
    global _access_token
    if not _access_token:
        _load_tokens()
    if not _access_token:
        await _do_refresh()

    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{_API_BASE}{path}",
            params=params,
            headers={"Authorization": f"Bearer {_access_token}"},
            timeout=15.0,
        )
        if r.status_code == 401:
            await _do_refresh()
            r = await client.get(
                f"{_API_BASE}{path}",
                params=params,
                headers={"Authorization": f"Bearer {_access_token}"},
                timeout=15.0,
            )
        r.raise_for_status()
        return r.json()


def _parse_physical_time(ts: str) -> datetime | None:
    """RFC 3339 UTC タイムスタンプを JST の datetime に変換。"""
    try:
        # "2024-01-01T12:00:00Z" or "2024-01-01T12:00:00.000Z"
        ts = ts.rstrip("Z").split(".")[0]
        dt = datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)
        return dt.astimezone(_JST)
    except (ValueError, AttributeError):
        return None


async def _fetch_hr(window_start: datetime, window_end: datetime) -> list[tuple[datetime, float]]:
    """指定ウィンドウの心拍データを取得。ページネーション対応。"""
    # physical_time (UTC RFC3339) フィルタ
    start_utc = window_start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    end_utc = window_end.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    filter_str = (
        f'heart_rate.sample_time.physical_time >= "{start_utc}" AND '
        f'heart_rate.sample_time.physical_time < "{end_utc}"'
    )

    result: list[tuple[datetime, float]] = []
    page_token: str | None = None

    for _ in range(20):  # 最大 20 ページ
        params: dict = {"filter": filter_str, "pageSize": 10000}
        if page_token:
            params["pageToken"] = page_token
        try:
            data = await _api_get("/v4/users/me/dataTypes/heart-rate/dataPoints", params)
        except Exception as e:
            log.warning("fitbit: HR fetch failed: %s", e)
            break

        for pt in data.get("dataPoints") or []:
            hr = pt.get("heartRate") or {}
            bpm_raw = hr.get("beatsPerMinute")
            sample_time = hr.get("sampleTime") or {}
            ts_str = sample_time.get("physicalTime") or ""
            if not bpm_raw or not ts_str:
                continue
            dt = _parse_physical_time(ts_str)
            if dt and window_start <= dt <= window_end:
                try:
                    result.append((dt, float(bpm_raw)))
                except (ValueError, TypeError):
                    pass

        page_token = data.get("nextPageToken")
        if not page_token:
            break

    log.info("fitbit: fetched %d HR points", len(result))
    return result


async def _fetch_sleep(window_start: datetime, window_end: datetime) -> list[dict]:
    """指定ウィンドウの睡眠セッションを取得。sleep はフィルタ非対応のため全取得して
    クライアント側でフィルタ。

    各セッションは dict で返す:
      start / end       : 就床〜起床 (time in bed の区間 = HR チャートの睡眠帯用)
      in_bed_min        : 就床時間 (summary.minutesInSleepPeriod)
      asleep_min        : 実睡眠 (summary.minutesAsleep = 覚醒を除いた実際の睡眠)
      deep/light/rem/awake : ステージ別分数 (stagesSummary、CLASSIC 記録では 0)

    Charge 6 は STAGES (深い/浅い/REM/覚醒) と CLASSIC (覚醒判定のみ) の 2 種を返す。
    実睡眠 (asleep_min) は就床時間より短く、覚醒帯を除いた値。
    """
    sessions: list[dict] = []
    page_token: str | None = None
    cutoff = window_start - timedelta(days=1)

    for _ in range(10):
        params: dict = {"pageSize": 50}
        if page_token:
            params["pageToken"] = page_token
        try:
            data = await _api_get("/v4/users/me/dataTypes/sleep/dataPoints", params)
        except Exception as e:
            log.warning("fitbit: sleep fetch failed: %s", e)
            break

        for pt in data.get("dataPoints") or []:
            sleep = pt.get("sleep") or {}
            interval = sleep.get("interval") or {}
            start_ts = interval.get("startTime") or ""
            end_ts = interval.get("endTime") or ""
            if not start_ts or not end_ts:
                continue
            s_dt = _parse_physical_time(start_ts)
            e_dt = _parse_physical_time(end_ts)
            if not (s_dt and e_dt and e_dt >= cutoff):
                continue

            summary = sleep.get("summary") or {}

            def _imin(key: str) -> int:
                try:
                    return int(summary.get(key) or 0)
                except (ValueError, TypeError):
                    return 0

            stages: dict[str, int] = {}
            for st in summary.get("stagesSummary") or []:
                t = (st.get("type") or "").upper()
                try:
                    stages[t] = stages.get(t, 0) + int(st.get("minutes") or 0)
                except (ValueError, TypeError):
                    pass

            in_bed = _imin("minutesInSleepPeriod") or int((e_dt - s_dt).total_seconds() / 60)
            asleep = _imin("minutesAsleep")
            if asleep <= 0:  # CLASSIC 等で minutesAsleep が無い場合のフォールバック
                asleep = stages.get("ASLEEP", 0) or in_bed

            sessions.append({
                "start": s_dt,
                "end": e_dt,
                "in_bed_min": in_bed,
                "asleep_min": asleep,
                "deep": stages.get("DEEP", 0),
                "light": stages.get("LIGHT", 0),
                "rem": stages.get("REM", 0),
                "awake": stages.get("AWAKE", 0),
            })

        page_token = data.get("nextPageToken")
        if not page_token:
            break

    log.info("fitbit: fetched %d sleep sessions", len(sessions))
    return sessions


def _downsample(
    points: list[tuple[datetime, float]], min_interval_sec: float
) -> list[tuple[datetime, float]]:
    """時刻昇順の (dt, value) を最小間隔でダウンサンプルする。"""
    out: list[tuple[datetime, float]] = []
    last_ts: datetime | None = None
    for ts, v in points:
        if last_ts is None or (ts - last_ts).total_seconds() >= min_interval_sec:
            out.append((ts, v))
            last_ts = ts
    return out


async def _fetch_hr_sampled_chunked(
    start: datetime,
    end: datetime,
    chunk: timedelta,
    min_interval_sec: float,
) -> list[tuple[datetime, float]]:
    """[start, end) を chunk 毎に分割して HR を取得し、各 chunk を即ダウンサンプルして
    連結する。

    Google Health API は 1 クエリあたり約 100k dataPoint で結果を打ち切るため、
    Charge 6 の高密度 HR (約 25 点/分 → 1 日 ~36k 点) を 7 日分まとめて 1 クエリで
    取ると古い側が約 3 日で切れる。日単位で分割すれば各クエリが cap 未満に収まり、
    全期間の履歴が取得できる。chunk 毎に downsample するのでメモリも増えない。"""
    out: list[tuple[datetime, float]] = []
    cur = start
    while cur < end:
        nxt = min(cur + chunk, end)
        pts = await _fetch_hr(cur, nxt)
        pts.sort(key=lambda x: x[0])
        out.extend(_downsample(pts, min_interval_sec))
        cur = nxt
    return out


def _auth_error() -> dict | None:
    if not CLIENT_ID or not CLIENT_SECRET:
        return {"error": "FITBIT_CLIENT_ID / FITBIT_CLIENT_SECRET が未設定"}
    if not _refresh_token:
        _load_tokens()
    if not _refresh_token:
        return {
            "error": (
                "Google Health API 未認証 — fitbit_auth.py を実行して"
                " FITBIT_REFRESH_TOKEN を .env に設定してください"
            )
        }
    return None


async def get_fitbit_data() -> dict:
    """直近 24h の心拍 + 現在値 + 睡眠ステータスを取得。cache.Fetcher が 60 秒毎に呼ぶ
    (軽量: 単一クエリ ~26h)。7 日チャートは get_fitbit_7d() が別途担当。"""
    err = _auth_error()
    if err:
        return err

    now = datetime.now(_JST)
    window_end = now
    window_start_24h = now - timedelta(hours=24)

    # 24h チャート用に直近 26h を取得 (cap 未満)。2 分毎にダウンサンプル (~720 点)。
    hr_recent = await _fetch_hr(now - timedelta(hours=26), window_end)
    hr_recent.sort(key=lambda x: x[0])
    hr_24h = [(ts, v) for ts, v in hr_recent if ts >= window_start_24h]
    sampled_24h = _downsample(hr_24h, 2 * 60)

    # 睡眠は直近 2 日分だけ (ステータス + 24h バンド + サマリ用)
    sleep_recent = await _fetch_sleep(now - timedelta(days=2), window_end)
    sleep_24h = [
        r for r in sleep_recent
        if r["end"] >= window_start_24h and r["start"] <= window_end
    ]
    sleep_24h_bands = [(r["start"], r["end"]) for r in sleep_24h]

    # 現在の心拍 (直近 30 分以内)
    current_hr: int | None = None
    if hr_recent:
        last_dt, last_v = hr_recent[-1][0], hr_recent[-1][1]
        if (now - last_dt).total_seconds() < 30 * 60:
            current_hr = int(last_v)

    # 睡眠ステータス
    sleep_status = "awake"
    for s_start, s_end in sleep_24h_bands:
        if s_start <= now <= s_end:
            sleep_status = "sleeping"
            break
    if sleep_status == "awake" and sleep_24h_bands:
        latest_end = max(e for _, e in sleep_24h_bands)
        if (now - latest_end).total_seconds() < 2 * 3600:
            sleep_status = "recent"

    chart_24h = build_hr_chart(
        sampled_24h, sleep_24h_bands, window_start_24h, window_end, gap_minutes=15
    )

    # 直近 24h の睡眠サマリ (実睡眠 + 就床 + ステージ内訳)
    sleep_summary = []
    for r in sorted(sleep_24h, key=lambda x: x["start"]):
        a, b = r["asleep_min"], r["in_bed_min"]
        sleep_summary.append({
            "start": r["start"].strftime("%m/%d %H:%M"),
            "end": r["end"].strftime("%m/%d %H:%M"),
            "asleep": f"{a // 60}h {a % 60:02d}m",
            "in_bed": f"{b // 60}h {b % 60:02d}m",
            "deep": r["deep"], "rem": r["rem"], "light": r["light"], "awake": r["awake"],
        })

    return {
        "error": None,
        "current_hr": current_hr,
        "sleep_status": sleep_status,
        "sleep_summary": sleep_summary,
        "chart_24h": chart_24h,
        "win24h_start": window_start_24h.strftime("%m/%d %H:%M"),
        "window_end": window_end.strftime("%m/%d %H:%M"),
    }


async def get_fitbit_7d() -> dict:
    """7 日スケールの HR チャート + 7 日睡眠バーチャートを生成。
    日単位の分割フェッチで API の 100k cap を回避する。履歴はほぼ変化しないので
    cache.Fetcher が 10 分毎に呼べば十分 (負荷・quota 配慮)。"""
    err = _auth_error()
    if err:
        return err

    now = datetime.now(_JST)
    window_end = now
    window_start_7d = now - timedelta(days=7)

    # 7 日分を日別チャンクで取得 → 15 分毎ダウンサンプルで連結 (~672 点)。
    sampled_7d = await _fetch_hr_sampled_chunked(
        window_start_7d, window_end, timedelta(days=1), 15 * 60
    )

    sleep_all = await _fetch_sleep(window_start_7d, window_end)
    sleep_7d_bands = [
        (r["start"], r["end"]) for r in sleep_all
        if r["end"] >= window_start_7d and r["start"] <= window_end
    ]

    # 7 日バーチャート用: 日毎の合計「実睡眠」時間 (起床日付 = end の JST 日付)。
    # 就床時間 (in_bed) ではなく覚醒を除いた asleep を集計する。ステージ内訳も合算。
    sleep_7day: list[dict] = []
    today = now.date()
    for i in range(7):
        day = today - timedelta(days=6 - i)
        asleep = in_bed = deep = light = rem = 0
        for r in sleep_all:
            if r["end"].astimezone(_JST).date() == day:
                asleep += r["asleep_min"]
                in_bed += r["in_bed_min"]
                deep += r["deep"]
                light += r["light"]
                rem += r["rem"]
        tip = f"実睡眠 {asleep // 60}h{asleep % 60:02d}m / 就床 {in_bed // 60}h{in_bed % 60:02d}m"
        if deep or rem or light:
            tip += f" · 深い{deep}m REM{rem}m 浅い{light}m"
        sleep_7day.append({
            "label": f"{day.month}/{day.day}",
            "minutes": asleep,  # バー高さ = 実睡眠
            "hours_str": f"{asleep // 60}h {asleep % 60:02d}m" if asleep else "",
            "in_bed_str": f"{in_bed // 60}h {in_bed % 60:02d}m" if in_bed else "",
            "tip": tip,
            "is_today": day == today,
        })

    chart_7d = build_hr_chart(
        sampled_7d, sleep_7d_bands, window_start_7d, window_end, gap_minutes=45
    )

    return {
        "error": None,
        "chart_7d": chart_7d,
        "sleep_7day": sleep_7day,
        "win7d_start": window_start_7d.strftime("%m/%d %H:%M"),
        "window_end": window_end.strftime("%m/%d %H:%M"),
    }
