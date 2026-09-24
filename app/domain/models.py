"""ORM 模型。

关键不变量（由数据库约束与服务层事务共同保证）：

* 每个进行中作业的每个必需岗位在 ``assignments`` 中恰好有一条当前责任人记录
  （unique(job_id, position)），交接只做 UPDATE，不删除/不双写，
  因此任何时刻都不存在必需岗位短暂无人负责的窗口。
* 同一作业同一岗位至多存在一条未决交接
  （部分唯一索引 ``ux_pending_handover``）。
* 交接事件按 (handover_id, seq) 严格递增；作业级审计按 (job_id, seq)
  严格递增，顺序持久化，重启后保持一致。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from app.domain.enums import (
    HandoverStatus,
    JobStatus,
    PartyStatus,
    Position,
    ReceiptStatus,
)


class Base(DeclarativeBase):
    pass


def _enum_values(enum_cls) -> str:
    return ",".join(m.value for m in enum_cls)


class Worker(Base):
    """作业人员：资质（可担任的岗位）与到岗状态。"""

    __tablename__ = "workers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    employee_no: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    # 资质列表，元素为 Position 的字符串值，如 ["LEADER","SAFETY"]
    qualifications: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # 人员到岗记录（arrived_at 为空表示未到岗；离场后置空）
    arrived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class Job(Base):
    """作业票/工单。"""

    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[JobStatus] = mapped_column(
        String(16), nullable=False, default=JobStatus.PLANNED.value
    )
    # 计划开工时间与交接超时秒数
    planned_start_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    handover_timeout_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=300)

    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 销记责任快照：{position: {"worker_id":..., "employee_no":..., "name":...}}
    final_responsibility_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    final_handover_chain: Mapped[list | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    required_positions: Mapped[list["JobPosition"]] = relationship(
        back_populates="job", cascade="all, delete-orphan"
    )
    assignments: Mapped[list["Assignment"]] = relationship(back_populates="job")


class JobPosition(Base):
    """作业要求配置的必需岗位（开票时确定）。"""

    __tablename__ = "job_positions"
    __table_args__ = (UniqueConstraint("job_id", "position", name="ux_job_position"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id"), nullable=False)
    position: Mapped[Position] = mapped_column(String(16), nullable=False)

    job: Mapped[Job] = relationship(back_populates="required_positions")


class Assignment(Base):
    """岗位当前责任人。每个作业+岗位唯一一行；交接只更新 worker_id。"""

    __tablename__ = "assignments"
    __table_args__ = (
        UniqueConstraint("job_id", "position", name="ux_assignment_job_position"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id"), nullable=False)
    position: Mapped[Position] = mapped_column(String(16), nullable=False)
    worker_id: Mapped[int] = mapped_column(ForeignKey("workers.id"), nullable=False)
    # 本岗位交接链上的序号：初始责任人为 0，每完成一次交接 +1
    chain_seq: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    current_handover_id: Mapped[int | None] = mapped_column(
        ForeignKey("handovers.id", use_alter=True), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    job: Mapped[Job] = relationship(back_populates="assignments")


class Handover(Base):
    """关键岗位交接单。

    完成必须满足：交班人与接班人 *双向确认*，且完成瞬间复验
    接班人仍到岗、资质覆盖剩余作业窗口（开工后即视为资质覆盖
    作业全周期；此处以“当前仍具备该岗位资质 + 仍到岗”复验）。
    """

    __tablename__ = "handovers"
    __table_args__ = (
        # 同一作业同一岗位至多一条未决交接（PENDING）
        Index(
            "ux_pending_handover",
            "job_id",
            "position",
            unique=True,
            sqlite_where=text("status = 'PENDING'"),
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id"), nullable=False)
    position: Mapped[Position] = mapped_column(String(16), nullable=False)

    outgoing_worker_id: Mapped[int] = mapped_column(ForeignKey("workers.id"), nullable=False)
    incoming_worker_id: Mapped[int] = mapped_column(ForeignKey("workers.id"), nullable=False)
    initiated_by_worker_id: Mapped[int] = mapped_column(
        ForeignKey("workers.id"), nullable=False
    )

    status: Mapped[HandoverStatus] = mapped_column(
        String(16),
        nullable=False,
        default=HandoverStatus.PENDING.value,
    )

    outgoing_status: Mapped[PartyStatus] = mapped_column(
        String(16), nullable=False, default=PartyStatus.PENDING.value
    )
    incoming_status: Mapped[PartyStatus] = mapped_column(
        String(16), nullable=False, default=PartyStatus.PENDING.value
    )
    outgoing_confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )
    incoming_confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )

    # 责任快照（发起时固化，不变量证据）
    responsibility_snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)
    # 拒绝原因（任一 party 拒绝时记录）
    reject_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    rejected_by_worker_id: Mapped[int | None] = mapped_column(
        ForeignKey("workers.id"), nullable=True
    )

    initiated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # 交接链序号（同一作业+岗位，从 1 开始）
    chain_seq: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    # 模拟回执关联
    receipt_id: Mapped[int | None] = mapped_column(
        ForeignKey("receipts.id"), nullable=True
    )
    receipt: Mapped["Receipt | None"] = relationship(
        foreign_keys=[receipt_id], cascade="all"
    )

    events: Mapped[list["HandoverEvent"]] = relationship(
        back_populates="handover", cascade="all, delete-orphan"
    )


class Receipt(Base):
    """模拟回执：交接生命周期的外部凭证关联（非真实外部系统）。"""

    __tablename__ = "receipts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    receipt_no: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    status: Mapped[ReceiptStatus] = mapped_column(
        String(16), nullable=False, default=ReceiptStatus.ISSUED.value
    )
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    issued_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    settled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class HandoverEvent(Base):
    """交接单审计事件（交接链内顺序 seq）。"""

    __tablename__ = "handover_events"
    __table_args__ = (
        UniqueConstraint("handover_id", "seq", name="ux_handover_event_seq"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    handover_id: Mapped[int] = mapped_column(ForeignKey("handovers.id"), nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    event_type: Mapped[str] = mapped_column(String(32), nullable=False)
    actor_worker_id: Mapped[int | None] = mapped_column(
        ForeignKey("workers.id"), nullable=True
    )
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    handover: Mapped[Handover] = relationship(back_populates="events")


class JobEvent(Base):
    """作业级审计事件（作业内顺序 seq），重启后审计顺序以此为准。"""

    __tablename__ = "job_events"
    __table_args__ = (UniqueConstraint("job_id", "seq", name="ux_job_event_seq"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id"), nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    event_type: Mapped[str] = mapped_column(String(32), nullable=False)
    actor_worker_id: Mapped[int | None] = mapped_column(
        ForeignKey("workers.id"), nullable=True
    )
    handover_id: Mapped[int | None] = mapped_column(
        ForeignKey("handovers.id"), nullable=True
    )
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
