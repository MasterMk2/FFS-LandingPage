"""部門別リワード (/rewards) の表示用の整形。

上流 (DCSSB の ffs_points) の応答から、表示に使う項目だけを取り出す。点数は公開ボードの
行に含めない (parse_board は points を読まない)。上流の表示名 (labels) は使わず、
部門名と称号名はこのアプリの i18n で出す。
"""
from __future__ import annotations

import calendar
from datetime import datetime

from . import i18n

PERIODS = ("month", "season", "all")
# 総合 + 5 部門。表示順もこの順。
BOARD_DEPTS = ("total", "host", "lead", "coop", "free", "author")
# 本人欄で出す部門 (総合は別カード、飛行時間は free_hours から)。
MEMBER_DEPTS = ("host", "lead", "coop", "free", "author")
BOARD_LIMIT = 10
NAME_MAX = 64

# 部門ごとの称号名 (i18n キー)。階級は全部門 15 段で、3 段ごとに 1 階級。
_TITLES = {
    "host": "pt_title_host",
    "lead": "pt_title_lead",
    "coop": "pt_title_coop",
    "free": "pt_title_free",
    "author": "pt_title_author",
    "hours": "pt_title_hours",
}
RANKS = 15
RANK_CLASSES = 5
# メダルの段位 n は MEDALS[n-1]。CSS のクラス名にも使う。
MEDALS = ("bronze", "silver", "gold", "platinum")
# 段位の単位 (複数形, 単数形) の i18n キー。英語の単数形は n == 1 のときだけ使う。
_UNITS = {
    "host": ("pt_unit_times", "pt_unit_time"),
    "lead": ("pt_unit_times", "pt_unit_time"),
    "coop": ("pt_unit_times", "pt_unit_time"),
    "free": ("pt_unit_days", "pt_unit_day"),
    "author": ("pt_unit_times", "pt_unit_time"),
    "hours": ("pt_unit_hours", "pt_unit_hour"),
}


def _unit(lang: str, key: str, n: object) -> str:
    plural_key, singular_key = _UNITS.get(key, _UNITS["host"])
    if lang == "en" and isinstance(n, (int, float)) and not isinstance(n, bool) and n == 1:
        return i18n.t(lang, singular_key)
    return i18n.t(lang, plural_key)


def _int_or_none(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _rank_name(lang: str, tier: object, stars: object = 0) -> str | None:
    """階級名。0 以下・範囲外・非整数は None (称号なし)。最上位の先は ★ を足す。"""
    if _int_or_none(tier) is None or not 1 <= tier <= RANKS:
        return None
    name = i18n.t(lang, f"pt_rank_name_{tier}")
    return f"{name} ★{stars}" if _int_or_none(stars) and stars > 0 else name


def title(lang: str, key: str, tier: object, stars: object = 0) -> str | None:
    """階級から称号名を作る。称号が無ければ None。"""
    name = _rank_name(lang, tier, stars)
    if key not in _TITLES or name is None:
        return None
    return f"{i18n.t(lang, _TITLES[key])} {name}"


def _medal(lang: str, level: object) -> dict | None:
    """メダル 1 つ分。0・範囲外・非整数は None。"""
    if _int_or_none(level) is None or not 1 <= level <= len(MEDALS):
        return None
    key = MEDALS[level - 1]
    return {"key": key, "label": i18n.t(lang, "pt_medal_" + key)}


def _num(value: object) -> str:
    """時間などの小数を表示用にする (整数は小数点を付けない)。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "-"
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return f"{value:.1f}"
    return str(value)


def parse_board(data: object) -> dict[str, dict[str, list[dict]]] | None:
    """/points/board の応答を {period: {dept: [行]}} にする。形が違えば None。

    行は rank / name / tier だけを持つ。points など他の項目はここで捨てる。
    """
    if not isinstance(data, dict):
        return None
    boards = data.get("boards")
    if not isinstance(boards, dict):
        return None
    out: dict[str, dict[str, list[dict]]] = {}
    for period in PERIODS:
        period_board = boards.get(period)
        if not isinstance(period_board, dict):
            period_board = {}
        out[period] = {}
        for dept in BOARD_DEPTS:
            rows: list[dict] = []
            raw_rows = period_board.get(dept)
            if isinstance(raw_rows, list):
                for raw in raw_rows[:BOARD_LIMIT]:
                    if not isinstance(raw, dict):
                        continue
                    rank = _int_or_none(raw.get("rank"))
                    name = raw.get("name")
                    if rank is None or not isinstance(name, str):
                        continue
                    rows.append(
                        {
                            "rank": rank,
                            "name": name[:NAME_MAX],
                            "tier": _int_or_none(raw.get("tier")),
                            "stars": _int_or_none(raw.get("stars")) or 0,
                            "medal": _int_or_none(raw.get("medal")),
                        }
                    )
            out[period][dept] = rows
    return out


def season_info(data: object) -> dict | None:
    """開催中のシーズン。無いか形が違えば None。"""
    season = data.get("season") if isinstance(data, dict) else None
    if not isinstance(season, dict):
        return None
    season_id, ends = season.get("id"), season.get("ends")
    return {"id": season_id, "ends": ends} if isinstance(season_id, str) and isinstance(ends, str) else None


def _badge(text: str, tier: int) -> dict:
    """称号 1 つ分。ゲージは階級の数で、階級の中の段は称号名で分かる。"""
    return {"text": text, "tier": (tier + 2) // 3, "top": RANK_CLASSES}


def held_titles(board: dict, lang: str) -> dict[str, list[dict]]:
    """パイロット名ごとの称号を部門ボードから集める (段位の高い順)。

    上流の総合ボードは段位を持たないので、ここから補う。段位は累計の実績で決まり期間に
    よらない。部門ボードは上位だけなので、そこに載らない称号は出ない。
    """
    held: dict[str, dict[str, tuple[int, int]]] = {}
    for period in PERIODS:
        for dept in MEMBER_DEPTS:
            for row in board.get(period, {}).get(dept, []):
                if title(lang, dept, row["tier"]) is not None:
                    held.setdefault(row["name"], {})[dept] = (row["tier"], row["stars"])
    return {
        name: [
            _badge(f"{i18n.t(lang, 'pt_dept_' + dept)} {_rank_name(lang, tier, stars)}", tier)
            for dept, (tier, stars) in sorted(depts.items(), key=lambda item: -item[1][0])
        ]
        for name, depts in held.items()
    }


def board_rows(board: dict, period: str, dept: str, lang: str) -> list[dict]:
    """表示用の行 (称号を付ける)。総合は全部門の称号、部門はその部門の称号。"""
    held = held_titles(board, lang) if dept == "total" else {}
    rows = []
    for row in board.get(period, {}).get(dept, []):
        badges = held.get(row["name"], [])
        name = title(lang, dept, row["tier"], row["stars"])
        if name is not None:
            badges = [_badge(name, row["tier"])]
        rows.append({"rank": row["rank"], "name": row["name"], "badges": badges,
                     "medal": _medal(lang, row["medal"])})
    return rows


def month_closing(lang: str, now: datetime) -> str:
    """今月のランキングの残り日数の文言。now は JST の現在時刻。"""
    left = calendar.monthrange(now.year, now.month)[1] - now.day
    if left == 0:
        return i18n.t(lang, "pt_closing_today")
    unit = i18n.t(lang, "pt_unit_day" if left == 1 else "pt_unit_days")
    return i18n.t(lang, "pt_closing_fmt").format(n=left, unit=unit)


def season_closing(lang: str, ends: str, now: datetime) -> str:
    """シーズンの残り日数の文言。ends は最終日 (YYYY-MM-DD)、now は JST の現在時刻。"""
    left = (datetime.fromisoformat(ends).date() - now.date()).days
    if left <= 0:
        return i18n.t(lang, "pt_season_closing_today")
    unit = i18n.t(lang, "pt_unit_day" if left == 1 else "pt_unit_days")
    return i18n.t(lang, "pt_season_closing_fmt").format(n=left, unit=unit)


def _standing(standing: object, period: str, key: str) -> dict:
    if not isinstance(standing, dict):
        return {}
    block = standing.get(period)
    if not isinstance(block, dict):
        return {}
    entry = block.get(key)
    return entry if isinstance(entry, dict) else {}


def _rank_view(standing: object, key: str) -> dict:
    """順位の表示用。rank が None なら未獲得、gap が None かつ 1 位なら首位。"""
    out = {}
    for period in PERIODS:
        entry = _standing(standing, period, key)
        rank = _int_or_none(entry.get("rank"))
        of = _int_or_none(entry.get("of"))
        gap = entry.get("gap")
        gap_value = gap if isinstance(gap, (int, float)) and not isinstance(gap, bool) else None
        out[period] = {"rank": rank, "of": of, "gap": gap_value}
    return out


def _dept_card(lang: str, key: str, dept: dict, standing: object) -> dict:
    """部門 1 枚分。key は MEMBER_DEPTS のいずれか、または "total"。"""
    tier = _int_or_none(dept.get("tier"))
    stars = _int_or_none(dept.get("stars"))
    nxt = _int_or_none(dept.get("next"))
    remaining = _int_or_none(dept.get("remaining"))
    units = _int_or_none(dept.get("units"))
    label_key = "pt_dept_" + key
    return {
        "label": i18n.t(lang, label_key),
        "points_month": _int_or_none(dept.get("points_month")),
        "points_total": _int_or_none(dept.get("points")),
        "units": units,
        "units_unit": _unit(lang, key, units),
        "title": title(lang, key, tier, stars),
        "next_title": title(lang, key, (tier or 0) + 1) if nxt is not None else None,
        "remaining": remaining,
        "unit": _unit(lang, key, remaining),
        "top": nxt is None and (tier or 0) > 0,
        "rank": _rank_view(standing, key),
    }


def _season_card(lang: str, season: object) -> dict | None:
    """本人の今シーズン。開催前は None。"""
    if not isinstance(season, dict) or not isinstance(season.get("id"), str):
        return None
    level = _int_or_none(season.get("medal")) or 0
    following = _medal(lang, level + 1) if _int_or_none(season.get("next")) is not None else None
    return {
        "id": season["id"],
        "points": _int_or_none(season.get("points")),
        "medal": _medal(lang, level),
        "next_medal": following,
        "remaining": _int_or_none(season.get("remaining")),
    }


def _season_history(lang: str, history: object) -> list[dict]:
    """過去のシーズンのメダル (新しい順)。"""
    if not isinstance(history, list):
        return []
    out = []
    for entry in history:
        medal = _medal(lang, entry.get("medal")) if isinstance(entry, dict) else None
        if medal is not None and isinstance(entry.get("season"), str):
            out.append({"season": entry["season"], "medal": medal})
    return out


def member_view(data: object, lang: str) -> dict | None:
    """/points/member/{id} の応答を本人欄の表示用に変える。形が違えば None。"""
    if not isinstance(data, dict):
        return None
    departments = data.get("departments")
    if not isinstance(departments, dict):
        return None
    standing = data.get("standing")
    total = data.get("total") if isinstance(data.get("total"), dict) else {}

    cards = []
    for key in MEMBER_DEPTS:
        dept = departments.get(key)
        if not isinstance(dept, dict):
            continue
        cards.append(_dept_card(lang, key, dept, standing))

    total_rank = _rank_view(standing, "total")
    total_card = {
        "label": i18n.t(lang, "pt_dept_total"),
        "points_month": _int_or_none(total.get("points_month")),
        "points_total": _int_or_none(total.get("points")),
        "rank": total_rank,
    }

    hours = data.get("free_hours") if isinstance(data.get("free_hours"), dict) else {}
    hours_tier = _int_or_none(hours.get("tier"))
    hours_stars = _int_or_none(hours.get("stars"))
    hours_next = hours.get("next")
    hours_card = {
        "label": i18n.t(lang, "pt_dept_hours"),
        "hours": _num(hours.get("hours")),
        "title": title(lang, "hours", hours_tier, hours_stars),
        "next_title": (
            title(lang, "hours", (hours_tier or 0) + 1) if hours_next is not None else None
        ),
        "remaining": _num(hours.get("remaining")) if hours.get("remaining") is not None else None,
        "unit": _unit(lang, "hours", hours.get("remaining")),
        "top": hours_next is None and (hours_tier or 0) > 0,
    }

    name = data.get("name")
    return {
        "name": name[:NAME_MAX] if isinstance(name, str) else "",
        "opted_out": bool(data.get("opted_out")),
        "season": _season_card(lang, data.get("season")),
        "season_history": _season_history(lang, data.get("season_history")),
        "cards": cards,
        "total": total_card,
        "hours": hours_card,
    }
