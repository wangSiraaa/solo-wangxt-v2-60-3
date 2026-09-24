"""测试辅助：快速建人、建作业、布岗、开工。"""
from __future__ import annotations

POSITIONS = ["LEADER", "SAFETY", "LIAISON", "GUARD"]


def create_worker(client, employee_no, quals, arrived=True, name=None):
    r = client.post(
        "/workers",
        json={
            "employee_no": employee_no,
            "name": name or employee_no,
            "qualifications": quals,
            "arrived": arrived,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def create_and_start_job(client, code="J1", holders=None, timeout=300,
                         positions=None):
    """holders: {position: worker_id}；缺省自动每岗布一人。

    返回 (job_id, holders, workers)，workers 为每个岗位的备选接班人 id。
    """
    chosen = positions or POSITIONS
    if holders is None:
        holders = {}
        for pos in chosen:
            holders[pos] = create_worker(
                client, f"{pos}-1-{code}", [pos]
            )
    backup = {}
    for pos in chosen:
        backup[pos] = create_worker(client, f"{pos}-2-{code}", [pos])

    r = client.post(
        "/jobs",
        json={"code": code, "title": f"作业{code}",
              "positions": chosen, "handover_timeout_seconds": timeout},
    )
    assert r.status_code == 201, r.text
    job_id = r.json()["id"]
    for pos, wid in holders.items():
        r = client.post(
            f"/jobs/{job_id}/assignments",
            json={"position": pos, "worker_id": wid},
        )
        assert r.status_code == 201, r.text
    r = client.post(f"/jobs/{job_id}/start", json={})
    assert r.status_code == 200, r.text
    return job_id, holders, backup


def current_holder(client, job_id, position):
    rows = client.get(f"/jobs/{job_id}/assignments").json()
    for a in rows:
        if a["position"] == position:
            return a
    raise AssertionError(f"position {position} missing")


def initiate(client, job_id, position, outgoing, incoming, initiator=None,
             timeout=None):
    payload = {
        "job_id": job_id,
        "position": position,
        "outgoing_worker_id": outgoing,
        "incoming_worker_id": incoming,
        "initiated_by_worker_id": initiator or outgoing,
    }
    if timeout is not None:
        payload["timeout_seconds"] = timeout
    return client.post("/handovers", json=payload)


def confirm(client, handover_id, worker_id):
    return client.post(
        f"/handovers/{handover_id}/confirm", json={"worker_id": worker_id}
    )


def reject(client, handover_id, worker_id, reason):
    return client.post(
        f"/handovers/{handover_id}/reject",
        json={"worker_id": worker_id, "reason": reason},
    )
