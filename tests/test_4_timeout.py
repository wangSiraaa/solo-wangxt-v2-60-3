"""验收 4：超时后迟到确认不能夺取责任。"""
from __future__ import annotations

from app.services import clock
from tests.helpers import (
    confirm,
    create_and_start_job,
    current_holder,
    initiate,
)


def test_late_confirmation_after_expiry_does_not_take_responsibility(client):
    job_id, holders, backup = create_and_start_job(
        client, code="EXP-1", timeout=120
    )
    old, new = holders["LEADER"], backup["LEADER"]
    hid = initiate(client, job_id, "LEADER", old, new).json()["id"]

    confirm(client, hid, old)

    # 越过 expires_at：接班人的“迟到确认”必须被拒绝
    clock.advance(121)
    r = confirm(client, hid, new)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "HANDOVER_EXPIRED"

    h = client.get(f"/handovers/{hid}").json()
    assert h["status"] == "EXPIRED"
    assert h["incoming_status"] == "PENDING"
    assert h["receipt"]["status"] == "CANCELED"
    events = [e["event_type"] for e in h["events"]]
    assert events[-1] == "EXPIRED"

    # 责任仍在交班人，岗位解除“交接中”标记
    holder = current_holder(client, job_id, "LEADER")
    assert holder["worker_id"] == old
    assert holder["current_handover_id"] is None

    # 交班人事后再确认也不能复活超时单
    r = confirm(client, hid, old)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "HANDOVER_EXPIRED"

    # 超时后允许重新发起一次新交接并正常完成
    hid2 = initiate(client, job_id, "LEADER", old, new).json()["id"]
    assert hid2 != hid
    assert confirm(client, hid2, old).status_code == 200
    assert confirm(client, hid2, new).json()["status"] == "COMPLETED"
    assert current_holder(client, job_id, "LEADER")["worker_id"] == new


def test_lazy_expiry_via_sweep_endpoint(client):
    job_id, holders, backup = create_and_start_job(
        client, code="EXP-2", timeout=60
    )
    hid = initiate(
        client, job_id, "GUARD", holders["GUARD"], backup["GUARD"]
    ).json()["id"]
    clock.advance(61)
    r = client.post("/handovers/sweep-expired", params={"job_id": job_id})
    assert r.status_code == 200
    assert r.json()["expired_count"] == 1
    # 再扫一次为 0（不重复迁移状态）
    r = client.post("/handovers/sweep-expired", params={"job_id": job_id})
    assert r.json()["expired_count"] == 0
    assert client.get(f"/handovers/{hid}").json()["status"] == "EXPIRED"


def test_cannot_close_job_with_unexpired_pending_handover(client):
    job_id, holders, backup = create_and_start_job(
        client, code="EXP-3", timeout=300
    )
    hid = initiate(
        client, job_id, "LEADER", holders["LEADER"], backup["LEADER"]
    ).json()["id"]
    clock.advance(100)  # 未超时
    r = client.post(f"/jobs/{job_id}/close", json={})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "PENDING_HANDOVER_BLOCKS_CLOSE"
    assert r.json()["error"]["details"]["pending_handover_ids"] == [hid]


def test_expired_pending_handover_does_not_block_close(client):
    job_id, holders, backup = create_and_start_job(
        client, code="EXP-4", timeout=60
    )
    initiate(client, job_id, "LEADER", holders["LEADER"], backup["LEADER"])
    clock.advance(61)
    r = client.post(f"/jobs/{job_id}/close", json={})
    assert r.status_code == 200
    assert r.json()["status"] == "CLOSED"


def test_no_handover_before_start_or_after_close(client):
    job_id, holders, backup = create_and_start_job(client, code="EXP-5")
    # 已经 ACTIVE —— 先销记
    assert client.post(f"/jobs/{job_id}/close", json={}).status_code == 200
    r = initiate(
        client, job_id, "LEADER", holders["LEADER"], backup["LEADER"]
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "JOB_NOT_ACTIVE"
