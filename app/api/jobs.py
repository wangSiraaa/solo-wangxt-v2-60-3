"""作业路由：建票/布岗/开工/销记/责任查询。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import serializers
from app.api.schemas import (
    AssignmentCreate,
    AssignmentOut,
    JobCreate,
    JobEventOut,
    JobOut,
    JobStart,
)
from app.db import get_session
from app.domain.models import Job, JobEvent
from app.services import jobs as jobs_svc
from app.services.handovers import assignments_of, get_job

router = APIRouter(prefix="/jobs", tags=["jobs 作业票"])


@router.post("", response_model=JobOut, status_code=201, summary="建票（配置必需岗位）")
def create_job(body: JobCreate, db: Session = Depends(get_session)) -> JobOut:
    planned = body.planned_start_at
    if planned is not None:
        from datetime import timezone

        # 统一落库为 naive UTC
        if planned.tzinfo is not None:
            planned = planned.astimezone(timezone.utc).replace(tzinfo=None)
    job = jobs_svc.create_job(
        db,
        code=body.code,
        title=body.title,
        positions=list(body.positions) if body.positions else None,
        planned_start_at=planned,
        handover_timeout_seconds=body.handover_timeout_seconds,
    )
    return serializers.job_out(db, job)


@router.get("", response_model=list[JobOut], summary="作业列表")
def list_jobs(db: Session = Depends(get_session)) -> list[JobOut]:
    rows = db.scalars(select(Job).order_by(Job.id)).all()
    return [serializers.job_out(db, j) for j in rows]


@router.get("/{job_id}", response_model=JobOut, summary="作业详情（含当前责任人）")
def retrieve_job(job_id: int, db: Session = Depends(get_session)) -> JobOut:
    return serializers.job_out(db, get_job(db, job_id))


@router.post(
    "/{job_id}/assignments",
    response_model=AssignmentOut,
    status_code=201,
    summary="岗位布岗（指派责任人）",
)
def assign_position(
    job_id: int, body: AssignmentCreate, db: Session = Depends(get_session)
) -> AssignmentOut:
    assignment = jobs_svc.assign_position(
        db,
        job_id=job_id,
        position=body.position,
        worker_id=body.worker_id,
        require_qualification=body.require_qualification,
    )
    return serializers.assignment_out(db, assignment)


@router.get(
    "/{job_id}/assignments",
    response_model=list[AssignmentOut],
    summary="查询当前岗位责任人",
)
def list_assignments(job_id: int, db: Session = Depends(get_session)) -> list[AssignmentOut]:
    get_job(db, job_id)
    return [serializers.assignment_out(db, a) for a in assignments_of(db, job_id)]


@router.post("/{job_id}/start", response_model=JobOut, summary="计划开工")
def start_job(
    job_id: int, body: JobStart, db: Session = Depends(get_session)
) -> JobOut:
    return serializers.job_out(
        db, jobs_svc.start_job(db, job_id=job_id, actor_worker_id=body.actor_worker_id)
    )


@router.post("/{job_id}/close", response_model=JobOut, summary="销记（固化最终责任人）")
def close_job(
    job_id: int, body: JobStart, db: Session = Depends(get_session)
) -> JobOut:
    return serializers.job_out(
        db, jobs_svc.close_job(db, job_id=job_id, actor_worker_id=body.actor_worker_id)
    )


@router.get(
    "/{job_id}/events",
    response_model=list[JobEventOut],
    summary="作业级审计时间线（seq 顺序，重启后保持一致）",
)
def job_events(job_id: int, db: Session = Depends(get_session)) -> list[JobEventOut]:
    get_job(db, job_id)
    rows = db.scalars(
        select(JobEvent).where(JobEvent.job_id == job_id).order_by(JobEvent.seq)
    ).all()
    return [
        JobEventOut(
            seq=e.seq,
            event_type=e.event_type,
            actor_worker_id=e.actor_worker_id,
            handover_id=e.handover_id,
            detail=e.detail,
            created_at=e.created_at,
        )
        for e in rows
    ]
