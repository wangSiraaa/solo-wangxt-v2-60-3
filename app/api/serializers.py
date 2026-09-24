"""ORM → 输出模型序列化。"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.domain.enums import Position
from app.domain.models import Assignment, Handover, Job, Worker
from app.api.schemas import (
    AssignmentOut,
    HandoverEventOut,
    HandoverOut,
    JobOut,
    ReceiptOut,
    WorkerOut,
)
from app.services import clock


def worker_out(w: Worker) -> WorkerOut:
    return WorkerOut(
        id=w.id,
        employee_no=w.employee_no,
        name=w.name,
        qualifications=list(w.qualifications or []),
        arrived=w.arrived_at is not None,
        arrived_at=w.arrived_at,
        created_at=w.created_at,
    )


def _worker_name(db: Session, worker_id: int) -> str:
    w = db.get(Worker, worker_id)
    return w.name if w else f"#{worker_id}"


def assignment_out(db: Session, a: Assignment) -> AssignmentOut:
    return AssignmentOut(
        id=a.id,
        job_id=a.job_id,
        position=a.position,
        position_label=Position(a.position).label,
        worker_id=a.worker_id,
        worker_name=_worker_name(db, a.worker_id),
        chain_seq=a.chain_seq,
        current_handover_id=a.current_handover_id,
        updated_at=a.updated_at,
    )


def receipt_out(r) -> ReceiptOut:
    return ReceiptOut(
        id=r.id,
        receipt_no=r.receipt_no,
        status=r.status,
        payload=r.payload or {},
        issued_at=r.issued_at,
        settled_at=r.settled_at,
    )


def handover_out(h: Handover) -> HandoverOut:
    expired = (
        h.status == "PENDING" and clock.now() >= h.expires_at
    )
    events = [
        HandoverEventOut(
            seq=e.seq,
            event_type=e.event_type,
            actor_worker_id=e.actor_worker_id,
            detail=e.detail,
            created_at=e.created_at,
        )
        for e in sorted(h.events, key=lambda x: x.seq)
    ]
    return HandoverOut(
        id=h.id,
        job_id=h.job_id,
        position=h.position,
        position_label=Position(h.position).label,
        outgoing_worker_id=h.outgoing_worker_id,
        incoming_worker_id=h.incoming_worker_id,
        initiated_by_worker_id=h.initiated_by_worker_id,
        status=h.status,
        outgoing_status=h.outgoing_status,
        incoming_status=h.incoming_status,
        outgoing_confirmed_at=h.outgoing_confirmed_at,
        incoming_confirmed_at=h.incoming_confirmed_at,
        reject_reason=h.reject_reason,
        rejected_by_worker_id=h.rejected_by_worker_id,
        responsibility_snapshot=h.responsibility_snapshot or {},
        chain_seq=h.chain_seq,
        initiated_at=h.initiated_at,
        expires_at=h.expires_at,
        completed_at=h.completed_at,
        expired=expired,
        receipt=receipt_out(h.receipt) if h.receipt else None,
        events=events,
    )


def job_out(db: Session, job: Job) -> JobOut:
    positions = sorted({p.position for p in job.required_positions})
    return JobOut(
        id=job.id,
        code=job.code,
        title=job.title,
        status=job.status,
        positions=positions,
        planned_start_at=job.planned_start_at,
        handover_timeout_seconds=job.handover_timeout_seconds,
        started_at=job.started_at,
        closed_at=job.closed_at,
        final_responsibility_snapshot=job.final_responsibility_snapshot,
        final_handover_chain=job.final_handover_chain,
        created_at=job.created_at,
        assignments=[
            assignment_out(db, a)
            for a in sorted(job.assignments, key=lambda x: x.position)
        ],
    )
