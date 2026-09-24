"""审计与快照辅助。

所有审计事件的 seq 都在写事务内通过 ``COUNT + 1`` 生成，
配合 IMMEDIATE 写事务不会产生竞争；顺序持久化到数据库，
进程重启后按 seq 重放即为稳定顺序。
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.domain.models import (
    Assignment,
    HandoverEvent,
    Job,
    JobEvent,
    Worker,
)
from app.services import clock


def _next_handover_seq(db: Session, handover_id: int) -> int:
    current = db.scalar(
        select(func.count(HandoverEvent.id)).where(
            HandoverEvent.handover_id == handover_id
        )
    )
    return (current or 0) + 1


def _next_job_seq(db: Session, job_id: int) -> int:
    current = db.scalar(
        select(func.count(JobEvent.id)).where(JobEvent.job_id == job_id)
    )
    return (current or 0) + 1


def add_handover_event(
    db: Session,
    *,
    handover_id: int,
    event_type: str,
    actor_worker_id: int | None = None,
    detail: dict[str, Any] | None = None,
) -> HandoverEvent:
    event = HandoverEvent(
        handover_id=handover_id,
        seq=_next_handover_seq(db, handover_id),
        event_type=event_type,
        actor_worker_id=actor_worker_id,
        detail=detail,
        created_at=clock.now(),
    )
    db.add(event)
    db.flush()
    return event


def add_job_event(
    db: Session,
    *,
    job_id: int,
    event_type: str,
    actor_worker_id: int | None = None,
    handover_id: int | None = None,
    detail: dict[str, Any] | None = None,
) -> JobEvent:
    event = JobEvent(
        job_id=job_id,
        seq=_next_job_seq(db, job_id),
        event_type=event_type,
        actor_worker_id=actor_worker_id,
        handover_id=handover_id,
        detail=detail,
        created_at=clock.now(),
    )
    db.add(event)
    db.flush()
    return event


def worker_brief(worker: Worker) -> dict[str, Any]:
    return {
        "worker_id": worker.id,
        "employee_no": worker.employee_no,
        "name": worker.name,
    }


def build_responsibility_snapshot(db: Session, job: Job) -> dict[str, Any]:
    """固化当前全部岗位责任人（责任快照，不变量证据）。"""
    rows = db.execute(
        select(Assignment, Worker)
        .join(Worker, Worker.id == Assignment.worker_id)
        .where(Assignment.job_id == job.id)
        .order_by(Assignment.position)
    ).all()
    return {
        assignment.position: {
            **worker_brief(worker),
            "chain_seq": assignment.chain_seq,
        }
        for assignment, worker in rows
    }
