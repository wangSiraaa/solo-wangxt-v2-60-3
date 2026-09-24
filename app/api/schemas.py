"""API 请求/响应模型（Pydantic v2）。"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


PositionValue = Literal["LEADER", "SAFETY", "LIAISON", "GUARD"]


class ErrorBody(BaseModel):
    error: dict[str, Any]


# ---------------------------------------------------------------- workers

class WorkerCreate(BaseModel):
    employee_no: str = Field(..., min_length=1, max_length=64, examples=["E1001"])
    name: str = Field(..., min_length=1, max_length=128, examples=["张三"])
    qualifications: list[PositionValue] = Field(
        default_factory=list, description="可担任岗位（资质）"
    )
    arrived: bool = Field(False, description="是否立即到岗")


class WorkerOut(BaseModel):
    id: int
    employee_no: str
    name: str
    qualifications: list[str]
    arrived: bool
    arrived_at: datetime | None = None
    created_at: datetime


# ---------------------------------------------------------------- jobs

class JobCreate(BaseModel):
    code: str = Field(..., min_length=1, max_length=64, examples=["WP-2026-0001"])
    title: str = Field(..., min_length=1, max_length=255)
    positions: list[PositionValue] | None = Field(
        None, description="必需岗位；缺省为负责人/安全员/联络员/防护员四岗"
    )
    planned_start_at: datetime | None = None
    handover_timeout_seconds: int = Field(
        300, ge=30, le=86400, description="交接确认超时秒数"
    )


class JobStart(BaseModel):
    actor_worker_id: int | None = None


class AssignmentCreate(BaseModel):
    position: PositionValue
    worker_id: int
    require_qualification: bool = True


class AssignmentOut(BaseModel):
    id: int
    job_id: int
    position: str
    position_label: str
    worker_id: int
    worker_name: str
    chain_seq: int
    current_handover_id: int | None = None
    updated_at: datetime


class JobOut(BaseModel):
    id: int
    code: str
    title: str
    status: str
    positions: list[str]
    planned_start_at: datetime | None = None
    handover_timeout_seconds: int
    started_at: datetime | None = None
    closed_at: datetime | None = None
    final_responsibility_snapshot: dict[str, Any] | None = None
    final_handover_chain: list[Any] | None = None
    created_at: datetime
    assignments: list[AssignmentOut] = Field(default_factory=list)


# ---------------------------------------------------------------- handovers

class HandoverCreate(BaseModel):
    job_id: int
    position: PositionValue
    outgoing_worker_id: int = Field(..., description="交班人（当前责任人）")
    incoming_worker_id: int = Field(..., description="接班人")
    initiated_by_worker_id: int = Field(
        ..., description="发起人，必须是交班人或接班人本人"
    )
    timeout_seconds: int | None = Field(
        None, ge=30, le=86400, description="覆盖作业默认交接超时"
    )


class HandoverConfirm(BaseModel):
    worker_id: int


class HandoverReject(BaseModel):
    worker_id: int
    reason: str = Field(..., min_length=1, description="拒绝原因（必填）")


class ReceiptOut(BaseModel):
    id: int
    receipt_no: str
    status: str
    payload: dict[str, Any]
    issued_at: datetime
    settled_at: datetime | None = None


class HandoverEventOut(BaseModel):
    seq: int
    event_type: str
    actor_worker_id: int | None = None
    detail: dict[str, Any] | None = None
    created_at: datetime


class HandoverOut(BaseModel):
    id: int
    job_id: int
    position: str
    position_label: str
    outgoing_worker_id: int
    incoming_worker_id: int
    initiated_by_worker_id: int
    status: str
    outgoing_status: str
    incoming_status: str
    outgoing_confirmed_at: datetime | None = None
    incoming_confirmed_at: datetime | None = None
    reject_reason: str | None = None
    rejected_by_worker_id: int | None = None
    responsibility_snapshot: dict[str, Any]
    chain_seq: int
    initiated_at: datetime
    expires_at: datetime
    completed_at: datetime | None = None
    expired: bool = Field(..., description="按当前时钟是否已到超时时刻")
    receipt: ReceiptOut | None = None
    events: list[HandoverEventOut] = Field(default_factory=list)


class JobEventOut(BaseModel):
    seq: int
    event_type: str
    actor_worker_id: int | None = None
    handover_id: int | None = None
    detail: dict[str, Any] | None = None
    created_at: datetime


class SweepOut(BaseModel):
    expired_count: int
