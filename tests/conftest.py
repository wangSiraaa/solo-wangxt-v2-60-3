"""集成测试夹具。

每个测试使用独立的临时 SQLite 文件库，``client`` 走完整 ASGI 栈
（路由/依赖/错误处理/序列化），服务层并发测试则直连同一数据库文件，
从而可以用多线程验证“并发完成只形成一次交接”。
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

# 任何 app.* 导入之前落定数据库路径
_TMPDIR = Path(tempfile.mkdtemp(prefix="handover-tests-"))
_DB_PATH = _TMPDIR / "test.db"
os.environ["DATABASE_URL"] = f"sqlite:///{_DB_PATH}"

from fastapi.testclient import TestClient  # noqa: E402

from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.main import create_app  # noqa: E402
from app.services import clock  # noqa: E402


@pytest.fixture(autouse=True)
def reset_state():
    # 全新空库 + 时钟归零。
    # assignments/handovers 存在循环外键，drop_all 需要在事务外、
    # 用同一 DBAPI 连接关闭 FK 检查后执行。
    from app.domain.models import Base

    with engine.connect() as conn:
        raw = conn.connection.dbapi_connection
        raw.execute("PRAGMA foreign_keys=OFF")
        Base.metadata.drop_all(conn)
        conn.commit()
        raw.execute("PRAGMA foreign_keys=ON")
    init_db(engine)
    clock.reset()
    clock.set_fixed(__import__("datetime").datetime(2026, 9, 24, 9, 0, 0))
    yield
    clock.reset()


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client():
    app = create_app(run_init=False)
    with TestClient(app) as c:
        yield c
