"""领域枚举。

岗位、作业状态、交接状态等集中定义，值落库存字符串（英文稳定码），
中文标签仅用于展示与文档。
"""
from __future__ import annotations

import enum


class Position(str, enum.Enum):
    """作业必需的关键岗位。"""

    LEADER = "LEADER"        # 负责人
    SAFETY = "SAFETY"        # 安全员
    LIAISON = "LIAISON"      # 联络员（驻站联络）
    GUARD = "GUARD"          # 防护员（现场防护）

    @property
    def label(self) -> str:
        return _POSITION_LABELS[self]


_POSITION_LABELS = {
    Position.LEADER: "负责人",
    Position.SAFETY: "安全员",
    Position.LIAISON: "联络员",
    Position.GUARD: "防护员",
}


# 新建作业时默认要求覆盖的全部关键岗位
ALL_POSITIONS: tuple[Position, ...] = (
    Position.LEADER,
    Position.SAFETY,
    Position.LIAISON,
    Position.GUARD,
)


class JobStatus(str, enum.Enum):
    PLANNED = "PLANNED"      # 已开票未开工
    ACTIVE = "ACTIVE"        # 作业进行中（允许发起交接的唯一状态）
    CLOSED = "CLOSED"        # 已销记（不得再交接）


class HandoverStatus(str, enum.Enum):
    PENDING = "PENDING"          # 等待双向确认
    COMPLETED = "COMPLETED"      # 双确认完成，责任已原子切换
    REJECTED = "REJECTED"        # 任一方拒绝
    EXPIRED = "EXPIRED"          # 超时未完成双确认


class PartyStatus(str, enum.Enum):
    PENDING = "PENDING"
    CONFIRMED = "CONFIRMED"
    REJECTED = "REJECTED"


class ReceiptStatus(str, enum.Enum):
    ISSUED = "ISSUED"            # 交接发起时回执已出具
    CONFIRMED = "CONFIRMED"      # 交接完成，回执生效
    CANCELED = "CANCELED"        # 交接被拒绝或超时，回执作废


class HandoverEventType(str, enum.Enum):
    INITIATED = "INITIATED"                # 发起交接
    OUTGOING_CONFIRMED = "OUTGOING_CONFIRMED"
    INCOMING_CONFIRMED = "INCOMING_CONFIRMED"
    REJECTED = "REJECTED"
    COMPLETED = "COMPLETED"                # 双确认齐备，责任切换
    EXPIRED = "EXPIRED"
    BLOCKED = "BLOCKED"                    # 完成前复验未通过（不切换）


class JobEventType(str, enum.Enum):
    CREATED = "CREATED"
    STARTED = "STARTED"
    POSITION_ASSIGNED = "POSITION_ASSIGNED"
    POSITION_HANDED_OVER = "POSITION_HANDED_OVER"
    CLOSED = "CLOSED"
