import { createHash, randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { DbHandle } from '../db/index.js';
import { Clock } from '../domain/clock.js';
import { ReceiptType } from '../domain/enums.js';
import type { AuditEntry, SimulationReceipt } from '../domain/types.js';

interface ReceiptRow {
  id: number;
  ref: string;
  type: ReceiptType;
  ticket_id: number | null;
  handover_id: number | null;
  created_at: number;
  payload: string;
}

interface AuditRow {
  id: number;
  seq: number;
  event_type: string;
  ticket_id: number | null;
  handover_id: number | null;
  actor_id: number | null;
  occurred_at: number;
  payload: string;
}

/**
 * 审计账本与模拟回执：均为只追加表。
 * audit_seq 独立取号（不依赖 rowid 语义），重启后顺序依旧严格可读。
 */
export class LedgerService {
  private readonly insertReceiptStmt;
  private readonly insertAuditStmt;
  private readonly nextSeqStmt;

  constructor(
    private readonly handle: DbHandle,
    private readonly clock: Clock
  ) {
    const db: Database = handle.db;
    this.insertReceiptStmt = db.prepare(`
      INSERT INTO simulation_receipts (ref, type, ticket_id, handover_id, created_at, payload)
      VALUES (@ref, @type, @ticket_id, @handover_id, @created_at, @payload)
    `);
    this.insertAuditStmt = db.prepare(`
      INSERT INTO audit_log (seq, event_type, ticket_id, handover_id, actor_id, occurred_at, payload)
      VALUES (@seq, @event_type, @ticket_id, @handover_id, @actor_id, @occurred_at, @payload)
    `);
    this.nextSeqStmt = db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM audit_log`);
  }

  /** 在调用方事务内执行（不显式另开事务） */
  issueReceipt(input: {
    type: ReceiptType;
    ticketId?: number | null;
    handoverId?: number | null;
    payload: Record<string, unknown>;
    refSeed?: string;
  }): SimulationReceipt {
    const now = this.clock.now();
    const seed = input.refSeed ?? `${input.type}|${input.ticketId ?? 'NA'}|${input.handoverId ?? 'NA'}|${now}`;
    const digest = createHash('sha256').update(seed).digest('base64url').slice(0, 20);
    const ref = `RCPT-${digest}-${randomBytes(3).toString('hex')}`;
    const info = this.insertReceiptStmt.run({
      ref,
      type: input.type,
      ticket_id: input.ticketId ?? null,
      handover_id: input.handoverId ?? null,
      created_at: now,
      payload: JSON.stringify({ ...input.payload, at: new Date(now).toISOString() })
    });
    return this.getReceiptById(Number(info.lastInsertRowid))!;
  }

  getReceiptById(id: number): SimulationReceipt | null {
    const row = this.handle.db.prepare('SELECT * FROM simulation_receipts WHERE id = ?').get(id) as ReceiptRow | undefined;
    return row ? this.mapReceipt(row) : null;
  }

  getReceiptByRef(ref: string): SimulationReceipt | null {
    const row = this.handle.db.prepare('SELECT * FROM simulation_receipts WHERE ref = ?').get(ref) as ReceiptRow | undefined;
    return row ? this.mapReceipt(row) : null;
  }

  listReceipts(ticketId?: number): SimulationReceipt[] {
    const rows = ticketId
      ? (this.handle.db.prepare('SELECT * FROM simulation_receipts WHERE ticket_id = ? ORDER BY id ASC').all(ticketId) as ReceiptRow[])
      : (this.handle.db.prepare('SELECT * FROM simulation_receipts ORDER BY id ASC').all() as ReceiptRow[]);
    return rows.map((r) => this.mapReceipt(r));
  }

  /** 在调用方事务内写一条审计并返回落库后的条目 */
  record(input: {
    eventType: string;
    ticketId?: number | null;
    handoverId?: number | null;
    actorId?: number | null;
    payload?: Record<string, unknown>;
  }): AuditEntry {
    const now = this.clock.now();
    const nextSeq = Number((this.nextSeqStmt.get() as { next_seq: number }).next_seq);
    this.insertAuditStmt.run({
      seq: nextSeq,
      event_type: input.eventType,
      ticket_id: input.ticketId ?? null,
      handover_id: input.handoverId ?? null,
      actor_id: input.actorId ?? null,
      occurred_at: now,
      payload: JSON.stringify(input.payload ?? {})
    });
    const row = this.handle.db.prepare('SELECT * FROM audit_log WHERE seq = ?').get(nextSeq) as AuditRow;
    return this.mapAudit(row);
  }

  listAudit(ticketId?: number): AuditEntry[] {
    const rows = ticketId
      ? (this.handle.db.prepare('SELECT * FROM audit_log WHERE ticket_id = ? ORDER BY seq ASC').all(ticketId) as AuditRow[])
      : (this.handle.db.prepare('SELECT * FROM audit_log ORDER BY seq ASC').all() as AuditRow[]);
    return rows.map((r) => this.mapAudit(r));
  }

  private mapReceipt(row: ReceiptRow): SimulationReceipt {
    return {
      id: row.id,
      ref: row.ref,
      type: row.type,
      ticket_id: row.ticket_id,
      handover_id: row.handover_id,
      created_at: row.created_at,
      payload: JSON.parse(row.payload) as Record<string, unknown>
    };
  }

  private mapAudit(row: AuditRow): AuditEntry {
    return {
      id: row.id,
      seq: row.seq,
      event_type: row.event_type,
      ticket_id: row.ticket_id,
      handover_id: row.handover_id,
      actor_id: row.actor_id,
      occurred_at: row.occurred_at,
      payload: JSON.parse(row.payload) as Record<string, unknown>
    };
  }
}
