"""验收 2：资质不足/未到岗/岗位占用时不产生部分切换；拒绝路径。"""
from __future__ import annotations

from tests.helpers import (
    POSITIONS,
    confirm,
    create_and_start_job,
    create_worker,
    current_holder,
    initiate,
    reject,
)


def test_initiate_rejected_when_incoming_lacks_qualification(client):
    job_id, holders, _ = create_and_start_job(client, code="ELG-1")
    # 只有 SAFETY 资质的人接 LEADER
    safety_only = create_worker(client, "X-SAFE", ["SAFETY"])
    r = initiate(client, job_id, "LEADER", holders["LEADER"], safety_only)
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "INCOMING_NOT_ELIGIBLE"
    assert "QUALIFICATION_MISMATCH" in err["details"]["problems"]

    # 无交接单产生、责任人不变
    assert client.get("/handovers", params={"job_id": job_id}).json() == []
    holder = current_holder(client, job_id, "LEADER")
    assert holder["worker_id"] == holders["LEADER"]
    assert holder["current_handover_id"] is None


def test_initiate_rejected_when_incoming_not_arrived(client):
    job_id, holders, _ = create_and_start_job(client, code="ELG-2")
    absent = create_worker(client, "X-ABS", ["LEADER"], arrived=False)
    r = initiate(client, job_id, "LEADER", holders["LEADER"], absent)
    assert r.status_code == 422
    assert "NOT_ARRIVED" in r.json()["error"]["details"]["problems"]
    assert client.get("/handovers", params={"job_id": job_id}).json() == []


def test_initiate_rejected_when_incoming_holds_other_required_position(client):
    """接班人若已担任本作业其他必需岗位，不能再接岗（否则造成另一岗空缺）。"""
    job_id, holders, backup = create_and_start_job(client, code="ELG-3")
    # 当前 SAFETY 责任人试图接 LEADER
    r = initiate(client, job_id, "LEADER", holders["LEADER"], holders["SAFETY"])
    assert r.status_code == 422
    assert "HOLDS_OTHER_POSITION" in r.json()["error"]["details"]["problems"]


def test_lost_eligibility_before_completion_causes_no_partial_switch(client):
    """接班人在交班人确认后离场：完成复验失败，本次确认不落库、责任不切换。"""
    job_id, holders, backup = create_and_start_job(client, code="ELG-4")
    old, new = holders["LEADER"], backup["LEADER"]
    hid = initiate(client, job_id, "LEADER", old, new).json()["id"]

    assert confirm(client, hid, old).json()["status"] == "PENDING"
    # 接班人离场（非责任人，允许离场）
    assert client.post(f"/workers/{new}/departure").status_code == 200

    r = confirm(client, hid, new)
    assert r.status_code == 422
    assert "NOT_ARRIVED" in r.json()["error"]["details"]["problems"]

    # 接班人确认状态未被写入；LEADER 仍是交班人；无任何切换痕迹
    h = client.get(f"/handovers/{hid}").json()
    assert h["incoming_status"] == "PENDING"
    assert h["outgoing_status"] == "CONFIRMED"
    assert current_holder(client, job_id, "LEADER")["worker_id"] == old
    events = [e["event_type"] for e in h["events"]]
    assert events == ["INITIATED", "OUTGOING_CONFIRMED", "BLOCKED"]

    # 接班人重新到岗后可以正常完成（交接未超时）
    client.post(f"/workers/{new}/arrival")
    r = confirm(client, hid, new)
    assert r.json()["status"] == "COMPLETED"
    assert current_holder(client, job_id, "LEADER")["worker_id"] == new


def test_reject_by_party_records_reason_and_cancels_receipt(client):
    job_id, holders, backup = create_and_start_job(client, code="ELG-5")
    old, new = holders["SAFETY"], backup["SAFETY"]
    hid = initiate(client, job_id, "SAFETY", old, new).json()["id"]

    # 拒绝必须带原因
    r = client.post(
        f"/handovers/{hid}/reject",
        json={"worker_id": new, "reason": "   "},
    )
    assert r.status_code == 400

    r = reject(client, hid, new, "防护用品未配齐，无法接班")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "REJECTED"
    assert body["reject_reason"] == "防护用品未配齐，无法接班"
    assert body["rejected_by_worker_id"] == new
    assert body["incoming_status"] == "REJECTED"
    assert body["receipt"]["status"] == "CANCELED"

    # 责任人保持交班人，岗位无进行中交接
    holder = current_holder(client, job_id, "SAFETY")
    assert holder["worker_id"] == old
    assert holder["current_handover_id"] is None

    # 被拒绝的单不能再确认；同一岗位可以重新发起交接
    r = confirm(client, hid, new)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "HANDOVER_NOT_PENDING"
    hid2 = initiate(client, job_id, "SAFETY", old, new).json()
    assert hid2["id"] != hid


def test_outgoing_not_current_holder_cannot_initiate(client):
    job_id, holders, backup = create_and_start_job(client, code="ELG-6")
    r = initiate(
        client, job_id, "LEADER", backup["LEADER"],
        create_worker(client, "X1", ["LEADER"]),
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "POSITION_BUSY"


def test_only_parties_can_confirm_or_reject(client):
    job_id, holders, backup = create_and_start_job(client, code="ELG-7")
    outsider = create_worker(client, "OUT", ["LEADER"])
    hid = initiate(
        client, job_id, "LIAISON", holders["LIAISON"], backup["LIAISON"]
    ).json()["id"]
    r = confirm(client, hid, outsider)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "NOT_HANDOVER_PARTY"
    r = reject(client, hid, outsider, "无关人员拒绝")
    assert r.status_code == 409
