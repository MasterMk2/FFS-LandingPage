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


async def _fetch_sleep(window_start: datetime, window_end: datetime) -> list[tuple[datetime, datetime]]:
    """指定ウィンドウの睡眠データを取得。sleep はフィルタ非対応のため全取得してクライアント側でフィルタ。"""
    periods: list[tuple[datetime, datetime]] = []
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
            if s_dt and e_dt and e_dt >= cutoff:
                periods.append((s_dt, e_dt))

        page_token = data.get("nextPageToken")
        if not page_token:
            break

    log.info("fitbit: fetched %d sleep periods", len(periods))
    return periods


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


async def get_fitbit_data() -> dict:
    """7 日分の心拍 + 睡眠ログを取得し、7 日スケールと直近 24h スケールの 2 つの
    HR チャートを生成する。cache.Fetcher が 60 秒毎に呼ぶ。"""
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

    now = datetime.now(_JST)
    window_end = now
    window_start_7d = now - timedelta(days=7)
    window_start_24h = now - timedelta(hours=24)

    # 7 日分を 1 回で取得し、両チャートで使い回す。
    hr_all = await _fetch_hr(window_start_7d, window_end)
    hr_all.sort(key=lambda x: x[0])

    # 7 日チャート: 点が多すぎるので 15 分毎にダウンサンプル (~672 点)。
    sampled_7d = _downsample(hr_all, 15 * 60)
    # 24h チャート: 直近 24h のみに絞って 2 分毎にダウンサンプル (~720 点)。
    hr_24h = [(ts, v) for ts, v in hr_all if ts >= window_start_24h]
    sampled_24h = _downsample(hr_24h, 2 * 60)

    # 7 日分の睡眠を取得 (HR チャートの睡眠バンドと 7 日バーチャート共用)
    sleep_all = await _fetch_sleep(window_start_7d, window_end)
    sleep_7d_bands = [
        (s, e) for s, e in sleep_all
        if e >= window_start_7d and s <= window_end
    ]
    sleep_24h_bands = [
        (s, e) for s, e in sleep_all
        if e >= window_start_24h and s <= window_end
    ]
    # 睡眠ステータス判定は直近 (24h バンド) を使う。
    sleep_in_window = sleep_24h_bands

    # 7 日バーチャート用: 日毎の合計睡眠時間 (起床日付 = end の JST 日付)
    sleep_7day: list[dict] = []
    today = now.date()
    for i in range(7):
        day = today - timedelta(days=6 - i)
        total_min = 0
        for s_start, s_end in sleep_all:
            if s_end.astimezone(_JST).date() == day:
                total_min += int((s_end - s_start).total_seconds() / 60)
        sleep_7day.append({
            "label": f"{day.month}/{day.day}",
            "minutes": total_min,
            "hours_str": f"{total_min // 60}h {total_min % 60:02d}m" if total_min else "",
            "is_today": day == today,
        })

    # 現在の心拍 (直近 30 分以内)
    current_hr: int | None = None
    if hr_all:
        last_dt, last_v = hr_all[-1][0], hr_all[-1][1]
        if (now - last_dt).total_seconds() < 30 * 60:
            current_hr = int(last_v)

    # 睡眠ステータス
    sleep_status = "awake"
    for s_start, s_end in sleep_in_window:
        if s_start <= now <= s_end:
            sleep_status = "sleeping"
            break
    if sleep_status == "awake" and sleep_in_window:
        latest_end = max(e for _, e in sleep_in_window)
        if (now - latest_end).total_seconds() < 2 * 3600:
            sleep_status = "recent"

    chart_7d = build_hr_chart(sampled_7d, sleep_7d_bands, window_start_7d, window_end)
    chart_24h = build_hr_chart(sampled_24h, sleep_24h_bands, window_start_24h, window_end)

    # 直近 24h の睡眠サマリ (バンド表示と整合)
    sleep_summary = []
    for s, e in sorted(sleep_24h_bands, key=lambda x: x[0]):
        dur_min = int((e - s).total_seconds() / 60)
        sleep_summary.append({
            "start": s.strftime("%m/%d %H:%M"),
            "end": e.strftime("%m/%d %H:%M"),
            "duration": f"{dur_min // 60}h {dur_min % 60:02d}m",
        })

    return {
        "error": None,
        "current_hr": current_hr,
        "sleep_status": sleep_status,
        "sleep_summary": sleep_summary,
        "sleep_7day": sleep_7day,
        "chart_7d": chart_7d,
        "chart_24h": chart_24h,
        "win7d_start": window_start_7d.strftime("%m/%d %H:%M"),
        "win24h_start": window_start_24h.strftime("%m/%d %H:%M"),
        "window_end": window_end.strftime("%m/%d %H:%M"),
    }
