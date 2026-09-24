import { HandoverStatus, Position, ReceiptType, TicketStatus } from './enums.js';

export interface Person {
  id: number;
  name: string;
  employee_no: string;
}

export interface Ticket {
  id: number;
  code: string;
  title: string;
  status: TicketStatus;
  planned_start: number;
  planned_end: number;
  created_at: number;
}

export interface Qualification {
  id: number;
  worker_id: number;
  position: Position;
  valid_from: number;
  valid_to: number;
}

export interface Assignment {
  id: number;
  ticket_id: number;
  position: Position;
  worker_id: number;
  started_at: number;
  ended_at: number | null;
  handover_id: number | null;
}

/** 发起交接时留存的责任快照条目 */
export interface ResponsibilitySnapshotEntry {
  position: Position;
  worker_id: number;
  assignment_id: number;
  started_at: number;
}

export interface Handover {
  id: number;
  ticket_id: number;
  position: Position;
  outgoing_worker_id: number;
  incoming_worker_id: number;
  initiated_by: number;
  status: HandoverStatus;
  initiated_at: number;
  confirm_deadline: number;
  outgoing_confirmed_at: number | null;
  incoming_confirmed_at: number | null;
  completed_at: number | null;
  rejected_by: number | null;
  rejected_at: number | null;
  reject_reason: string | null;
  timed_out_at: number | null;
  voided_at: number | null;
  prev_handover_id: number | null;
  responsibility_snapshot: ResponsibilitySnapshotEntry[];
  init_receipt_ref: string;
  completion_receipt_ref: string | null;
  created_audit_seq: number;
  completed_audit_seq: number | null;
}

export interface SimulationReceipt {
  id: number;
  ref: string;
  type: ReceiptType;
  ticket_id: number | null;
  handover_id: number | null;
  created_at: number;
  payload: Record<string, unknown>;
}

export interface AuditEntry {
  id: number;
  seq: number;
  event_type: string;
  ticket_id: number | null;
  handover_id: number | null;
  actor_id: number | null;
  occurred_at: number;
  payload: Record<string, unknown>;
}

export interface TicketClosure {
  id: number;
  ticket_id: number;
  closed_at: number;
  final_responsibility: ResponsibilitySnapshotEntry[];
  receipt_ref: string;
}
