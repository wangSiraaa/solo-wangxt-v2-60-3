"""交接服务层 —— 全部业务规则与原子责任切换的唯一入口。

状态机（单个交接单）::

    PENDING ──双方 CONFIRMED──▶ COMPLETED   （同一事务内原子切换责任人）
      │  ├─ 任一方 REJECT ────▶ REJECTED
      │  └─ expires_at 到期 ──▶ EXPIRED     （迟到确认一律拒绝）

并发安全：写事务为 SQLite ``BEGIN IMMEDIATE``，完成动作为带状态谓词的
条件 UPDATE（以 rowcount 判定），因此重复确认/并发完成最多形成一次
COMPLETED 与一次责任人 UPDATE。
"""
from __future__ import annotations

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.domain.enums import (
    HandoverEventType,
    HandoverStatus,
    JobEventType,
    JobStatus,
    PartyStatus,
    Position,
    ReceiptStatus,
)
from app.domain.errors import (
    BadRequestError,
    CannotRejectError,
    EligibilityError,
    HandoverExpiredError,
    HandoverNotPendingError,
    InitiatorNotHolderError,
    JobNotActiveError,
    NotFoundError,
    PendingHandoverExistsError,
    PositionBusyError,
    RequiredPositionVacantError,
    UnauthorizedPartyError,
)
from app.domain.models import (
    Assignment,
    Handover,
    Job,
    JobPosition,
    Worker,
)
from app.services import audit, clock, receipts


# ---------------------------------------------------------------- 读取

def get_job(db: Session, job_id: int) -> Job:
    job = db.get(Job, job_id)
    if job is None:
        raise NotFoundError(f"作业 {job_id} 不存在", {"job_id": job_id})
    return job


def get_handover(db: Session, handover_id: int) -> Handover:
    h = db.get(Handover, handover_id)
    if h is None:
        raise NotFoundError(
            f"交接单 {handover_id} 不存在", {"handover_id": handover_id}
        )
    return h


def list_handovers(
    db: Session, *, job_id: int | None = None, position: str | None = None
) -> list[Handover]:
    stmt = select(Handover).order_by(Handover.job_id, Handover.chain_seq, Handover.id)
    if job_id is not None:
        stmt = stmt.where(Handover.job_id == job_id)
    if position is not None:
        stmt = stmt.where(Handover.position == position)
    return list(db.scalars(stmt).all())


def handover_chain(
    db: Session, *, job_id: int, position: str
) -> list[Handover]:
    """按交接链顺序返回某岗位的全部交接（含初始责任人，从 assignments 起链）。"""
    return list(
        db.scalars(
            select(Handover)
            .where(Handover.job_id == job_id, Handover.position == position)
            .order_by(Handover.chain_seq, Handover.id)
        ).all()
    )


def assignments_of(db: Session, job_id: int) -> list[Assignment]:
    return list(
        db.scalars(
            select(Assignment)
            .where(Assignment.job_id == job_id)
            .order_by(Assignment.position)
        ).all()
    )


# ---------------------------------------------------------------- 规则校验

def _validate_position(position: str) -> Position:
    try:
        return Position(position)
    except ValueError:
        raise BadRequestError(
            f"未知岗位: {position}", {"allowed": [p.value for p in Position]}
        )


def _job_required_positions(db: Session, job_id: int) -> set[str]:
    return set(
        db.scalars(
            select(JobPosition.position).where(JobPosition.job_id == job_id)
        ).all()
    )


def _assignment(db: Session, job_id: int, position: str) -> Assignment | None:
    return db.scalar(
        select(Assignment).where(
            Assignment.job_id == job_id, Assignment.position == position
        )
    )


def _is_arrived(worker: Worker) -> bool:
    return worker.arrived_at is not None


def _check_incoming_eligible(
    db: Session, job: Job, position: str, incoming: Worker
) -> None:
    """接班人：到岗、资质覆盖、且未占用该作业其他必需岗位。

    开工后发起的交接，剩余作业窗口是作业窗口的子集；接班人具备该岗位
    资质即视为覆盖剩余窗口（资质按作业全周期有效，无单独到期建模）。
    """
    problems: list[str] = []
    if not _is_arrived(incoming):
        problems.append("NOT_ARRIVED")
    if position not in (incoming.qualifications or []):
        problems.append("QUALIFICATION_MISMATCH")

    other = db.scalar(
        select(Assignment).where(
            Assignment.job_id == job.id,
            Assignment.worker_id == incoming.id,
            Assignment.position != position,
        )
    )
    if other is not None:
        problems.append("HOLDS_OTHER_POSITION")

    if problems:
        raise EligibilityError(
            "接班人不满足交接条件（未到岗/资质不足/已占用其他必需岗位）",
            {
                "incoming_worker_id": incoming.id,
                "position": position,
                "problems": problems,
            },
        )


def _expire_due_pending(db: Session, job_id: int | None = None) -> list[Handover]:
    """惰性超时：把已到期的 PENDING 单标记 EXPIRED（不释放写事务一致性）。"""
    now_ts = clock.now()
    stmt = select(Handover).where(
        Handover.status == HandoverStatus.PENDING.value,
        Handover.expires_at <= now_ts,
    )
    if job_id is not None:
        stmt = stmt.where(Handover.job_id == job_id)
    due = list(db.scalars(stmt).all())
    for h in due:
        _mark_expired(db, h)
    if due:
        db.flush()
    return due


def _mark_expired(db: Session, h: Handover) -> bool:
    """条件 UPDATE 置 EXPIRED；返回是否由本次调用完成状态迁移。"""
    result = db.execute(
        update(Handover)
        .where(Handover.id == h.id, Handover.status == HandoverStatus.PENDING.value)
        .values(status=HandoverStatus.EXPIRED.value)
    )
    if result.rowcount == 0:
        return False

    db.execute(
        update(Assignment)
        .where(
            Assignment.job_id == h.job_id,
            Assignment.position == h.position,
            Assignment.current_handover_id == h.id,
        )
        .values(current_handover_id=None)
    )
    if h.receipt is not None:
        receipts.settle(db, h.receipt, ReceiptStatus.CANCELED)
    audit.add_handover_event(
        db, handover_id=h.id, event_type=HandoverEventType.EXPIRED.value,
        detail={"expires_at": h.expires_at.isoformat(), "settled_at": clock.now().isoformat()},
    )
    audit.add_job_event(
        db, job_id=h.job_id, event_type=JobEventType.POSITION_HANDED_OVER.value,
        handover_id=h.id,
        detail={"position": h.position, "outcome": HandoverStatus.EXPIRED.value},
    )
    h.status = HandoverStatus.EXPIRED.value
    return True


def sweep_expired(db: Session, *, job_id: int | None = None) -> int:
    """显式超时扫描（运维端点）。"""
    try:
        expired = _expire_due_pending(db, job_id=job_id)
        db.commit()
        return len(expired)
    except Exception:
        db.rollback()
        raise


# ---------------------------------------------------------------- 发起

def initiate_handover(
    db: Session,
    *,
    job_id: int,
    position: str,
    outgoing_worker_id: int,
    incoming_worker_id: int,
    initiated_by_worker_id: int,
    timeout_seconds: int | None = None,
) -> Handover:
    pos = _validate_position(position)
    try:
        job = get_job(db, job_id)
        if job.status != JobStatus.ACTIVE.value:
            raise JobNotActiveError(
                "作业销记或未开工，不能发起交接"
                if job.status == JobStatus.CLOSED.value
                else "作业尚未开工，计划开工后才能发起交接",
                {"job_id": job_id, "job_status": job.status},
            )

        required = _job_required_positions(db, job_id)
        if pos.value not in required:
            raise BadRequestError(
                f"{pos.label}不是该作业配置的必需岗位",
                {"position": pos.value, "required": sorted(required)},
            )

        # 惰性超时，先释放到期未决单
        _expire_due_pending(db, job_id=job_id)

        assignment = _assignment(db, job_id, pos.value)
        if assignment is None:
            raise RequiredPositionVacantError(
                f"{pos.label}当前无人负责，不能发起交接",
                {"position": pos.value},
            )

        outgoing = db.get(Worker, outgoing_worker_id)
        incoming = db.get(Worker, incoming_worker_id)
        initiator = db.get(Worker, initiated_by_worker_id)
        if outgoing is None or incoming is None or initiator is None:
            raise NotFoundError(
                "交班人/接班人/发起人不存在",
                {
                    "outgoing_worker_id": outgoing_worker_id,
                    "incoming_worker_id": incoming_worker_id,
                    "initiated_by_worker_id": initiated_by_worker_id,
                },
            )

        if assignment.worker_id != outgoing.id:
            raise PositionBusyError(
                f"{pos.label}当前责任人与交班人不一致",
                {
                    "position": pos.value,
                    "current_worker_id": assignment.worker_id,
                    "outgoing_worker_id": outgoing.id,
                },
            )
        if outgoing.id == incoming.id:
            raise BadRequestError("交班人与接班人不能为同一人")
        if initiated_by_worker_id not in (outgoing.id, incoming.id):
            raise InitiatorNotHolderError(
                "只有交班人或接班人本人可以发起该岗位交接",
                {"initiated_by_worker_id": initiated_by_worker_id},
            )

        # 接班人前置校验：到岗 + 资质覆盖剩余窗口 + 不占用其他必需岗位
        _check_incoming_eligible(db, job, pos.value, incoming)

        existing = db.scalar(
            select(Handover).where(
                Handover.job_id == job_id,
                Handover.position == pos.value,
                Handover.status == HandoverStatus.PENDING.value,
            )
        )
        if existing is not None:
            raise PendingHandoverExistsError(
                f"{pos.label}已存在未决交接 {existing.id}",
                {"existing_handover_id": existing.id},
            )

        ts = clock.now()
        ttl = timeout_seconds or job.handover_timeout_seconds
        snapshot = audit.build_responsibility_snapshot(db, job)

        handover = Handover(
            job_id=job.id,
            position=pos.value,
            outgoing_worker_id=outgoing.id,
            incoming_worker_id=incoming.id,
            initiated_by_worker_id=initiator.id,
            status=HandoverStatus.PENDING.value,
            outgoing_status=PartyStatus.PENDING.value,
            incoming_status=PartyStatus.PENDING.value,
            responsibility_snapshot=snapshot,
            initiated_at=ts,
            expires_at=ts + job_timedelta(ttl),
            chain_seq=assignment.chain_seq + 1,
        )
        db.add(handover)
        db.flush()

        receipts.issue_for_handover(
            db,
            handover_ref=handover,
            position=pos.value,
            outgoing_worker_id=outgoing.id,
            incoming_worker_id=incoming.id,
        )
        assignment.current_handover_id = handover.id
        assignment.updated_at = ts

        audit.add_handover_event(
            db, handover_id=handover.id,
            event_type=HandoverEventType.INITIATED.value,
            actor_worker_id=initiator.id,
            detail={
                "outgoing_worker_id": outgoing.id,
                "incoming_worker_id": incoming.id,
                "expires_at": handover.expires_at.isoformat(),
                "responsibility_snapshot": snapshot,
            },
        )
        audit.add_job_event(
            db, job_id=job.id,
            event_type=HandoverEventType.INITIATED.value,
            actor_worker_id=initiator.id, handover_id=handover.id,
            detail={"position": pos.value},
        )
        db.commit()
        db.refresh(handover)
        return handover
    except Exception:
        db.rollback()
        raise


def job_timedelta(seconds: int):
    from datetime import timedelta

    return timedelta(seconds=seconds)


# ---------------------------------------------------------------- 确认 / 拒绝

def _pending_or_die(db: Session, h: Handover) -> None:
    """加载后惰性判定 PENDING；过期/已决全部拒绝写操作。"""
    if h.status != HandoverStatus.PENDING.value:
        if h.status == HandoverStatus.EXPIRED.value:
            raise HandoverExpiredError(
                "交接已超时，迟到确认不能夺取责任",
                {"handover_id": h.id, "expires_at": h.expires_at.isoformat()},
            )
        raise HandoverNotPendingError(
            f"交接单当前状态为 {h.status}，不能重复操作",
            {"handover_id": h.id, "status": h.status},
        )
    if clock.now() >= h.expires_at:
        _mark_expired(db, h)
        db.commit()
        raise HandoverExpiredError(
            "交接已超时，迟到确认不能夺取责任",
            {"handover_id": h.id, "expires_at": h.expires_at.isoformat()},
        )


def confirm_handover(
    db: Session, *, handover_id: int, worker_id: int
) -> Handover:
    # 仅做参与方鉴权（不据此判断状态；PENDING/超时/已决全部以下方
    # IMMEDIATE 写事务内的加权重读为准，避免读视图过期）。
    h_ro = get_handover(db, handover_id)
    if worker_id not in (h_ro.outgoing_worker_id, h_ro.incoming_worker_id):
        raise UnauthorizedPartyError(
            "只有交班人或接班人本人可以确认",
            {"handover_id": handover_id, "worker_id": worker_id},
        )
    db.rollback()  # 结束只读事务，释放连接，进入下方写事务

    try:
        # ---- 单写事务（begin 事件钩子自动发出 BEGIN IMMEDIATE）----
        # 事务内重新读取行状态（含对方可能已提交的确认），
        # 从而保证“双方并发确认”时恰好有一个事务观察到双确认并完成切换。
        h = db.execute(
            select(Handover)
            .where(Handover.id == handover_id)
            .with_for_update()
        ).scalar_one()

        if h.status == HandoverStatus.COMPLETED.value:
            # 并发窗口内已被另一事务完成：幂等返回
            db.rollback()
            return get_handover(db, handover_id)
        if h.status != HandoverStatus.PENDING.value:
            if h.status == HandoverStatus.EXPIRED.value:
                raise HandoverExpiredError(
                    "交接已超时，迟到确认不能夺取责任",
                    {"handover_id": handover_id,
                     "expires_at": h.expires_at.isoformat()},
                )
            raise HandoverNotPendingError(
                f"交接单当前状态为 {h.status}，不能重复操作",
                {"handover_id": handover_id, "status": h.status},
            )
        if clock.now() >= h.expires_at:
            _mark_expired(db, h)
            db.commit()  # 固化超时状态，随后以业务错误拒绝迟到确认
            raise HandoverExpiredError(
                "交接已超时，迟到确认不能夺取责任",
                {"handover_id": handover_id,
                 "expires_at": h.expires_at.isoformat()},
            )

        is_outgoing = worker_id == h.outgoing_worker_id
        own_status = h.outgoing_status if is_outgoing else h.incoming_status
        other_status = h.incoming_status if is_outgoing else h.outgoing_status

        # 同一方重复确认：幂等返回，不新增事件
        if own_status == PartyStatus.CONFIRMED.value:
            db.rollback()
            return get_handover(db, handover_id)

        will_complete = other_status == PartyStatus.CONFIRMED.value

        # 本次确认将凑齐双向确认：先复验资格。不通过则只固化 BLOCKED
        # 审计事件，本次确认与责任切换全部不落库（不产生部分切换）。
        if will_complete:
            job = get_job(db, h.job_id)
            incoming = db.get(Worker, h.incoming_worker_id)
            try:
                _check_incoming_eligible(db, job, h.position, incoming)
            except EligibilityError as exc:
                audit.add_handover_event(
                    db, handover_id=h.id,
                    event_type=HandoverEventType.BLOCKED.value,
                    actor_worker_id=worker_id,
                    detail={"reason": exc.message, **exc.details},
                )
                # 仅提交 BLOCKED 审计，本次确认与切换不落库
                db.commit()
                raise

        ts = clock.now()
        if is_outgoing:
            h.outgoing_status = PartyStatus.CONFIRMED.value
            h.outgoing_confirmed_at = ts
            event_type = HandoverEventType.OUTGOING_CONFIRMED.value
        else:
            h.incoming_status = PartyStatus.CONFIRMED.value
            h.incoming_confirmed_at = ts
            event_type = HandoverEventType.INCOMING_CONFIRMED.value

        audit.add_handover_event(
            db, handover_id=h.id, event_type=event_type,
            actor_worker_id=worker_id,
        )
        db.flush()

        if will_complete:
            # 在同一事务内完成原子责任切换
            _complete_handover_locked(db, h)

        db.commit()
        return get_handover(db, handover_id)
    except Exception:
        db.rollback()
        raise


def reject_handover(
    db: Session, *, handover_id: int, worker_id: int, reason: str
) -> Handover:
    reason = (reason or "").strip()
    if not reason:
        raise BadRequestError("拒绝交接必须填写拒绝原因")
    try:
        h = get_handover(db, handover_id)
        if worker_id not in (h.outgoing_worker_id, h.incoming_worker_id):
            raise UnauthorizedPartyError(
                "只有交班人或接班人本人可以拒绝",
                {"handover_id": h.id, "worker_id": worker_id},
            )
        if h.status == HandoverStatus.COMPLETED.value:
            raise CannotRejectError("交接已完成，不能拒绝")
        _pending_or_die(db, h)

        if worker_id == h.outgoing_worker_id:
            if h.outgoing_status == PartyStatus.CONFIRMED.value:
                raise CannotRejectError("交班人已确认，不能再拒绝")
            h.outgoing_status = PartyStatus.REJECTED.value
        else:
            if h.incoming_status == PartyStatus.CONFIRMED.value:
                raise CannotRejectError("接班人已确认，不能再拒绝")
            h.incoming_status = PartyStatus.REJECTED.value

        if (
            h.outgoing_status == PartyStatus.CONFIRMED.value
            and h.incoming_status == PartyStatus.CONFIRMED.value
        ):  # 理论不可达：双确认会立即完成
            raise CannotRejectError("双方均已确认，交接完成，不能拒绝")

        result = db.execute(
            update(Handover)
            .where(Handover.id == h.id, Handover.status == HandoverStatus.PENDING.value)
            .values(
                status=HandoverStatus.REJECTED.value,
                reject_reason=reason,
                rejected_by_worker_id=worker_id,
            )
        )
        if result.rowcount == 0:
            raise HandoverNotPendingError(
                "交接状态已变化，拒绝未生效", {"handover_id": h.id}
            )
        h.status = HandoverStatus.REJECTED.value
        h.reject_reason = reason
        h.rejected_by_worker_id = worker_id

        db.execute(
            update(Assignment)
            .where(
                Assignment.job_id == h.job_id,
                Assignment.position == h.position,
                Assignment.current_handover_id == h.id,
            )
            .values(current_handover_id=None)
        )
        if h.receipt is not None:
            receipts.settle(db, h.receipt, ReceiptStatus.CANCELED)

        audit.add_handover_event(
            db, handover_id=h.id,
            event_type=HandoverEventType.REJECTED.value,
            actor_worker_id=worker_id, detail={"reason": reason},
        )
        audit.add_job_event(
            db, job_id=h.job_id,
            event_type=HandoverEventType.REJECTED.value,
            actor_worker_id=worker_id, handover_id=h.id,
            detail={"position": h.position, "reason": reason},
        )
        db.commit()
        db.refresh(h)
        return h
    except Exception:
        db.rollback()
        raise


def _complete_handover_locked(db: Session, h: Handover) -> None:
    """双确认齐备时的原子完成：条件置完成 → 原子切换责任人。

    调用方必须已持有 IMMEDIATE 写事务，且调用前已完成接班人复验。
    任何不变量异常都会触发调用方回滚，宁可不切换也不留不确定状态。
    """
    # 1) 条件置完成：只有仍是 PENDING 且双方都 CONFIRMED 才成功
    result = db.execute(
        update(Handover)
        .where(
            Handover.id == h.id,
            Handover.status == HandoverStatus.PENDING.value,
            Handover.outgoing_status == PartyStatus.CONFIRMED.value,
            Handover.incoming_status == PartyStatus.CONFIRMED.value,
        )
        .values(status=HandoverStatus.COMPLETED.value, completed_at=clock.now())
    )
    if result.rowcount == 0:
        # 并发场景：另一个事务已经完成/否决/超时本单 —— 不重复切换
        raise HandoverNotPendingError(
            "并发完成冲突，交接已被另一事务处理",
            {"handover_id": h.id},
        )
    h.status = HandoverStatus.COMPLETED.value
    h.completed_at = clock.now()

    # 2) 原子切换责任人（谓词保证当前仍是交班人；UPDATE 期间不存在空岗）
    swap = db.execute(
        update(Assignment)
        .where(
            Assignment.job_id == h.job_id,
            Assignment.position == h.position,
            Assignment.worker_id == h.outgoing_worker_id,
        )
        .values(
            worker_id=h.incoming_worker_id,
            chain_seq=Assignment.chain_seq + 1,
            current_handover_id=None,
            updated_at=clock.now(),
        )
    )
    if swap.rowcount != 1:
        raise RequiredPositionVacantError(
            "责任切换失败：岗位责任人与交班人不一致",
            {"job_id": h.job_id, "position": h.position},
        )

    if h.receipt is not None:
        receipts.settle(db, h.receipt, ReceiptStatus.CONFIRMED)

    job = get_job(db, h.job_id)
    after_snapshot = audit.build_responsibility_snapshot(db, job)
    audit.add_handover_event(
        db, handover_id=h.id, event_type=HandoverEventType.COMPLETED.value,
        detail={
            "completed_at": h.completed_at.isoformat(),
            "responsibility_after": after_snapshot,
        },
    )
    audit.add_job_event(
        db, job_id=h.job_id,
        event_type=JobEventType.POSITION_HANDED_OVER.value,
        handover_id=h.id,
        detail={
            "position": h.position,
            "outgoing_worker_id": h.outgoing_worker_id,
            "incoming_worker_id": h.incoming_worker_id,
            "chain_seq": h.chain_seq,
            "responsibility_after": after_snapshot,
        },
    )
