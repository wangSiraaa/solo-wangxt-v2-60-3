"""验收 6：重启后交接链与审计顺序保持一致（全部状态持久化）。"""
from __future__ import annotations

from sqlalchemy import text as sql_text

from app.db import SessionLocal, engine
from app.services import clock
from fastapi.testclient import TestClient
from app.main import create_app
from tests.helpers import (
    confirm,
    create_and_start_job,
    initiate,
    reject,
)


def _restart_client() -> TestClient:
    """模拟进程重启：释放全部连接池连接后重新构建 ASGI 应用。

    数据库文件不变，因此重启后所有交接/审计数据必须从磁盘完整恢复。
    """
    engine.dispose()
    return TestClient(create_app(run_init=False))


def test_handover_chain_and_audit_order_survive_restart(client):
    job_id, holders, backup = create_and_start_job(client, code="RESTART-1")

    # 完成 LEADER 交接；发起一个被拒绝的 SAFETY 交接；再留一个 PENDING 的 GUARD
    hid_leader = initiate(
        client, job_id, "LEADER", holders["LEADER"], backup["LEADER"]
    ).json()["id"]
    confirm(client, hid_leader, holders["LEADER"])
    confirm(client, hid_leader, backup["LEADER"])

    hid_safety = initiate(
        client, job_id, "SAFETY", holders["SAFETY"], backup["SAFETY"]
    ).json()["id"]
    reject(client, hid_safety, backup["SAFETY"], "身体不适")

    hid_guard = initiate(
        client, job_id, "GUARD", holders["GUARD"], backup["GUARD"]
    ).json()["id"]
    confirm(client, hid_guard, holders["GUARD"])

    job_events_before = client.get(f"/jobs/{job_id}/events").json()
    leader_events_before = client.get(
        f"/handovers/{hid_leader}/events"
    ).json()

    # ---- 模拟重启 ----
    client2 = _restart_client()

    # 当前责任人恢复正确
    rows = client2.get(f"/jobs/{job_id}/assignments").json()
    by_pos = {a["position"]: a for a in rows}
    assert by_pos["LEADER"]["worker_id"] == backup["LEADER"]
    assert by_pos["LEADER"]["chain_seq"] == 1
    assert by_pos["SAFETY"]["worker_id"] == holders["SAFETY"]
    assert by_pos["GUARD"]["worker_id"] == holders["GUARD"]
    assert by_pos["GUARD"]["current_handover_id"] == hid_guard

    # 交接链顺序一致
    chain = client2.get(
        "/handovers/chain", params={"job_id": job_id, "position": "LEADER"}
    ).json()
    assert [h["id"] for h in chain] == [hid_leader]
    assert chain[0]["status"] == "COMPLETED"
    assert chain[0]["receipt"]["status"] == "CONFIRMED"
    # 发起时责任快照恢复
    assert chain[0]["responsibility_snapshot"]["LEADER"]["worker_id"] == holders["LEADER"]

    safety_chain = client2.get(
        "/handovers/chain", params={"job_id": job_id, "position": "SAFETY"}
    ).json()
    assert safety_chain[0]["status"] == "REJECTED"
    assert safety_chain[0]["reject_reason"] == "身体不适"
    assert safety_chain[0]["receipt"]["status"] == "CANCELED"

    # 审计事件 seq 顺序与重启前完全一致
    job_events_after = client2.get(f"/jobs/{job_id}/events").json()
    assert [(e["seq"], e["event_type"], e["handover_id"]) for e in job_events_after] == [
        (e["seq"], e["event_type"], e["handover_id"]) for e in job_events_before
    ]

    leader_events_after = client2.get(f"/handovers/{hid_leader}/events").json()
    assert [e["seq"] for e in leader_events_after] == [
        e["seq"] for e in leader_events_before
    ]
    assert [e["event_type"] for e in leader_events_after] == [
        "INITIATED", "OUTGOING_CONFIRMED", "INCOMING_CONFIRMED", "COMPLETED"
    ]

    # 重启后仍可继续完成重启前挂起的交接
    r = confirm(client2, hid_guard, backup["GUARD"])
    assert r.json()["status"] == "COMPLETED"
    guard_row = next(
        a for a in client2.get(f"/jobs/{job_id}/assignments").json()
        if a["position"] == "GUARD"
    )
    assert guard_row["worker_id"] == backup["GUARD"]

    # 重启后销记，最终责任人快照仍可追溯
    closed = client2.post(f"/jobs/{job_id}/close", json={}).json()
    assert closed["final_responsibility_snapshot"]["LEADER"]["worker_id"] == backup["LEADER"]
    assert closed["final_responsibility_snapshot"]["GUARD"]["worker_id"] == backup["GUARD"]
    chain2 = {c["position"]: c["handovers"] for c in closed["final_handover_chain"]}
    assert [h["status"] for h in chain2["LEADER"]] == ["COMPLETED"]
    assert [h["status"] for h in chain2["SAFETY"]] == ["REJECTED"]
    assert [h["status"] for h in chain2["GUARD"]] == ["COMPLETED"]


def test_audit_seq_stored_densely_and_monotonic(client):
    """直接读库验证 seq 从 1 开始、连续、单调（重启后的排序依据）。"""
    job_id, holders, backup = create_and_start_job(client, code="RESTART-2")
    for i in range(3):
        old = holders["LEADER"] if i == 0 else prev_new
        new = backup["LEADER"] if i == 0 else create_extra(client, i)
        prev_new = new
        hid = initiate(client, job_id, "LEADER", old, new).json()["id"]
        confirm(client, hid, old)
        confirm(client, hid, new)

    engine.dispose()
    with SessionLocal() as session:
        job_seqs = [r[0] for r in session.execute(
            sql_text(
                "SELECT seq FROM job_events WHERE job_id=:j ORDER BY id"
            ),
            {"j": job_id},
        ).all()]
        assert job_seqs == list(range(1, len(job_seqs) + 1))

        rows = session.execute(
            sql_text(
                "SELECT handover_id, seq FROM handover_events "
                "WHERE handover_id IN (SELECT id FROM handovers WHERE job_id=:j) "
                "ORDER BY handover_id, seq"
            ),
            {"j": job_id},
        ).all()
        per: dict[int, list[int]] = {}
        for hid, seq in rows:
            per.setdefault(hid, []).append(seq)
        for hid, seqs in per.items():
            assert seqs == list(range(1, len(seqs) + 1)), hid

        chain_seqs = [r[0] for r in session.execute(
            sql_text(
                "SELECT chain_seq FROM handovers "
                "WHERE job_id=:j AND position='LEADER' ORDER BY chain_seq"
            ),
            {"j": job_id},
        ).all()]
        assert chain_seqs == [1, 2, 3]


def create_extra(client, i: int) -> int:
    return client.post(
        "/workers",
        json={"employee_no": f"L{i}", "name": f"L{i}",
              "qualifications": ["LEADER"], "arrived": True},
    ).json()["id"]
