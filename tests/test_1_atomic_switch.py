"""验收 1：正常双向确认后的原子责任切换。"""
from __future__ import annotations

import sqlite3

from app.services import clock
from tests.helpers import (
    POSITIONS,
    confirm,
    create_and_start_job,
    current_holder,
    initiate,
)


def test_double_confirmation_switches_responsibility_atomically(client):
    job_id, holders, backup = create_and_start_job(client, code="ATOM-1")
    old_leader = holders["LEADER"]
    new_leader = backup["LEADER"]

    # 发起：LEADER 接班人到岗且资质覆盖；快照固化全部四岗
    r = initiate(client, job_id, "LEADER", old_leader, new_leader)
    assert r.status_code == 201, r.text
    handover = r.json()
    hid = handover["id"]
    assert handover["status"] == "PENDING"
    assert set(handover["responsibility_snapshot"].keys()) == set(POSITIONS)
    assert handover["responsibility_snapshot"]["LEADER"]["worker_id"] == old_leader
    # 模拟回执在发起时出具并与交接关联
    assert handover["receipt"] is not None
    assert handover["receipt"]["status"] == "ISSUED"

    # 发起后责任尚未切换，岗位标记有进行中交接
    holder = current_holder(client, job_id, "LEADER")
    assert holder["worker_id"] == old_leader
    assert holder["current_handover_id"] == hid

    # 交班人确认 → 仍未切换
    r = confirm(client, hid, old_leader)
    assert r.status_code == 200
    assert r.json()["status"] == "PENDING"
    assert current_holder(client, job_id, "LEADER")["worker_id"] == old_leader

    # 接班人确认 → 完成并切换
    r = confirm(client, hid, new_leader)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "COMPLETED"
    assert body["completed_at"] is not None

    holder = current_holder(client, job_id, "LEADER")
    assert holder["worker_id"] == new_leader
    assert holder["chain_seq"] == 1
    assert holder["current_handover_id"] is None

    # 其余岗位责任人不变
    rows = client.get(f"/jobs/{job_id}/assignments").json()
    by_pos = {a["position"]: a for a in rows}
    for pos in ("SAFETY", "LIAISON", "GUARD"):
        assert by_pos[pos]["worker_id"] == holders[pos]
        assert by_pos[pos]["chain_seq"] == 0

    # 完成事件中带切换后责任快照；回执转为 CONFIRMED
    detail = body["events"][-1]
    assert detail["event_type"] == "COMPLETED"
    assert detail["detail"]["responsibility_after"]["LEADER"]["worker_id"] == new_leader
    assert body["receipt"]["status"] == "CONFIRMED"
    assert body["receipt"]["settled_at"] is not None

    # 作业级审计记录 INITIATED → POSITION_HANDED_OVER
    job_events = [e["event_type"] for e in client.get(f"/jobs/{job_id}/events").json()]
    assert "INITIATED" in job_events
    assert job_events[-1] == "POSITION_HANDED_OVER"


def test_no_position_is_ever_without_holder_including_mid_handover(client):
    """不变量：assignments 中每岗始终恰好一行（不存在空缺窗口）。"""
    job_id, holders, backup = create_and_start_job(client, code="ATOM-2")
    hid = initiate(
        client, job_id, "GUARD", holders["GUARD"], backup["GUARD"]
    ).json()["id"]
    confirm(client, hid, holders["GUARD"])
    # 接班人确认前
    rows = client.get(f"/jobs/{job_id}/assignments").json()
    assert len(rows) == 4
    assert {a["position"] for a in rows} == set(POSITIONS)
    confirm(client, hid, backup["GUARD"])
    rows = client.get(f"/jobs/{job_id}/assignments").json()
    assert len(rows) == 4
    assert {a["position"] for a in rows} == set(POSITIONS)
    guard = next(a for a in rows if a["position"] == "GUARD")
    assert guard["worker_id"] == backup["GUARD"]


def test_database_level_invariant_single_assignment_row_per_position(client):
    """数据库唯一约束保证不会出现同一岗位两行责任人。"""
    job_id, holders, backup = create_and_start_job(client, code="ATOM-3")
    import os

    from sqlalchemy import create_engine, text as sql_text

    eng = create_engine(os.environ["DATABASE_URL"])
    with eng.begin() as conn:
        row = conn.execute(
            sql_text(
                "SELECT id, worker_id FROM assignments "
                "WHERE job_id=:j AND position='LEADER'"
            ),
            {"j": job_id},
        ).one()
        # 直接尝试插入第二行 LEADER 责任人必须被唯一约束拒绝
        import pytest
        from sqlalchemy.exc import IntegrityError

        with pytest.raises(IntegrityError):
            with eng.begin() as conn2:
                conn2.execute(
                    sql_text(
                        "INSERT INTO assignments "
                        "(job_id, position, worker_id, chain_seq, updated_at) "
                        "VALUES (:j,'LEADER',:w,99,'2026-09-24 10:00:00')"
                    ),
                    {"j": job_id, "w": backup["LEADER"]},
                )


def test_handover_chain_accumulates_in_order(client):
    job_id, holders, backup = create_and_start_job(client, code="CHAIN-1")
    third = client.post(
        "/workers",
        json={"employee_no": "L3", "name": "L3",
              "qualifications": ["LEADER"], "arrived": True},
    ).json()["id"]

    seq_holders = [holders["LEADER"], backup["LEADER"], third]
    for i in range(2):
        hid = initiate(
            client, job_id, "LEADER", seq_holders[i], seq_holders[i + 1]
        ).json()["id"]
        assert confirm(client, hid, seq_holders[i]).status_code == 200
        assert confirm(client, hid, seq_holders[i + 1]).json()["status"] == "COMPLETED"

    holder = current_holder(client, job_id, "LEADER")
    assert holder["worker_id"] == third
    assert holder["chain_seq"] == 2

    chain = client.get(
        "/handovers/chain", params={"job_id": job_id, "position": "LEADER"}
    ).json()
    assert [h["chain_seq"] for h in chain] == [1, 2]
    assert chain[0]["incoming_worker_id"] == backup["LEADER"]
    assert chain[1]["incoming_worker_id"] == third
