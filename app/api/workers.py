"""人员路由。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import serializers
from app.api.schemas import WorkerCreate, WorkerOut
from app.db import get_session
from app.domain.errors import NotFoundError
from app.domain.models import Worker
from app.services import jobs as jobs_svc

router = APIRouter(prefix="/workers", tags=["workers 人员"])


@router.post("", response_model=WorkerOut, status_code=201, summary="登记人员")
def create_worker(body: WorkerCreate, db: Session = Depends(get_session)) -> WorkerOut:
    worker = jobs_svc.create_worker(
        db,
        employee_no=body.employee_no,
        name=body.name,
        qualifications=list(body.qualifications),
        arrived=body.arrived,
    )
    return serializers.worker_out(worker)


@router.get("", response_model=list[WorkerOut], summary="人员列表")
def list_workers(db: Session = Depends(get_session)) -> list[WorkerOut]:
    rows = db.scalars(select(Worker).order_by(Worker.id)).all()
    return [serializers.worker_out(w) for w in rows]


@router.get("/{worker_id}", response_model=WorkerOut, summary="人员详情")
def get_worker(worker_id: int, db: Session = Depends(get_session)) -> WorkerOut:
    w = db.get(Worker, worker_id)
    if w is None:
        raise NotFoundError("人员不存在", {"worker_id": worker_id})
    return serializers.worker_out(w)


@router.post(
    "/{worker_id}/arrival",
    response_model=WorkerOut,
    summary="人员到岗登记",
)
def mark_arrival(worker_id: int, db: Session = Depends(get_session)) -> WorkerOut:
    return serializers.worker_out(jobs_svc.mark_arrival(db, worker_id))


@router.post(
    "/{worker_id}/departure",
    response_model=WorkerOut,
    summary="人员离场（责任人须先交接）",
)
def mark_departure(worker_id: int, db: Session = Depends(get_session)) -> WorkerOut:
    return serializers.worker_out(jobs_svc.mark_departure(db, worker_id))
