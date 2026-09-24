import type { DbHandle } from '../db/index.js';
import { Clock } from '../domain/clock.js';
import { Errors } from '../domain/errors.js';
import { Position } from '../domain/enums.js';
import type { Person, Qualification } from '../domain/types.js';

interface PersonRow {
  id: number;
  name: string;
  employee_no: string;
}

interface QualRow {
  id: number;
  worker_id: number;
  position: Position;
  valid_from: number;
  valid_to: number;
}

/**
 * 人员花名册、岗位资质、到离岗登记。
 */
export class CatalogService {
  constructor(
    private readonly handle: DbHandle,
    private readonly clock: Clock
  ) {}

  createPerson(name: string, employeeNo: string): Person {
    const info = this.handle.db
      .prepare('INSERT INTO people (name, employee_no) VALUES (?, ?)')
      .run(name, employeeNo);
    return this.getPerson(Number(info.lastInsertRowid))!;
  }

  getPerson(id: number): Person | null {
    const row = this.handle.db.prepare('SELECT * FROM people WHERE id = ?').get(id) as PersonRow | undefined;
    return row ? { id: row.id, name: row.name, employee_no: row.employee_no } : null;
  }

  requirePerson(id: number): Person {
    const person = this.getPerson(id);
    if (!person) throw Errors.notFound(`人员 ${id}`);
    return person;
  }

  listPeople(): Person[] {
    return (this.handle.db.prepare('SELECT * FROM people ORDER BY id ASC').all() as PersonRow[]).map((r) => ({
      id: r.id,
      name: r.name,
      employee_no: r.employee_no
    }));
  }

  addQualification(workerId: number, position: Position, validFrom: number, validTo: number): Qualification {
    if (validTo <= validFrom) throw Errors.invalidPayload('资质有效期结束时间必须晚于开始时间');
    this.requirePerson(workerId);
    const info = this.handle.db
      .prepare('INSERT INTO qualifications (worker_id, position, valid_from, valid_to) VALUES (?, ?, ?, ?)')
      .run(workerId, position, validFrom, validTo);
    return this.getQualification(Number(info.lastInsertRowid))!;
  }

  getQualification(id: number): Qualification | null {
    const row = this.handle.db.prepare('SELECT * FROM qualifications WHERE id = ?').get(id) as QualRow | undefined;
    return row ? { ...row } : null;
  }

  /**
   * 校验资质是否覆盖整个剩余作业窗口：
   * 证书须在当前时刻已生效，且有效期不早于计划完工时间。
   */
  checkCoversWindow(workerId: number, position: Position, plannedEnd: number): { ok: true } | { ok: false; reason: string } {
    const now = this.clock.now();
    const row = this.handle.db
      .prepare(
        `SELECT * FROM qualifications
         WHERE worker_id = ? AND position = ? AND valid_from <= ? AND valid_to >= ?
         ORDER BY valid_to DESC LIMIT 1`
      )
      .get(workerId, position, now, plannedEnd) as QualRow | undefined;
    if (!row) {
      const anyCert = this.handle.db
        .prepare('SELECT * FROM qualifications WHERE worker_id = ? AND position = ? ORDER BY valid_to DESC LIMIT 1')
        .get(workerId, position) as QualRow | undefined;
      if (!anyCert) return { ok: false, reason: '无该岗位资质证书' };
      if (anyCert.valid_from > now) return { ok: false, reason: '资质尚未生效' };
      return { ok: false, reason: `资质有效期至 ${new Date(anyCert.valid_to).toISOString()}，不能覆盖计划完工 ${new Date(plannedEnd).toISOString()}` };
    }
    return { ok: true };
  }

  markArrival(ticketId: number, workerId: number): { arrived_at: number } {
    this.requirePerson(workerId);
    const now = this.clock.now();
    const existing = this.handle.db
      .prepare('SELECT on_site FROM presence WHERE ticket_id = ? AND worker_id = ?')
      .get(ticketId, workerId) as { on_site: number } | undefined;
    if (existing) {
      if (existing.on_site === 1) return { arrived_at: now };
      this.handle.db
        .prepare('UPDATE presence SET on_site = 1, arrived_at = ?, departed_at = NULL WHERE ticket_id = ? AND worker_id = ?')
        .run(now, ticketId, workerId);
    } else {
      this.handle.db
        .prepare('INSERT INTO presence (ticket_id, worker_id, on_site, arrived_at) VALUES (?, ?, 1, ?)')
        .run(ticketId, workerId, now);
    }
    return { arrived_at: now };
  }

  markDeparture(ticketId: number, workerId: number): void {
    const now = this.clock.now();
    this.handle.db
      .prepare(
        `INSERT INTO presence (ticket_id, worker_id, on_site, arrived_at, departed_at)
         VALUES (?, ?, 0, NULL, ?)
         ON CONFLICT(ticket_id, worker_id) DO UPDATE SET on_site = 0, departed_at = excluded.departed_at`
      )
      .run(ticketId, workerId, now);
  }

  isOnSite(ticketId: number, workerId: number): boolean {
    const row = this.handle.db
      .prepare('SELECT on_site FROM presence WHERE ticket_id = ? AND worker_id = ?')
      .get(ticketId, workerId) as { on_site: number } | undefined;
    return !!row && row.on_site === 1;
  }
}
