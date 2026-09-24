"""模拟回执服务。

不接入真实外部系统：交接发起时“出具”回执，交接完成时回执生效，
拒绝/超时时回执作废。回执与交接一一关联并持久化，重启后仍可追溯。
"""
from __future__ import annotations

import secrets

from sqlalchemy.orm import Session

from app.domain.enums import ReceiptStatus
from app.domain.models import Handover, Receipt
from app.services import clock


def _receipt_no() -> str:
    return "RCP-" + secrets.token_hex(6).upper()


def issue_for_handover(
    db: Session,
    *,
    handover_ref: Handover,
    position: str,
    outgoing_worker_id: int,
    incoming_worker_id: int,
) -> Receipt:
    """发起交接时出具模拟回执。"""
    ts = clock.now()
    receipt = Receipt(
        receipt_no=_receipt_no(),
        status=ReceiptStatus.ISSUED.value,
        issued_at=ts,
        payload={
            "kind": "POSITION_HANDOVER",
            "job_id": handover_ref.job_id,
            "position": position,
            "outgoing_worker_id": outgoing_worker_id,
            "incoming_worker_id": incoming_worker_id,
            "issued_phase": "INITIATED",
            "simulated": True,
        },
    )
    db.add(receipt)
    db.flush()
    handover_ref.receipt_id = receipt.id
    return receipt


def settle(db: Session, receipt: Receipt, status: ReceiptStatus) -> None:
    receipt.status = status.value
    receipt.settled_at = clock.now()
