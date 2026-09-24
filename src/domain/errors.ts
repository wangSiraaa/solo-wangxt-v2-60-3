/**
 * 统一领域错误：携带稳定 errorCode 与 HTTP 状态，便于 API 与测试断言。
 */
export class DomainError extends Error {
  constructor(
    public readonly errorCode: string,
    message: string,
    public readonly httpStatus: number = 400,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const Errors = {
  notFound: (what: string) => new DomainError('NOT_FOUND', `${what}不存在`, 404),
  ticketNotInProgress: (state: string) =>
    new DomainError('TICKET_NOT_IN_PROGRESS', `工作票当前状态 ${state} 不允许该操作，仅作业进行中可交接`, 409, { state }),
  beforePlannedStart: (now: number, startAt: number) =>
    new DomainError('BEFORE_PLANNED_START', '计划开工时间未到，不能发起交接', 409, { now, startAt }),
  ticketClosed: () => new DomainError('TICKET_CLOSED', '工作票已销记，不得再交接', 409),
  positionNotRequired: (position: string) =>
    new DomainError('POSITION_NOT_REQUIRED', `岗位 ${position} 不是该工作票的必需岗位`, 400, { position }),
  positionNotAssigned: (position: string) =>
    new DomainError('POSITION_NOT_ASSIGNED', `必需岗位 ${position} 当前无人负责，无法交接`, 409, { position }),
  outgoingNotCurrent: (workerId: number) =>
    new DomainError('OUTGOING_NOT_CURRENT', `交班人 ${workerId} 已不是该岗位当前责任人（可能已被其他交接替换）`, 409, { workerId }),
  incomingSameAsOutgoing: () =>
    new DomainError('INCOMING_SAME_AS_OUTGOING', '接班人不能与交班人为同一人', 400),
  incomingHoldsOtherPosition: (workerId: number, otherPosition: string) =>
    new DomainError('INCOMING_HOLDS_OTHER_POSITION', `接班人 ${workerId} 已担任本票另一必需岗位，会造成兼任冲突`, 409, { workerId, otherPosition }),
  incomingNotArrived: (workerId: number) =>
    new DomainError('INCOMING_NOT_ARRIVED', `接班人 ${workerId} 尚未到岗登记`, 409, { workerId }),
  qualificationInsufficient: (workerId: number, position: string, reason: string) =>
    new DomainError('QUALIFICATION_INSUFFICIENT', `接班人 ${workerId} 不具备岗位 ${position} 覆盖剩余作业窗口的资格：${reason}`, 422, {
      workerId,
      position,
      reason
    }),
  pendingHandoverExists: (handoverId: number) =>
    new DomainError('PENDING_HANDOVER_EXISTS', '该岗位已有在途交接，必须先完成、拒绝或等待超时', 409, { handoverId }),
  handoverNotPending: (status: string) =>
    new DomainError('HANDOVER_NOT_PENDING', `交接当前状态为 ${status}，不能再确认或拒绝`, 409, { status }),
  handoverTimedOut: (deadline: number) =>
    new DomainError('HANDOVER_TIMED_OUT', '交接确认已超时，迟到确认不能夺取责任', 409, { deadline }),
  partyMismatch: (party: string) =>
    new DomainError('PARTY_MISMATCH', `确认人不是该交接的${party}`, 403, { party }),
  rejectReasonRequired: () =>
    new DomainError('REJECT_REASON_REQUIRED', '拒绝交接必须填写原因', 400),
  pendingHandoversBlockClose: (ids: number[]) =>
    new DomainError('PENDING_HANDOVERS_BLOCK_CLOSE', '存在在途交接时不能销记；请先完成或拒绝交接', 409, { handoverIds: ids }),
  invalidPayload: (message: string, details?: Record<string, unknown>) =>
    new DomainError('INVALID_PAYLOAD', message, 400, details)
} as const;
