import type { DbHandle } from '../db/index.js';
import { Clock } from '../domain/clock.js';
import { Errors } from '../domain/errors.js';
import {
  ConfirmParty,
  HandoverStatus,
  Position,
  ReceiptType,
  TERMINAL_HANDOVER_STATUSES,
  TicketStatus,
  DEFAULT_HANDOVER_TIMEOUT_MS
} from '../domain/enums.js';
import type { Handover, ResponsibilitySnapshotEntry } from '../domain/types.js';
import { CatalogService } from './catalog.js';
import { LedgerService } from './ledger.js';
import { TicketService } from './ticket.js';

interface HandoverRow {
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
  responsibility_snapshot: string;
  init_receipt_ref: string;
  completion_receipt_ref: string | null;
  created_audit_seq: number;
  completed_audit_seq: number | null;
}

export interface ConfirmResult {
  handover: Handover;
  /** true 表示本次调用未改变状态（重复确认/已被并发请求完成），不会产生第二次交接 */
  redundant: boolean;
  /** true 表示本次调用达成双确认并完成了原子责任切换 */
  switched: boolean;
}

/**
 * 关键岗位交接服务。
 *
 * 不变量：
 * 1. 仅作业进行中（计划开工之后、销记之前）可发起/完成交接。
 * 2. 交接必须交班人、接班人双向确认；第二个确认到达时，在同一个 IMMEDIATE 事务内
 *    复算全部安全条件并原子切换责任人（旧在任行 ended + 新在任行 insert），
 *    任一条件不满足则整体回滚，绝不产生部分切换、绝不空岗。
 * 3. 部分唯一索引保证每岗位至多一名在任人、每人在一票至多一个在任岗位。
 * 4. 超时以模拟时钟判定；迟到确认只把交接置为 TIMED_OUT，不能夺取责任。
 * 5. 发起时留存责任快照；拒绝原因、超时状态、模拟回执引用全程可追溯。
 */
export class HandoverService {
  constructor(
    private readonly handle: DbHandle,
    private readonly clock: Clock,
    private readonly tickets: TicketService,
    private readonly catalog: CatalogService,
    private readonly ledger: LedgerService,
    private readonly timeoutMs: number = DEFAULT_HANDOVER_TIMEOUT_MS
  ) {}

  // ---------------------------------------------------------------- 发起

  initiate(input: {
    ticketId: number;
    position: Position;
    incomingWorkerId: number;
    initiatedBy: number;
    outgoingWorkerId?: number;
    timeoutMs?: number;
  }): Handover {
    return this.handle.txn(() => {
      const ticket = this.tickets.requireTicket(input.ticketId);
      const now = this.clock.now();

      // 计划开工后、销记前才可发起
      if (ticket.status === TicketStatus.CLOSED) throw Errors.ticketClosed();
      if (now < ticket.planned_start) throw Errors.beforePlannedStart(now, ticket.planned_start);
      if (ticket.status !== TicketStatus.IN_PROGRESS) throw Errors.ticketNotInProgress(ticket.status);

      this.tickets.assertPositionRequired(input.ticketId, input.position);

      // 发起人必须是本票当前在任的四个关键岗位之一
      const snapshot = this.tickets.getResponsibilitySnapshot(input.ticketId);
      const initiatorEntry = snapshot.find((e) => e.worker_id === input.initiatedBy);
      if (!initiatorEntry) {
        throw Errors.invalidPayload(`发起人 ${input.initiatedBy} 不是本票当前在岗的关键岗位人员`);
      }

      const current = this.tickets.getActiveAssignment(input.ticketId, input.position);
      if (!current) throw Errors.positionNotAssigned(input.position);
      const outgoingWorkerId = current.worker_id;
      if (input.outgoingWorkerId !== undefined && input.outgoingWorkerId !== outgoingWorkerId) {
        throw Errors.outgoingNotCurrent(input.outgoingWorkerId);
      }

      this.catalog.requirePerson(input.incomingWorkerId);
      if (input.incomingWorkerId === outgoingWorkerId) throw Errors.incomingSameAsOutgoing();

      // 接班人不能已担任本票另一必需岗位（否则造成兼任、且原岗位空岗）
      this.tickets.assertWorkerFreeOnTicket(input.ticketId, input.incomingWorkerId, input.position);

      // 同一岗位在途交接唯一：未终结前不得再发起
      const existing = this.handle.db
        .prepare('SELECT id FROM handovers WHERE ticket_id = ? AND position = ? AND status = ?')
        .get(input.ticketId, input.position, HandoverStatus.PENDING) as { id: number } | undefined;
      if (existing) throw Errors.pendingHandoverExists(existing.id);

      // 交接链：本岗位上一次完成的交接
      const prev = this.handle.db
        .prepare('SELECT id FROM handovers WHERE ticket_id = ? AND position = ? AND status = ? ORDER BY id DESC LIMIT 1')
        .get(input.ticketId, input.position, HandoverStatus.COMPLETED) as { id: number } | undefined;

      const deadline = now + (input.timeoutMs ?? this.timeoutMs);

      // 先落交接行（created_audit_seq 占位），使随后记录的发起审计能关联 handover_id
      const info = this.handle.db
        .prepare(
          `INSERT INTO handovers (
             ticket_id, position, outgoing_worker_id, incoming_worker_id, initiated_by,
             status, initiated_at, confirm_deadline, prev_handover_id,
             responsibility_snapshot, init_receipt_ref, created_audit_seq
           ) VALUES (
             @ticket_id, @position, @outgoing_worker_id, @incoming_worker_id, @initiated_by,
             'PENDING', @initiated_at, @confirm_deadline, @prev_handover_id,
             @responsibility_snapshot, '', 0
           )`
        )
        .run({
          ticket_id: input.ticketId,
          position: input.position,
          outgoing_worker_id: outgoingWorkerId,
          incoming_worker_id: input.incomingWorkerId,
          initiated_by: input.initiatedBy,
          initiated_at: now,
          confirm_deadline: deadline,
          prev_handover_id: prev?.id ?? null,
          responsibility_snapshot: JSON.stringify(snapshot)
        });
      const handoverId = Number(info.lastInsertRowid);

      const audit = this.ledger.record({
        eventType: 'HANDOVER_INITIATED',
        ticketId: input.ticketId,
        handoverId,
        actorId: input.initiatedBy,
        payload: {
          position: input.position,
          outgoing_worker_id: outgoingWorkerId,
          incoming_worker_id: input.incomingWorkerId,
          confirm_deadline: deadline
        }
      });
      this.handle.db.prepare('UPDATE handovers SET created_audit_seq = ? WHERE id = ?').run(audit.seq, handoverId);

      const receipt = this.ledger.issueReceipt({
        type: ReceiptType.HANDOVER_INITIATED,
        ticketId: input.ticketId,
        handoverId,
        payload: {
          position: input.position,
          outgoing_worker_id: outgoingWorkerId,
          incoming_worker_id: input.incomingWorkerId,
          responsibility_snapshot: snapshot,
          confirm_deadline: deadline
        }
      });
      this.handle.db.prepare('UPDATE handovers SET init_receipt_ref = ? WHERE id = ?').run(receipt.ref, handoverId);

      return this.requireHandover(handoverId);
    });
  }

  // ---------------------------------------------------------------- 确认

  confirm(handoverId: number, party: ConfirmParty, workerId: number): ConfirmResult {
    let failure: Error | null = null;
    const result = this.handle.txn(() => {
      const handover = this.requireHandoverRow(handoverId);
      const ticket = this.tickets.requireTicket(handover.ticket_id);
      if (ticket.status === TicketStatus.CLOSED) throw Errors.ticketClosed();

      const expectedWorker =
        party === ConfirmParty.OUTGOING ? handover.outgoing_worker_id : handover.incoming_worker_id;
      if (workerId !== expectedWorker) throw Errors.partyMismatch(party);

      // 已完成：重复确认 / 并发落败的确认 —— 幂等返回，绝不形成第二次交接
      if (handover.status === HandoverStatus.COMPLETED) {
        return { handover: this.mapHandover(handover), redundant: true, switched: false };
      }
      // 其它终态（REJECTED/VOIDED/TIMED_OUT）不允许确认（先提交可能的状态变更再抛错）
      if (TERMINAL_HANDOVER_STATUSES.has(handover.status)) {
        failure =
          handover.status === HandoverStatus.TIMED_OUT
            ? Errors.handoverTimedOut(handover.confirm_deadline)
            : Errors.handoverNotPending(handover.status);
        return { handover: this.mapHandover(handover), redundant: true, switched: false };
      }

      const now = this.clock.now();
      // 超时闸门：迟到确认只把交接结算为 TIMED_OUT（与错误响应一起在提交后返回），不能夺取责任
      if (now > handover.confirm_deadline) {
        this.markTimedOut(handover, now);
        failure = Errors.handoverTimedOut(handover.confirm_deadline);
        return { handover: this.requireHandover(handoverId), redundant: false, switched: false };
      }

      // 同一方重复确认：幂等，不产生新状态
      const alreadyConfirmed =
        party === ConfirmParty.OUTGOING ? handover.outgoing_confirmed_at !== null : handover.incoming_confirmed_at !== null;
      if (alreadyConfirmed) {
        return { handover: this.mapHandover(handover), redundant: true, switched: false };
      }

      // 本次确认放在保存点内：若双确认齐备但 finalize 安全复核失败，
      // 仅回滚“本次确认尝试”，另一方此前的确认与交接 PENDING 状态保留，可补正后重试。
      this.handle.db.exec('SAVEPOINT confirm_attempt');
      try {
        const column = party === ConfirmParty.OUTGOING ? 'outgoing_confirmed_at' : 'incoming_confirmed_at';
        this.handle.db
          .prepare(`UPDATE handovers SET ${column} = ? WHERE id = ? AND status = 'PENDING'`)
          .run(now, handoverId);
        this.ledger.record({
          eventType: 'HANDOVER_CONFIRMED',
          ticketId: handover.ticket_id,
          handoverId,
          actorId: workerId,
          payload: { party, at: now }
        });

        const updated = this.requireHandoverRow(handoverId);
        if (updated.outgoing_confirmed_at !== null && updated.incoming_confirmed_at !== null) {
          this.finalize(updated, now);
        }
        this.handle.db.exec('RELEASE SAVEPOINT confirm_attempt');
      } catch (err) {
        // 撤销本次确认尝试（含时间戳、审计、finalize 的责任切换写入），保留此前状态
        this.handle.db.exec('ROLLBACK TO SAVEPOINT confirm_attempt');
        this.handle.db.exec('RELEASE SAVEPOINT confirm_attempt');
        failure = err instanceof Error ? err : new Error(String(err));
      }

      if (failure) {
        return { handover: this.requireHandover(handoverId), redundant: false, switched: false };
      }
      const fresh = this.requireHandoverRow(handoverId);
      const switched = fresh.status === HandoverStatus.COMPLETED;
      return { handover: this.requireHandover(handoverId), redundant: false, switched };
    });

    if (failure) throw failure;
    return result;
  }

  /**
   * 双确认齐备后，在同一事务内完成原子责任切换。
   * 任何安全条件不满足：抛出并回滚（责任保持原样），交接仍停留在 PENDING，
   * 在截止时间前仍可补正（如接班人到岗）后再次确认。
   */
  private finalize(handover: HandoverRow, now: number): void {
    const ticket = this.tickets.requireTicket(handover.ticket_id);
    if (ticket.status !== TicketStatus.IN_PROGRESS) throw Errors.ticketNotInProgress(ticket.status);
    // 截止时间由 confirm 进入保存点前统一闸门控制（同一同步事务内时钟不变），此处防御性复核
    if (now > handover.confirm_deadline) throw Errors.handoverTimedOut(handover.confirm_deadline);

    // 1) 接班人已到岗
    if (!this.catalog.isOnSite(handover.ticket_id, handover.incoming_worker_id)) {
      throw Errors.incomingNotArrived(handover.incoming_worker_id);
    }
    // 2) 资格覆盖剩余作业窗口（直至计划完工）
    const qual = this.catalog.checkCoversWindow(handover.incoming_worker_id, handover.position, ticket.planned_end);
    if (!qual.ok) throw Errors.qualificationInsufficient(handover.incoming_worker_id, handover.position, qual.reason);

    // 3) 交班人仍是当前责任人（未被其他交接替换）
    const active = this.tickets.getActiveAssignment(handover.ticket_id, handover.position);
    if (!active || active.worker_id !== handover.outgoing_worker_id) {
      // 抛错回滚整个确认事务；交接保持 PENDING，可被显式拒绝后重新发起
      throw Errors.outgoingNotCurrent(handover.outgoing_worker_id);
    }

    // 4) 接班人未在本票兼任另一必需岗位
    this.tickets.assertWorkerFreeOnTicket(handover.ticket_id, handover.incoming_worker_id, handover.position);

    // 5) 原子切换：旧在任行结束 + 新在任行生效，同一事务、同一时刻。
    //    条件 UPDATE（ended_at IS NULL）确保并发下只有一个交接能命中，
    //    部分唯一索引进一步保证不空岗、不兼任。
    const closeOld = this.handle.db
      .prepare('UPDATE assignments SET ended_at = ? WHERE id = ? AND ended_at IS NULL')
      .run(now, active.id);
    if (closeOld.changes !== 1) {
      throw new Error(`责任切换并发冲突：旧责任行关闭数量=${closeOld.changes}`);
    }
    const insertInfo = this.handle.db
      .prepare(
        `INSERT INTO assignments (ticket_id, position, worker_id, started_at, handover_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(handover.ticket_id, handover.position, handover.incoming_worker_id, now, handover.id);

    const completionAudit = this.ledger.record({
      eventType: 'HANDOVER_COMPLETED',
      ticketId: handover.ticket_id,
      handoverId: handover.id,
      payload: {
        position: handover.position,
        outgoing_worker_id: handover.outgoing_worker_id,
        incoming_worker_id: handover.incoming_worker_id,
        old_assignment_id: active.id,
        new_assignment_id: Number(insertInfo.lastInsertRowid),
        switched_at: now
      }
    });

    const receipt = this.ledger.issueReceipt({
      type: ReceiptType.HANDOVER_COMPLETED,
      ticketId: handover.ticket_id,
      handoverId: handover.id,
      payload: {
        position: handover.position,
        outgoing_worker_id: handover.outgoing_worker_id,
        incoming_worker_id: handover.incoming_worker_id,
        switched_at: now,
        new_assignment_id: Number(insertInfo.lastInsertRowid)
      }
    });

    // 6) 条件收尾：只有仍是 PENDING 且未超时的交接能被置为 COMPLETED。
    //    并发完成时落败方 changes=0（其前面的 assignment 写入会随之整体回滚）。
    const done = this.handle.db
      .prepare(
        `UPDATE handovers
            SET status = 'COMPLETED',
                completed_at = ?,
                completion_receipt_ref = ?,
                completed_audit_seq = ?
          WHERE id = ? AND status = 'PENDING' AND confirm_deadline >= ?`
      )
      .run(now, receipt.ref, completionAudit.seq, handover.id, now);
    if (done.changes !== 1) {
      throw new Error('交接完成并发冲突：状态收尾未命中，事务回滚');
    }
  }

  // ---------------------------------------------------------------- 拒绝

  reject(handoverId: number, workerId: number, reason: string): Handover {
    let failure: Error | null = null;
    const result = this.handle.txn(() => {
      const handover = this.requireHandoverRow(handoverId);
      const ticket = this.tickets.requireTicket(handover.ticket_id);
      if (ticket.status === TicketStatus.CLOSED) throw Errors.ticketClosed();
      if (workerId !== handover.outgoing_worker_id && workerId !== handover.incoming_worker_id) {
        throw Errors.partyMismatch('OUTGOING|INCOMING');
      }
      if (handover.status !== HandoverStatus.PENDING) throw Errors.handoverNotPending(handover.status);
      const now = this.clock.now();
      if (now > handover.confirm_deadline) {
        // 超时结算随事务提交，错误在提交后返回
        this.markTimedOut(handover, now);
        failure = Errors.handoverTimedOut(handover.confirm_deadline);
        return this.requireHandover(handoverId);
      }
      if (!reason || !reason.trim()) throw Errors.rejectReasonRequired();
      this.markRejected(handover, workerId, reason.trim(), now);
      return this.requireHandover(handoverId);
    });
    if (failure) throw failure;
    return result;
  }

  // ---------------------------------------------------------------- 超时

  /** 扫描所有已过截止时间仍 PENDING 的交接，置 TIMED_OUT（幂等） */
  sweepTimeouts(): Handover[] {
    return this.handle.txn(() => {
      const now = this.clock.now();
      const rows = this.handle.db
        .prepare('SELECT * FROM handovers WHERE status = ? AND confirm_deadline < ? ORDER BY id ASC')
        .all(HandoverStatus.PENDING, now) as HandoverRow[];
      return rows.map((row) => {
        this.markTimedOut(row, now);
        return this.requireHandover(row.id);
      });
    });
  }

  /** 销记时由 TicketService 语义保证不存在 PENDING；此方法提供作废兜底 */
  voidPendingForTicket(ticketId: number): void {
    const now = this.clock.now();
    const rows = this.handle.db
      .prepare('SELECT * FROM handovers WHERE ticket_id = ? AND status = ? ORDER BY id ASC')
      .all(ticketId, HandoverStatus.PENDING) as HandoverRow[];
    for (const row of rows) {
      this.handle.db
        .prepare("UPDATE handovers SET status = 'VOIDED', voided_at = ? WHERE id = ?")
        .run(now, row.id);
      this.ledger.issueReceipt({
        type: ReceiptType.HANDOVER_VOIDED,
        ticketId,
        handoverId: row.id,
        payload: { reason: '工作票销记，在途交接收回' }
      });
      this.ledger.record({
        eventType: 'HANDOVER_VOIDED',
        ticketId,
        handoverId: row.id,
        payload: { at: now }
      });
    }
  }

  // ---------------------------------------------------------------- 查询

  getHandover(id: number): Handover | null {
    const row = this.handle.db.prepare('SELECT * FROM handovers WHERE id = ?').get(id) as HandoverRow | undefined;
    return row ? this.mapHandover(row) : null;
  }

  requireHandover(id: number): Handover {
    const handover = this.getHandover(id);
    if (!handover) throw Errors.notFound(`交接 ${id}`);
    return handover;
  }

  listByTicket(ticketId: number): Handover[] {
    this.sweepTimeouts();
    const rows = this.handle.db
      .prepare('SELECT * FROM handovers WHERE ticket_id = ? ORDER BY id ASC')
      .all(ticketId) as HandoverRow[];
    return rows.map((r) => this.mapHandover(r));
  }

  /** 交接链：按发起审计顺序（与 id 同序）返回，重启后顺序一致 */
  getChain(ticketId: number, position?: Position): Handover[] {
    const rows = position
      ? (this.handle.db
          .prepare('SELECT * FROM handovers WHERE ticket_id = ? AND position = ? ORDER BY created_audit_seq ASC')
          .all(ticketId, position) as HandoverRow[])
      : (this.handle.db
          .prepare('SELECT * FROM handovers WHERE ticket_id = ? ORDER BY created_audit_seq ASC')
          .all(ticketId) as HandoverRow[]);
    return rows.map((r) => this.mapHandover(r));
  }

  // ---------------------------------------------------------------- 内部

  private requireHandoverRow(id: number): HandoverRow {
    const row = this.handle.db.prepare('SELECT * FROM handovers WHERE id = ?').get(id) as HandoverRow | undefined;
    if (!row) throw Errors.notFound(`交接 ${id}`);
    return row;
  }

  private markTimedOut(handover: HandoverRow, now: number): void {
    const result = this.handle.db
      .prepare("UPDATE handovers SET status = 'TIMED_OUT', timed_out_at = ? WHERE id = ? AND status = 'PENDING'")
      .run(now, handover.id);
    if (result.changes !== 1) return; // 已被并发处理
    this.ledger.issueReceipt({
      type: ReceiptType.HANDOVER_TIMED_OUT,
      ticketId: handover.ticket_id,
      handoverId: handover.id,
      payload: { deadline: handover.confirm_deadline, timed_out_at: now }
    });
    this.ledger.record({
      eventType: 'HANDOVER_TIMED_OUT',
      ticketId: handover.ticket_id,
      handoverId: handover.id,
      payload: { deadline: handover.confirm_deadline, timed_out_at: now }
    });
  }

  private markRejected(handover: HandoverRow, rejectedBy: number, reason: string, now: number): void {
    const result = this.handle.db
      .prepare(
        `UPDATE handovers
            SET status = 'REJECTED', rejected_by = ?, rejected_at = ?, reject_reason = ?
          WHERE id = ? AND status = 'PENDING'`
      )
      .run(rejectedBy, now, reason, handover.id);
    if (result.changes !== 1) return;
    this.ledger.issueReceipt({
      type: ReceiptType.HANDOVER_REJECTED,
      ticketId: handover.ticket_id,
      handoverId: handover.id,
      payload: { rejected_by: rejectedBy, reason, rejected_at: now }
    });
    this.ledger.record({
      eventType: 'HANDOVER_REJECTED',
      ticketId: handover.ticket_id,
      handoverId: handover.id,
      actorId: rejectedBy,
      payload: { reason, rejected_at: now }
    });
  }

  private mapHandover(row: HandoverRow): Handover {
    return {
      id: row.id,
      ticket_id: row.ticket_id,
      position: row.position,
      outgoing_worker_id: row.outgoing_worker_id,
      incoming_worker_id: row.incoming_worker_id,
      initiated_by: row.initiated_by,
      status: row.status,
      initiated_at: row.initiated_at,
      confirm_deadline: row.confirm_deadline,
      outgoing_confirmed_at: row.outgoing_confirmed_at,
      incoming_confirmed_at: row.incoming_confirmed_at,
      completed_at: row.completed_at,
      rejected_by: row.rejected_by,
      rejected_at: row.rejected_at,
      reject_reason: row.reject_reason,
      timed_out_at: row.timed_out_at,
      voided_at: row.voided_at,
      prev_handover_id: row.prev_handover_id,
      responsibility_snapshot: JSON.parse(row.responsibility_snapshot) as ResponsibilitySnapshotEntry[],
      init_receipt_ref: row.init_receipt_ref,
      completion_receipt_ref: row.completion_receipt_ref,
      created_audit_seq: row.created_audit_seq,
      completed_audit_seq: row.completed_audit_seq
    };
  }
}
