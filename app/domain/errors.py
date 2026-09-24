"""领域错误与错误码。"""
from __future__ import annotations

from typing import Any


class DomainError(Exception):
    """所有可预期业务错误的基类，由 API 层统一转成 JSON 响应。"""

    http_status: int = 400
    code: str = "DOMAIN_ERROR"

    def __init__(self, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}


class NotFoundError(DomainError):
    http_status = 404
    code = "NOT_FOUND"


class ConflictError(DomainError):
    http_status = 409
    code = "CONFLICT"


class ValidationFailure(DomainError):
    http_status = 422
    code = "VALIDATION_FAILED"


class JobNotActiveError(ConflictError):
    code = "JOB_NOT_ACTIVE"


class PendingHandoverExistsError(ConflictError):
    code = "PENDING_HANDOVER_EXISTS"


class HandoverNotPendingError(ConflictError):
    code = "HANDOVER_NOT_PENDING"


class HandoverExpiredError(ConflictError):
    code = "HANDOVER_EXPIRED"


class UnauthorizedPartyError(ConflictError):
    code = "NOT_HANDOVER_PARTY"


class AlreadyConfirmedError(ConflictError):
    code = "ALREADY_CONFIRMED"


class CannotRejectError(ConflictError):
    code = "CANNOT_REJECT"


class EligibilityError(ValidationFailure):
    """接班人不满足到岗/资质/窗口/占用等前置条件。"""

    code = "INCOMING_NOT_ELIGIBLE"


class InitiatorNotHolderError(ValidationFailure):
    code = "INITIATOR_NOT_HOLDER"


class PositionBusyError(ConflictError):
    code = "POSITION_BUSY"


class PendingHandoverBlocksCloseError(ConflictError):
    code = "PENDING_HANDOVER_BLOCKS_CLOSE"


class RequiredPositionVacantError(ConflictError):
    code = "REQUIRED_POSITION_VACANT"


class BadRequestError(DomainError):
    http_status = 400
    code = "BAD_REQUEST"
