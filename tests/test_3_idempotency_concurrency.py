"""验收 3：重复确认幂等；并发完成只形成一次交接。"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import pytest
from sqlalchemy import select
from sqlalchemy.exc import OperationalError

from app.db import SessionLocal
from app.domain.enums import HandoverEventType, HandoverStatus
from app.domain.models import Handover, HandoverEvent
from app.services import clock, handovers as svc
from tests.helpers import (
    confirm,
    create_and_start_job,
    current_holder,
    initiate,
)


def test_repeated_confirm_by_same_party_is_idempotent(client):
    job_id, holders, backup = create_and_start_job(client, code="IDEM-1")
    old, new = holders["LEADER"], backup["LEADER"]
    hid = initiate(client, job_id, "LEADER", old, new).json()["id"]

    # 交班人连续三次确认：只有一次 OUTGOING_CONFIRMED
    for _ in range(3):
        body = confirm(client, hid, old).json()
        assert body["status"] == "PENDING"
    events = client.get(f"/handovers/{hid}/events").json()
    assert [e["event_type"] for e in events] == ["INITIATED", "OUTGOING_CONFIRMED"]

    # 接班人重复确认；完成后任何一方再确认都不再产生事件
    confirm(client, hid, new)
    confirm(client, hid, new)
    body = confirm(client, hid, old).json()
    assert body["status"] == "COMPLETED"
    types = [e["event_type"] for e in body["events"]]
    assert types == [
        "INITIATED",
        "OUTGOING_CONFIRMED",
        "INCOMING_CONFIRMED",
        "COMPLETED",
    ]


def test_concurrent_completion_produces_single_switch(db, client):
    """两个线程几乎同时补最后一次确认：只允许一个事务完成并切换。

    先由接班人确认，交班人的“最后确认”由两个线程并发提交。
    BEGIN IMMEDIATE 将写事务串行化，条件 UPDATE 保证只有一个
    rowcount=1，最终只有一条 COMPLETED、责任人只 +1。
    """
    job_id, holders, backup = create_and_start_job(client, code="CONC-1")
    old, new = holders["SAFETY"], backup["SAFETY"]
    hid = initiate(client, job_id, "SAFETY", old, new).json()["id"]
    # 接班人先确认
    assert confirm(client, hid, new).json()["status"] == "PENDING"

    results: list[dict] = []

    def worker_call(worker_id: int) -> dict:
        session = SessionLocal()
        try:
            h = svc.confirm_handover(
                session, handover_id=hid, worker_id=worker_id
            )
            return {"ok": True, "status": h.status}
        except Exception as exc:  # 预期其中一路遇到状态冲突
            return {"ok": False, "error": type(exc).__name__, "msg": str(exc)}
        finally:
            session.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futs = [pool.submit(worker_call, old) for _ in range(2)]
        results = [f.result(timeout=60) for f in futs]

    # 两路都可能成功返回（第二路走幂等分支），也可能第二路拿到冲突；
    # 但最终状态只能有一个 COMPLETED。
    final = client.get(f"/handovers/{hid}").json()
    assert final["status"] == "COMPLETED"

    holder = current_holder(client, job_id, "SAFETY")
    assert holder["worker_id"] == new
    assert holder["chain_seq"] == 1

    with SessionLocal() as session:
        completed = session.scalars(
            select(Handover).where(
                Handover.job_id == job_id,
                Handover.position == "SAFETY",
                Handover.status == HandoverStatus.COMPLETED.value,
            )
        ).all()
        assert len(completed) == 1

        events = session.scalars(
            select(HandoverEvent)
            .where(HandoverEvent.handover_id == hid)
            .order_by(HandoverEvent.seq)
        ).all()
        counts = {}
        for e in events:
            counts[e.event_type] = counts.get(e.event_type, 0) + 1
        assert counts.get(HandoverEventType.COMPLETED.value) == 1
        assert counts.get(HandoverEventType.OUTGOING_CONFIRMED.value) == 1
        # seq 连续无重复
        assert [e.seq for e in events] == list(range(1, len(events) + 1))


def test_concurrent_double_confirm_from_both_parties(db, client):
    """交班人/接班人从 PENDING 状态并发确认：恰好一次完成。"""
    job_id, holders, backup = create_and_start_job(client, code="CONC-2")
    old, new = holders["LIAISON"], backup["LIAISON"]
    hid = initiate(client, job_id, "LIAISON", old, new).json()["id"]

    def call(worker_id: int):
        session = SessionLocal()
        try:
            h = svc.confirm_handover(session, handover_id=hid, worker_id=worker_id)
            return h.status
        except Exception as exc:
            return f"ERR:{type(exc).__name__}"
        finally:
            session.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        f1 = pool.submit(call, old)
        f2 = pool.submit(call, new)
        outcomes = {f1.result(timeout=60), f2.result(timeout=60)}

    final = client.get(f"/handovers/{hid}").json()
    assert final["status"] == "COMPLETED"
    assert current_holder(client, job_id, "LIAISON")["worker_id"] == new

    # 不允许因为并发出现异常传播之外的脏状态：最终事件恰好四件
    events = client.get(f"/handovers/{hid}/events").json()
    assert [e["event_type"] for e in events] == [
        "INITIATED",
        "OUTGOING_CONFIRMED",
        "INCOMING_CONFIRMED",
        "COMPLETED",
    ]
