"""作业与人员服务：建票、开工、岗位配置/指派、销记。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.enums import (
    ALL_POSITIONS,
    JobEventType,
    JobStatus,
    Position,
)
from app.domain.errors import (
    BadRequestError,
    ConflictError,
    JobNotActiveError,
    NotFoundError,
    PendingHandoverBlocksCloseError,
    RequiredPositionVacantError,
)
from app.domain.models import (
    Assignment,
    Handover,
    Job,
    JobPosition,
    Worker,
)
from app.domain.enums import HandoverStatus
from app.services import audit, clock
from app.services.handovers import (
    _job_required_positions,
    _mark_expired,
    assignments_of,
    get_job,
)


# ---------------------------------------------------------------- 人员

def create_worker(
    db: Session,
    *,
    employee_no: str,
    name: str,
    qualifications: list[str],
    arrived: bool = False,
) -> Worker:
    try:
        unknown = [q for q in qualifications if q not in {p.value for p in Position}]
        if unknown:
            raise BadRequestError(
                "存在未知资质岗位", {"unknown": unknown,
                                 "allowed": [p.value for p in Position]}
            )
        dup = db.scalar(select(Worker).where(Worker.employee_no == employee_no))
        if dup is not None:
            raise ConflictError("工号已存在", {"employee_no": employee_no})
        ts = clock.now()
        worker = Worker(
            employee_no=employee_no,
            name=name,
            qualifications=sorted(set(qualifications)),
            arrived_at=ts if arrived else None,
            created_at=ts,
        )
        db.add(worker)
        db.commit()
        db.refresh(worker)
        return worker
    except Exception:
        db.rollback()
        raise


def mark_arrival(db: Session, worker_id: int) -> Worker:
    try:
        worker = db.get(Worker, worker_id)
        if worker is None:
            raise NotFoundError("人员不存在", {"worker_id": worker_id})
        if worker.arrived_at is None:
            worker.arrived_at = clock.now()
            db.commit()
            db.refresh(worker)
        return worker
    except Exception:
        db.rollback()
        raise


def mark_departure(db: Session, worker_id: int) -> Worker:
    """离场（用于“完成瞬间复验未到岗”场景）。

    当前正担任进行中作业岗位责任人的人员不允许直接离场 ——
    必需岗位不能因离场而空缺。
    """
    try:
        worker = db.get(Worker, worker_id)
        if worker is None:
            raise NotFoundError("人员不存在", {"worker_id": worker_id})
        holding = db.scalar(
            select(Assignment)
            .join(Job, Job.id == Assignment.job_id)
            .where(
                Assignment.worker_id == worker_id,
                Job.status == JobStatus.ACTIVE.value,
            )
        )
        if holding is not None:
            raise ConflictError(
                "该人员当前是进行中作业的岗位责任人，需先完成交接才能离场",
                {"job_id": holding.job_id, "position": holding.position},
            )
        worker.arrived_at = None
        db.commit()
        db.refresh(worker)
        return worker
    except Exception:
        db.rollback()
        raise


# ---------------------------------------------------------------- 作业

def create_job(
    db: Session,
    *,
    code: str,
    title: str,
    positions: list[str] | None = None,
    planned_start_at=None,
    handover_timeout_seconds: int = 300,
) -> Job:
    try:
        if handover_timeout_seconds < 30 or handover_timeout_seconds > 86400:
            raise BadRequestError(
                "交接超时秒数应在 30..86400 之间",
                {"handover_timeout_seconds": handover_timeout_seconds},
            )
        dup = db.scalar(select(Job).where(Job.code == code))
        if dup is not None:
            raise ConflictError("作业编号已存在", {"code": code})

        selected = positions or [p.value for p in ALL_POSITIONS]
        chosen: list[Position] = []
        for raw in selected:
            try:
                chosen.append(Position(raw))
            except ValueError:
                raise BadRequestError(
                    f"未知岗位: {raw}", {"allowed": [p.value for p in Position]}
                )
        if len(set(p.value for p in chosen)) != len(chosen):
            raise BadRequestError("必需岗位重复")
        if not chosen:
            raise BadRequestError("至少配置一个必需岗位")

        ts = clock.now()
        job = Job(
            code=code,
            title=title,
            status=JobStatus.PLANNED.value,
            planned_start_at=planned_start_at,
            handover_timeout_seconds=handover_timeout_seconds,
            created_at=ts,
        )
        db.add(job)
        db.flush()
        for p in chosen:
            db.add(JobPosition(job_id=job.id, position=p.value))
        audit.add_job_event(
            db, job_id=job.id, event_type=JobEventType.CREATED.value,
            detail={"positions": [p.value for p in chosen]},
        )
        db.commit()
        db.refresh(job)
        return job
    except Exception:
        db.rollback()
        raise


def assign_position(
    db: Session,
    *,
    job_id: int,
    position: str,
    worker_id: int,
    require_qualification: bool = True,
) -> Assignment:
    """为岗位指派初始/后续责任人（开工前布岗；交接期间不允许覆盖指派）。"""
    try:
        try:
            pos = Position(position)
        except ValueError:
            raise BadRequestError(
                f"未知岗位: {position}",
                {"allowed": [p.value for p in Position]},
            )
        job = get_job(db, job_id)
        required = _job_required_positions(db, job_id)
        if pos.value not in required:
            raise BadRequestError(
                f"{pos.label}不是该作业配置的必需岗位",
                {"position": pos.value, "required": sorted(required)},
            )
        worker = db.get(Worker, worker_id)
        if worker is None:
            raise NotFoundError("人员不存在", {"worker_id": worker_id})
        if require_qualification and pos.value not in (worker.qualifications or []):
            raise BadRequestError(
                "人员不具备该岗位资质",
                {"worker_id": worker_id, "position": pos.value},
            )

        other = db.scalar(
            select(Assignment).where(
                Assignment.job_id == job_id,
                Assignment.worker_id == worker_id,
                Assignment.position != pos.value,
            )
        )
        if other is not None:
            raise ConflictError(
                "该人员已担任本作业其他必需岗位",
                {"position": other.position},
            )

        assignment = db.scalar(
            select(Assignment).where(
                Assignment.job_id == job_id, Assignment.position == pos.value
            )
        )
        if assignment is not None:
            if assignment.current_handover_id is not None:
                raise ConflictError(
                    "该岗位存在进行中的交接，不能直接指派",
                    {"handover_id": assignment.current_handover_id},
                )
            if job.status == JobStatus.ACTIVE.value:
                raise ConflictError(
                    "作业进行中，责任人变更必须走交接流程",
                    {"position": pos.value},
                )
            assignment.worker_id = worker_id
            assignment.updated_at = clock.now()
        else:
            assignment = Assignment(
                job_id=job_id, position=pos.value, worker_id=worker_id,
                chain_seq=0, updated_at=clock.now(),
            )
            db.add(assignment)
        db.flush()
        audit.add_job_event(
            db, job_id=job_id,
            event_type=JobEventType.POSITION_ASSIGNED.value,
            actor_worker_id=worker_id,
            detail={"position": pos.value},
        )
        db.commit()
        db.refresh(assignment)
        return assignment
    except Exception:
        db.rollback()
        raise


def start_job(db: Session, *, job_id: int, actor_worker_id: int | None = None) -> Job:
    """计划开工（满足全部必需岗位已布岗后才能开工）。"""
    try:
        job = get_job(db, job_id)
        if job.status == JobStatus.CLOSED.value:
            raise JobNotActiveError("作业已销记，不能开工", {"job_id": job_id})
        if job.status == JobStatus.ACTIVE.value:
            return job

        required = _job_required_positions(db, job_id)
        assigned = {a.position for a in assignments_of(db, job_id)}
        missing = required - assigned
        if missing:
            raise RequiredPositionVacantError(
                "必需岗位尚未全部布岗，不能开工",
                {"missing_positions": sorted(missing)},
            )

        ts = clock.now()
        job.status = JobStatus.ACTIVE.value
        job.started_at = ts
        audit.add_job_event(
            db, job_id=job_id, event_type=JobEventType.STARTED.value,
            actor_worker_id=actor_worker_id, detail={"started_at": ts.isoformat()},
        )
        db.commit()
        db.refresh(job)
        return job
    except Exception:
        db.rollback()
        raise


def close_job(db: Session, *, job_id: int, actor_worker_id: int | None = None) -> Job:
    """销记：不得遗留未决交接；固化最终责任人快照与交接链。销记后不得再交接。"""
    try:
        job = get_job(db, job_id)
        if job.status == JobStatus.CLOSED.value:
            return job
        if job.status != JobStatus.ACTIVE.value:
            raise JobNotActiveError(
                "作业尚未开工，不能销记", {"job_id": job_id, "job_status": job.status}
            )

        # 先把到期未决单超时关闭，再检查是否仍有未决交接
        pending = list(
            db.scalars(
                select(Handover).where(
                    Handover.job_id == job_id,
                    Handover.status == HandoverStatus.PENDING.value,
                )
            ).all()
        )
        still_pending: list[Handover] = []
        for h in pending:
            if clock.now() >= h.expires_at:
                _mark_expired(db, h)
            else:
                still_pending.append(h)
        if still_pending:
            ids = [h.id for h in still_pending]
            raise PendingHandoverBlocksCloseError(
                "存在未完成双向确认的交接，不能销记",
                {"pending_handover_ids": ids},
            )

        required = _job_required_positions(db, job_id)
        current = {a.position: a for a in assignments_of(db, job_id)}
        missing = required - set(current)
        if missing:
            raise RequiredPositionVacantError(
                "销记前存在无责任人的必需岗位",
                {"missing_positions": sorted(missing)},
            )

        snapshot = audit.build_responsibility_snapshot(db, job)
        chain = []
        for position in sorted(required):
            chain.append(
                {
                    "position": position,
                    "handovers": [
                        {
                            "handover_id": h.id,
                            "chain_seq": h.chain_seq,
                            "outgoing_worker_id": h.outgoing_worker_id,
                            "incoming_worker_id": h.incoming_worker_id,
                            "status": h.status,
                        }
                        for h in sorted(
                            [h for h in job_handovers(db, job_id) if h.position == position],
                            key=lambda x: (x.chain_seq, x.id),
                        )
                    ],
                }
            )

        ts = clock.now()
        job.status = JobStatus.CLOSED.value
        job.closed_at = ts
        job.final_responsibility_snapshot = snapshot
        job.final_handover_chain = chain
        audit.add_job_event(
            db, job_id=job_id, event_type=JobEventType.CLOSED.value,
            actor_worker_id=actor_worker_id,
            detail={
                "closed_at": ts.isoformat(),
                "final_responsibility_snapshot": snapshot,
                "final_handover_chain": chain,
            },
        )
        db.commit()
        db.refresh(job)
        return job
    except Exception:
        db.rollback()
        raise


def job_handovers(db: Session, job_id: int) -> list[Handover]:
    return list(
        db.scalars(
            select(Handover)
            .where(Handover.job_id == job_id)
            .order_by(Handover.chain_seq, Handover.id)
        ).all()
    )
