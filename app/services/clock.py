"""可注入时钟。

系统内部统一使用**无时区的 UTC 时间**（与 SQLite DATETIME 存储一致，
避免 naive/aware 比较错误）。默认走系统 UTC；测试可通过 ``set_fixed``
固定/推进时间，保证超时场景（含“迟到确认不能夺取责任”）可确定性验证。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Callable


def _utc_naive(dt: datetime | None = None) -> datetime:
    if dt is None:
        dt = datetime.now(timezone.utc)
    elif dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc)
    return dt.replace(tzinfo=None, microsecond=0)


_fixed: datetime | None = None
_offset = timedelta(0)
_source: Callable[[], datetime] | None = None


def now() -> datetime:
    """当前 UTC 时间（naive，秒精度）。"""
    if _source is not None:
        value = _source()
        return value.replace(tzinfo=None, microsecond=0)
    if _fixed is not None:
        return _fixed + _offset
    return _utc_naive()


def set_fixed(dt: datetime) -> None:
    """固定到某一时刻（带时区入参转为 UTC 后剥离 tzinfo）。"""
    global _fixed, _offset, _source
    _source = None
    _fixed = _utc_naive(dt)
    _offset = timedelta(0)


def advance(seconds: float) -> datetime:
    """在固定时钟上推进时间。"""
    global _offset
    if _fixed is None:
        set_fixed(now())
    _offset += timedelta(seconds=seconds)
    return now()


def set_source(source: Callable[[], datetime] | None) -> None:
    """安装自定义时间源（测试用），传 None 恢复系统时钟。"""
    global _source
    _source = source


def reset() -> None:
    global _fixed, _offset, _source
    _fixed = None
    _offset = timedelta(0)
    _source = None
