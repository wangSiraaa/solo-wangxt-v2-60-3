"""数据库引擎与会话管理。

SQLite 写事务使用 ``BEGIN IMMEDIATE``，配合 ``busy_timeout``，
保证两个并发完成交接的线程在同一事务边界上被数据库串行化，
配合条件 UPDATE 的 rowcount 判定实现“并发完成只形成一次交接”。
"""
from __future__ import annotations

import os
from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.domain.models import Base

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "sqlite:////workspace/data/app.db"
)

_connect_args: dict = {"timeout": 30, "check_same_thread": False}

engine: Engine = create_engine(
    DATABASE_URL,
    connect_args=_connect_args,
    future=True,
)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_connection, _record):  # pragma: no cover - 配置
    cur = dbapi_connection.cursor()
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA busy_timeout=30000")
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.close()


@event.listens_for(engine, "begin")
def _begin_immediate(conn):
    """每个新事务立即取写锁（BEGIN IMMEDIATE）。

    这是并发安全的关键：两个“最后确认”事务在第一时间被数据库串行化，
    后到者一定能读到先提交者写入的对方确认状态，
    条件 UPDATE 的 rowcount 判定保证只发生一次责任切换。
    """
    if DATABASE_URL.startswith("sqlite"):
        conn.exec_driver_sql("BEGIN IMMEDIATE")


SessionLocal = sessionmaker(
    bind=engine, expire_on_commit=False, future=True
)


def init_db(target_engine: Engine | None = None) -> None:
    """建表（开发/测试环境使用；生产应使用迁移工具）。"""
    eng = target_engine or engine
    Base.metadata.create_all(eng)


def get_session() -> Iterator[Session]:
    """FastAPI 依赖：每请求一个会话。"""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
