"""交接路由：发起/双确认/拒绝/查询/交接链/审计/超时扫描。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import serializers
from app.api.schemas import (
    HandoverConfirm,
    HandoverCreate,
    HandoverEventOut,
    HandoverOut,
    HandoverReject,
    SweepOut,
)
from app.db import get_session
from app.domain.models import HandoverEvent
from app.services import handovers as svc

router = APIRouter(prefix="/handovers", tags=["handovers 关键岗位交接"])


@router.post("", response_model=HandoverOut, status_code=201, summary="发起岗位交接")
def initiate(body: HandoverCreate, db: Session = Depends(get_session)) -> HandoverOut:
    h = svc.initiate_handover(
        db,
        job_id=body.job_id,
        position=body.position,
        outgoing_worker_id=body.outgoing_worker_id,
        incoming_worker_id=body.incoming_worker_id,
        initiated_by_worker_id=body.initiated_by_worker_id,
        timeout_seconds=body.timeout_seconds,
    )
    return serializers.handover_out(h)


# 注意：静态路径必须注册在 /{handover_id} 之前
@router.post("/sweep-expired", response_model=SweepOut, summary="扫描并关闭超时交接")
def sweep_expired(
    job_id: int | None = Query(None), db: Session = Depends(get_session)
) -> SweepOut:
    return SweepOut(expired_count=svc.sweep_expired(db, job_id=job_id))


@router.get("", response_model=list[HandoverOut], summary="交接单列表/筛选")
def list_handovers(
    job_id: int | None = Query(None),
    position: str | None = Query(None),
    db: Session = Depends(get_session),
) -> list[HandoverOut]:
    rows = svc.list_handovers(db, job_id=job_id, position=position)
    return [serializers.handover_out(h) for h in rows]


@router.get(
    "/chain",
    response_model=list[HandoverOut],
    summary="查询某作业某岗位的交接链（按链序）",
)
def chain(
    job_id: int = Query(...),
    position: str = Query(...),
    db: Session = Depends(get_session),
) -> list[HandoverOut]:
    rows = svc.handover_chain(db, job_id=job_id, position=position)
    return [serializers.handover_out(h) for h in rows]


@router.get("/{handover_id}", response_model=HandoverOut, summary="交接单详情（含审计事件）")
def retrieve(handover_id: int, db: Session = Depends(get_session)) -> HandoverOut:
    return serializers.handover_out(svc.get_handover(db, handover_id))


@router.post(
    "/{handover_id}/confirm",
    response_model=HandoverOut,
    summary="交班人/接班人确认（双向确认后原子切换；重复确认幂等）",
)
def confirm(
    handover_id: int,
    body: HandoverConfirm,
    db: Session = Depends(get_session),
) -> HandoverOut:
    h = svc.confirm_handover(
        db, handover_id=handover_id, worker_id=body.worker_id
    )
    return serializers.handover_out(h)


@router.post(
    "/{handover_id}/reject",
    response_model=HandoverOut,
    summary="拒绝交接（记录拒绝原因）",
)
def reject(
    handover_id: int,
    body: HandoverReject,
    db: Session = Depends(get_session),
) -> HandoverOut:
    h = svc.reject_handover(
        db,
        handover_id=handover_id,
        worker_id=body.worker_id,
        reason=body.reason,
    )
    return serializers.handover_out(h)


@router.get(
    "/{handover_id}/events",
    response_model=list[HandoverEventOut],
    summary="交接单审计事件（seq 顺序）",
)
def events(handover_id: int, db: Session = Depends(get_session)) -> list[HandoverEventOut]:
    svc.get_handover(db, handover_id)
    rows = db.scalars(
        select(HandoverEvent)
        .where(HandoverEvent.handover_id == handover_id)
        .order_by(HandoverEvent.seq)
    ).all()
    return [
        HandoverEventOut(
            seq=e.seq,
            event_type=e.event_type,
            actor_worker_id=e.actor_worker_id,
            detail=e.detail,
            created_at=e.created_at,
        )
        for e in rows
    ]
