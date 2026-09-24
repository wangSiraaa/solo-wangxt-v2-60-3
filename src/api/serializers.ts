import { HandoverStatus, POSITION_LABEL, Position, ReceiptType, TicketStatus } from '../domain/enums.js';
import type { AuditEntry, Handover, Person, ResponsibilitySnapshotEntry, SimulationReceipt, Ticket, TicketClosure } from '../domain/types.js';

/** 领域对象 → 对外 JSON（时间戳同时附 ISO，岗位附中文标签） */

export function personOut(p: Person) {
  return { id: p.id, name: p.name, employee_no: p.employee_no };
}

export function ticketOut(t: Ticket, positions?: Position[], closure?: TicketClosure | null) {
  return {
    id: t.id,
    code: t.code,
    title: t.title,
    status: t.status,
    planned_start: { epoch_ms: t.planned_start, iso: new Date(t.planned_start).toISOString() },
    planned_end: { epoch_ms: t.planned_end, iso: new Date(t.planned_end).toISOString() },
    required_positions: positions?.map(positionOut),
    closure: closure ? closureOut(closure) : null
  };
}

export function positionOut(p: Position) {
  return { code: p, label: POSITION_LABEL[p] };
}

export function responsibilityOut(entries: ResponsibilitySnapshotEntry[]) {
  return entries.map((e) => ({
    position: positionOut(e.position),
    worker_id: e.worker_id,
    assignment_id: e.assignment_id,
    since: { epoch_ms: e.started_at, iso: new Date(e.started_at).toISOString() }
  }));
}

export function handoverOut(h: Handover) {
  return {
    id: h.id,
    ticket_id: h.ticket_id,
    position: positionOut(h.position),
    outgoing_worker_id: h.outgoing_worker_id,
    incoming_worker_id: h.incoming_worker_id,
    initiated_by: h.initiated_by,
    status: h.status,
    initiated_at: tsOut(h.initiated_at),
    confirm_deadline: tsOut(h.confirm_deadline),
    outgoing_confirmed_at: tsOut(h.outgoing_confirmed_at),
    incoming_confirmed_at: tsOut(h.incoming_confirmed_at),
    completed_at: tsOut(h.completed_at),
    timed_out_at: tsOut(h.timed_out_at),
    voided_at: tsOut(h.voided_at),
    rejected: h.rejected_at
      ? { by: h.rejected_by, at: tsOut(h.rejected_at), reason: h.reject_reason }
      : null,
    prev_handover_id: h.prev_handover_id,
    responsibility_snapshot: responsibilityOut(h.responsibility_snapshot),
    receipts: { init: h.init_receipt_ref, completion: h.completion_receipt_ref },
    audit: { created_seq: h.created_audit_seq, completed_seq: h.completed_audit_seq },
    requires: {
      both_confirmations: true,
      terminal: h.status !== HandoverStatus.PENDING
    }
  };
}

export function receiptOut(r: SimulationReceipt) {
  return {
    id: r.id,
    ref: r.ref,
    type: r.type,
    ticket_id: r.ticket_id,
    handover_id: r.handover_id,
    created_at: tsOut(r.created_at),
    payload: r.payload
  };
}

export function auditOut(a: AuditEntry) {
  return {
    seq: a.seq,
    event_type: a.event_type,
    ticket_id: a.ticket_id,
    handover_id: a.handover_id,
    actor_id: a.actor_id,
    occurred_at: tsOut(a.occurred_at),
    payload: a.payload
  };
}

export function closureOut(c: TicketClosure) {
  return {
    closed_at: tsOut(c.closed_at),
    final_responsibility: responsibilityOut(c.final_responsibility),
    receipt_ref: c.receipt_ref
  };
}

function tsOut(ms: number | null | undefined) {
  return ms === null || ms === undefined ? null : { epoch_ms: ms, iso: new Date(ms).toISOString() };
}

export const enumsOut = {
  TicketStatus,
  HandoverStatus,
  Position,
  ReceiptType
};
