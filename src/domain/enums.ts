/**
 * 领域枚举与常量
 */

/** 工作票状态 */
export enum TicketStatus {
  /** 已创建（计划开工时间未到） */
  CREATED = 'CREATED',
  /** 作业进行中（计划开工后、销记前，唯一允许交接的状态） */
  IN_PROGRESS = 'IN_PROGRESS',
  /** 已销记 */
  CLOSED = 'CLOSED'
}

/** 必需关键岗位 */
export enum Position {
  /** 工作负责人 */
  LEADER = 'LEADER',
  /** 安全员 */
  SAFETY_OFFICER = 'SAFETY_OFFICER',
  /** 联络员 */
  LIAISON = 'LIAISON',
  /** 防护员 */
  GUARD = 'GUARD'
}

export const ALL_POSITIONS: readonly Position[] = [
  Position.LEADER,
  Position.SAFETY_OFFICER,
  Position.LIAISON,
  Position.GUARD
];

export const POSITION_LABEL: Record<Position, string> = {
  [Position.LEADER]: '负责人',
  [Position.SAFETY_OFFICER]: '安全员',
  [Position.LIAISON]: '联络员',
  [Position.GUARD]: '防护员'
};

/** 交接状态机 */
export enum HandoverStatus {
  /** 已发起，等待双向确认 */
  PENDING = 'PENDING',
  /** 交班人、接班人均已确认；原子责任切换已完成（终态） */
  COMPLETED = 'COMPLETED',
  /** 任一方明确拒绝（终态，责任不变） */
  REJECTED = 'REJECTED',
  /** 超过确认截止时间未完成双确认（终态，责任不变） */
  TIMED_OUT = 'TIMED_OUT',
  /** 工作票销记导致在途交接被作废（终态，责任不变） */
  VOIDED = 'VOIDED'
}

/** 交接确认方 */
export enum ConfirmParty {
  OUTGOING = 'OUTGOING',
  INCOMING = 'INCOMING'
}

/** 模拟回执类型 */
export enum ReceiptType {
  HANDOVER_INITIATED = 'HANDOVER_INITIATED',
  HANDOVER_COMPLETED = 'HANDOVER_COMPLETED',
  HANDOVER_REJECTED = 'HANDOVER_REJECTED',
  HANDOVER_TIMED_OUT = 'HANDOVER_TIMED_OUT',
  HANDOVER_VOIDED = 'HANDOVER_VOIDED',
  TICKET_CLOSED = 'TICKET_CLOSED'
}

export const TERMINAL_HANDOVER_STATUSES: ReadonlySet<HandoverStatus> = new Set([
  HandoverStatus.COMPLETED,
  HandoverStatus.REJECTED,
  HandoverStatus.TIMED_OUT,
  HandoverStatus.VOIDED
]);

/** 默认交接确认超时（毫秒，模拟时钟） */
export const DEFAULT_HANDOVER_TIMEOUT_MS = 30 * 60 * 1000;
