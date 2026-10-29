"""部門別ポイント (/points) の表示用の整形。

上流 (DCSSB の ffs_points) の応答から、表示に使う項目だけを取り出す。点数は公開ボードの
行に含めない (parse_board は points を読まない)。上流の表示名 (labels) は使わず、
部門名と称号名はこのアプリの i18n で出す。
"""
from __future__ import annotations

from . import i18n

PERIODS = ("month", "all")
# 総合 + 5 部門。表示順もこの順。
BOARD_DEPTS = ("total", "host", "lead", "coop", "free", "author")
# 本人欄で出す部門 (総合は別カード、飛行時間は free_hours から)。
MEMBER_DEPTS = ("host", "lead", "coop", "free", "author")
BOARD_LIMIT = 10
NAME_MAX = 64

# 部門ごとの称号名 (i18n キー) と最大段位。段位 n は ROMAN[n-1]。
_TITLES = {
    "host": ("pt_title_host", 4),
    "lead": ("pt_title_lead", 4),
    "coop": ("pt_title_coop", 5),
    "free": ("pt_title_free", 5),
    "author": ("pt_title_author", 4),
    "hours": ("pt_title_hours", 5),
}
_ROMAN = ("I", "II", "III", "IV", "V")
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


def title(lang: str, key: str, tier: object) -> str | None:
    """段位から称号名を作る。0 以下・範囲外・非整数は None (称号なし)。"""
    if key not in _TITLES or isinstance(tier, bool) or not isinstance(tier, int):
        return None
    i18n_key, top = _TITLES[key]
    if not 1 <= tier <= top:
        return None
    return f"{i18n.t(lang, i18n_key)} {_ROMAN[tier - 1]}"


def _int_or_none(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


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
                        }
                    )
            out[period][dept] = rows
    return out


def board_rows(board: dict, period: str, dept: str, lang: str) -> list[dict]:
    """表示用の行 (称号名を付ける)。"""
    rows = []
    for row in board.get(period, {}).get(dept, []):
        rows.append(
            {
                "rank": row["rank"],
                "name": row["name"],
                # 総合は段位を持たないので称号も出ない (title は未知のキーに None を返す)。
                "title": title(lang, dept, row["tier"]),
            }
        )
    return rows


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
        "title": title(lang, key, tier),
        "next_title": title(lang, key, (tier or 0) + 1) if nxt is not None else None,
        "remaining": remaining,
        "unit": _unit(lang, key, remaining),
        "top": nxt is None and (tier or 0) > 0,
        "rank": _rank_view(standing, key),
    }


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
    hours_next = hours.get("next")
    hours_card = {
        "label": i18n.t(lang, "pt_dept_hours"),
        "hours": _num(hours.get("hours")),
        "title": title(lang, "hours", hours_tier),
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
        "cards": cards,
        "total": total_card,
        "hours": hours_card,
    }
