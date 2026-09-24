"""验收 5：销记记录可追溯最终责任人；销记后不得再交接。"""
from __future__ import annotations

from tests.helpers import (
    POSITIONS,
    confirm,
    create_and_start_job,
    current_holder,
    initiate,
)


def test_close_freezes_final_responsibility_snapshot_and_chain(client):
    job_id, holders, backup = create_and_start_job(client, code="CLOSE-1")

    # LEADER 完成一次交接；SAFETY 完成两次
    hid = initiate(
        client, job_id, "LEADER", holders["LEADER"], backup["LEADER"]
    ).json()["id"]
    confirm(client, hid, holders["LEADER"])
    confirm(client, hid, backup["LEADER"])

    third_safety = client.post(
        "/workers",
        json={"employee_no": "S3", "name": "S3",
              "qualifications": ["SAFETY"], "arrived": True},
    ).json()["id"]
    for old, new in [
        (holders["SAFETY"], backup["SAFETY"]),
        (backup["SAFETY"], third_safety),
    ]:
        hid = initiate(client, job_id, "SAFETY", old, new).json()["id"]
        confirm(client, hid, old)
        confirm(client, hid, new)

    r = client.post(f"/jobs/{job_id}/close", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "CLOSED"
    assert body["closed_at"] is not None

    snap = body["final_responsibility_snapshot"]
    assert set(snap.keys()) == set(POSITIONS)
    assert snap["LEADER"]["worker_id"] == backup["LEADER"]
    assert snap["LEADER"]["chain_seq"] == 1
    assert snap["SAFETY"]["worker_id"] == third_safety
    assert snap["SAFETY"]["chain_seq"] == 2
    assert snap["LIAISON"]["worker_id"] == holders["LIAISON"]
    assert snap["GUARD"]["worker_id"] == holders["GUARD"]

    # 交接链固化在销记记录中
    chains = {c["position"]: c["handovers"] for c in body["final_handover_chain"]}
    assert len(chains["LEADER"]) == 1
    assert len(chains["SAFETY"]) == 2
    assert chains["SAFETY"][1]["status"] == "COMPLETED"
    assert chains["LIAISON"] == []

    # 销记后 GET 作业仍可追溯最终责任人
    fetched = client.get(f"/jobs/{job_id}").json()
    assert fetched["final_responsibility_snapshot"]["SAFETY"]["worker_id"] == third_safety

    # CLOSED 审计事件携带最终快照
    events = client.get(f"/jobs/{job_id}/events").json()
    assert events[-1]["event_type"] == "CLOSED"
    assert events[-1]["detail"]["final_responsibility_snapshot"] == snap

    # 销记后任何交接写操作都被拒绝
    r = initiate(
        client, job_id, "LEADER", backup["LEADER"], holders["LEADER"]
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "JOB_NOT_ACTIVE"


def test_close_is_idempotent(client):
    job_id, holders, _ = create_and_start_job(client, code="CLOSE-2")
    r1 = client.post(f"/jobs/{job_id}/close", json={})
    r2 = client.post(f"/jobs/{job_id}/close", json={})
    assert r1.status_code == r2.status_code == 200
    assert r1.json()["closed_at"] == r2.json()["closed_at"]
    # CLOSED 事件只出现一次
    events = client.get(f"/jobs/{job_id}/events").json()
    assert sum(e["event_type"] == "CLOSED" for e in events) == 1


def test_responsibility_snapshot_immutable_evidence(client):
    """发起时固化的责任快照不随后续切换而变化（证据不变量）。"""
    job_id, holders, backup = create_and_start_job(client, code="CLOSE-3")
    hid = initiate(
        client, job_id, "LEADER", holders["LEADER"], backup["LEADER"]
    ).json()["id"]
    snapshot_at_init = client.get(f"/handovers/{hid}").json()[
        "responsibility_snapshot"
    ]
    confirm(client, hid, holders["LEADER"])
    confirm(client, hid, backup["LEADER"])

    stored = client.get(f"/handovers/{hid}").json()["responsibility_snapshot"]
    assert stored == snapshot_at_init
    assert stored["LEADER"]["worker_id"] == holders["LEADER"]

    # 当前责任人已变，但快照仍是发起时的交班人
    assert current_holder(client, job_id, "LEADER")["worker_id"] == backup["LEADER"]
