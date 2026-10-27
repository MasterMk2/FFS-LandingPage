"""表示テーマ (若葉 / 墨) の解決。

解決順は i18n の言語と同じ:
  1. ``?theme=`` query param (middleware が cookie にも保存する)
  2. ``ffs_theme`` cookie
  3. ``wakaba`` (既定)

CSS は data-theme 属性が無いとき若葉になるので、ここを通らない経路でも既定どおりになる。
"""
from __future__ import annotations

THEMES = ("wakaba", "dark")
DEFAULT = "wakaba"
COOKIE_NAME = "ffs_theme"
COOKIE_MAX_AGE = 365 * 24 * 3600


def normalize(raw: str | None) -> str | None:
    if not raw:
        return None
    v = raw.strip().lower()
    return v if v in THEMES else None


def resolve(request) -> str:
    return (
        normalize(request.query_params.get("theme"))
        or normalize(request.cookies.get(COOKIE_NAME))
        or DEFAULT
    )
