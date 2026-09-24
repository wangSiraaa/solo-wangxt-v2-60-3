import type { DbHandle } from '../db/index.js';
import { Clock } from '../domain/clock.js';
import { Errors } from '../domain/errors.js';
import { HandoverStatus, Position, ReceiptType, TicketStatus } from '../domain/enums.js';
import type { ResponsibilitySnapshotEntry, Ticket, TicketClosure } from '../domain/types.js';
import { CatalogService } from './catalog.js';
import { LedgerService } from './ledger.js';

interface TicketRow {
  id: number;
  code: string;
  title: string;
  status: TicketStatus;
  planned_start: number;
  planned_end: number;
  created_at: number;
}

/**
 * 工作票生命周期：创建（必需岗位配置）→ 计划开工后进入作业中 → 销记。
 * 责任人指派与责任快照亦在此维护，供交接服务调用。
 */
export class TicketService {
  constructor(
    private readonly handle: DbHandle,
    private readonly clock: Clock,
    private readonly catalog: CatalogService,
    private readonly ledger: LedgerService
  ) {}

  createTicket(input: {
    code: string;
    title: string;
    plannedStart: number;
    plannedEnd: number;
    positions: Position[];
  }): Ticket {
    if (input.plannedEnd <= input.plannedStart) throw Errors.invalidPayload('计划完工必须晚于计划开工');
    if (input.positions.length === 0) throw Errors.invalidPayload('工作票至少包含一个必需岗位');

    return this.handle.txn(() => {
      const now = this.clock.now();
      const info = this.handle.db
        .prepare(
          `INSERT INTO tickets (code, title, status, planned_start, planned_end, created_at)
           VALUES (?, ?, 'CREATED', ?, ?, ?)`
        )
        .run(input.code, input.title, input.plannedStart, input.plannedEnd, now);
      const ticketId = Number(info.lastInsertRowid);
      const insertPos = this.handle.db.prepare('INSERT INTO required_positions (ticket_id, position) VALUES (?, ?)');
      for (const position of new Set(input.positions)) insertPos.run(ticketId, position);
      this.ledger.record({
        eventType: 'TICKET_CREATED',
        ticketId,
        payload: { code: input.code, positions: [...new Set(input.positions)], planned_start: input.plannedStart, planned_end: input.plannedEnd }
      });
      return this.requireTicket(ticketId);
    });
  }

  getTicket(id: number): Ticket | null {
    const row = this.handle.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as TicketRow | undefined;
    return row ? this.mapTicket(row) : null;
  }

  requireTicket(id: number): Ticket {
    const ticket = this.getTicket(id);
    if (!ticket) throw Errors.notFound(`工作票 ${id}`);
    return ticket;
  }

  listRequiredPositions(ticketId: number): Position[] {
    return (this.handle.db
      .prepare('SELECT position FROM required_positions WHERE ticket_id = ? ORDER BY position')
      .all(ticketId) as { position: Position }[]).map((r) => r.position);
  }

  /**
   * 计划开工到达后，工作票进入作业进行中。这是允许发起交接的前置条件之一。
   */
  markStarted(ticketId: number): Ticket {
    return this.handle.txn(() => {
      const ticket = this.requireTicket(ticketId);
      const now = this.clock.now();
      if (now < ticket.planned_start) throw Errors.beforePlannedStart(now, ticket.planned_start);
      if (ticket.status === TicketStatus.CLOSED) throw Errors.ticketClosed();
      if (ticket.status === TicketStatus.IN_PROGRESS) return ticket;
      this.handle.db.prepare("UPDATE tickets SET status = 'IN_PROGRESS' WHERE id = ?").run(ticketId);
      this.ledger.record({ eventType: 'TICKET_STARTED', ticketId, payload: { at: now } });
      return this.requireTicket(ticketId);
    });
  }

  /** 初始指派（开工布岗），每个必需岗位恰好一人 */
  assignPosition(ticketId: number, position: Position, workerId: number): void {
    this.handle.txn(() => {
      const ticket = this.requireTicket(ticketId);
      if (ticket.status === TicketStatus.CLOSED) throw Errors.ticketClosed();
      this.assertPositionRequired(ticketId, position);
      this.catalog.requirePerson(workerId);
      this.assertWorkerFreeOnTicket(ticketId, workerId, position);

      const current = this.getActiveAssignment(ticketId, position);
      const now = this.clock.now();
      if (current) {
        // 初始布岗阶段的直接替换（尚无交接发生时允许）
        this.handle.db.prepare('UPDATE assignments SET ended_at = ? WHERE id = ?').run(now, current.id);
      }
      this.handle.db
        .prepare(
          `INSERT INTO assignments (ticket_id, position, worker_id, started_at, handover_id)
           VALUES (?, ?, ?, ?, NULL)`
        )
        .run(ticketId, position, workerId, now);
      this.ledger.record({
        eventType: 'POSITION_ASSIGNED',
        ticketId,
        actorId: workerId,
        payload: { position, worker_id: workerId, initial: !current }
      });
    });
  }

  getActiveAssignment(ticketId: number, position: Position) {
    const row = this.handle.db
      .prepare('SELECT * FROM assignments WHERE ticket_id = ? AND position = ? AND ended_at IS NULL')
      .get(ticketId, position) as
      | { id: number; ticket_id: number; position: Position; worker_id: number; started_at: number; ended_at: number | null; handover_id: number | null }
      | undefined;
    return row ?? null;
  }

  /** 当前责任矩阵（快照视图） */
  getResponsibilitySnapshot(ticketId: number): ResponsibilitySnapshotEntry[] {
    const rows = this.handle.db
      .prepare(
        `SELECT id AS assignment_id, position, worker_id, started_at FROM assignments
         WHERE ticket_id = ? AND ended_at IS NULL ORDER BY position ASC`
      )
      .all(ticketId) as ResponsibilitySnapshotEntry[];
    return rows;
  }

  assertPositionRequired(ticketId: number, position: Position): void {
    const required = this.listRequiredPositions(ticketId);
    if (!required.includes(position)) throw Errors.positionNotRequired(position);
  }

  /**
   * 同一人不能在同一票上同时担任两个在任必需岗位。
   * 排除自身岗位（接班人接替自己原岗位时合法）。
   */
  assertWorkerFreeOnTicket(ticketId: number, workerId: number, excludePosition: Position): void {
    const row = this.handle.db
      .prepare(
        `SELECT position FROM assignments
         WHERE ticket_id = ? AND worker_id = ? AND ended_at IS NULL AND position != ?`
      )
      .get(ticketId, workerId, excludePosition) as { position: Position } | undefined;
    if (row) throw Errors.incomingHoldsOtherPosition(workerId, row.position);
  }

  /**
   * 销记：
   * - 存在在途交接时拒绝销记（409），避免悬置责任；
   * - 作废所有在途交接（理论上前置校验后不会存在，兜底）；
   * - 固化最终责任矩阵到 ticket_closures，供追溯最终责任人。
   */
  closeTicket(ticketId: number): TicketClosure {
    return this.handle.txn(() => {
      const ticket = this.requireTicket(ticketId);
      if (ticket.status === TicketStatus.CLOSED) throw Errors.ticketClosed();

      const pending = this.handle.db
        .prepare('SELECT id FROM handovers WHERE ticket_id = ? AND status = ? ORDER BY id')
        .all(ticketId, HandoverStatus.PENDING) as { id: number }[];
      if (pending.length > 0) throw Errors.pendingHandoversBlockClose(pending.map((p) => p.id));

      const now = this.clock.now();
      this.handle.db.prepare("UPDATE tickets SET status = 'CLOSED' WHERE id = ?").run(ticketId);
      const snapshot = this.getResponsibilitySnapshot(ticketId);
      const receipt = this.ledger.issueReceipt({
        type: ReceiptType.TICKET_CLOSED,
        ticketId,
        payload: { final_responsibility: snapshot }
      });
      const info = this.handle.db
        .prepare(
          `INSERT INTO ticket_closures (ticket_id, closed_at, final_responsibility, receipt_ref)
           VALUES (?, ?, ?, ?)`
        )
        .run(ticketId, now, JSON.stringify(snapshot), receipt.ref);
      this.ledger.record({
        eventType: 'TICKET_CLOSED',
        ticketId,
        payload: { closure_id: Number(info.lastInsertRowid), receipt_ref: receipt.ref, final_responsibility: snapshot }
      });
      return this.getClosure(ticketId)!;
    });
  }

  getClosure(ticketId: number): TicketClosure | null {
    const row = this.handle.db
      .prepare('SELECT * FROM ticket_closures WHERE ticket_id = ?')
      .get(ticketId) as
      | { id: number; ticket_id: number; closed_at: number; final_responsibility: string; receipt_ref: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      ticket_id: row.ticket_id,
      closed_at: row.closed_at,
      final_responsibility: JSON.parse(row.final_responsibility) as ResponsibilitySnapshotEntry[],
      receipt_ref: row.receipt_ref
    };
  }

  private mapTicket(row: TicketRow): Ticket {
    return {
      id: row.id,
      code: row.code,
      title: row.title,
      status: row.status,
      planned_start: row.planned_start,
      planned_end: row.planned_end,
      created_at: row.created_at
    };
  }
}
