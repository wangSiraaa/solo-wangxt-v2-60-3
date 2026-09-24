import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness, makeHarness, MIN } from './helpers/harness.js';
import { setupStandardScenario } from './helpers/scenario.js';
import { ConfirmParty, HandoverStatus, Position } from '../src/domain/enums.js';

let h: Harness;

beforeEach(async () => {
  h = makeHarness();
  await setupStandardScenario(h);
});
afterEach(() => h.stop());

/**
 * 服务层直接测试：
 * - 数据库不变量（部分唯一索引）在任何中间状态下保证不空岗/不兼任；
 * - 同岗位串行交接链；
 * - 拒绝后责任不变并可重新发起。
 */
describe('服务层：岗位不空、不兼任的数据库不变量', () => {
  it('PENDING 期间旧责任人持续在任；完成切换为同一时刻的 ended/insert', async () => {
    const { ctx } = h;
    const ticketId = 1;
    const workers = await workerIds();
    ctx.catalog.markArrival(ticketId, workers.W5);

    const before = ctx.tickets.getActiveAssignment(ticketId, Position.LEADER);
    const ho = ctx.handovers.initiate({
      ticketId,
      position: Position.LEADER,
      incomingWorkerId: workers.W5,
      initiatedBy: workers.W1
    });

    // PENDING：旧 assignment 仍无 ended_at，尚无 W5 的在任记录
    const pending = ctx.db()
      .prepare('SELECT COUNT(*) AS c FROM assignments WHERE ticket_id=? AND position=? AND ended_at IS NULL')
      .get(ticketId, Position.LEADER) as { c: number };
    expect(pending.c).toBe(1);
    expect(ctx.tickets.getActiveAssignment(ticketId, Position.LEADER)!.worker_id).toBe(workers.W1);

    ctx.handovers.confirm(ho.id, ConfirmParty.OUTGOING, workers.W1);
    expect(ctx.tickets.getActiveAssignment(ticketId, Position.LEADER)!.worker_id).toBe(workers.W1);
    ctx.handovers.confirm(ho.id, ConfirmParty.INCOMING, workers.W5);
    expect(ctx.tickets.getActiveAssignment(ticketId, Position.LEADER)!.worker_id).toBe(workers.W5);

    // 旧行被结束且指向交接 id；新行 handover_id 一致；两行 started/ended 同一时刻（无空窗）
    const rows = ctx.db()
      .prepare('SELECT * FROM assignments WHERE ticket_id=? AND position=? ORDER BY id')
      .all(ticketId, Position.LEADER) as Array<{ id: number; worker_id: number; ended_at: number | null; started_at: number; handover_id: number | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].worker_id).toBe(workers.W1);
    expect(rows[0].ended_at).toBe(rows[1].started_at);
    expect(rows[1].handover_id).toBe(ho.id);
    expect(before!.id).toBe(rows[0].id);
  });

  it('四个岗位可各自独立交接，互不阻塞；最终四岗齐全', async () => {
    const { ctx } = h;
    const ticketId = 1;
    const w = await workerIds();
    // W5 接任 LEADER，新增 W9..W12 接任其余三岗
    const names: Array<[string, string, Position]> = [
      ['W9', 'E009', Position.SAFETY_OFFICER],
      ['W10', 'E010', Position.LIAISON],
      ['W11', 'E011', Position.GUARD]
    ];
    const ids: Record<string, number> = { W5: w.W5 };
    for (const [name, no, pos] of names) {
      const p = ctx.catalog.createPerson(name, no);
      ctx.catalog.addQualification(p.id, pos, h.T0 - 365 * 24 * 60 * MIN, h.T0 + 10 * 60 * MIN);
      ctx.catalog.markArrival(ticketId, p.id);
      ids[name] = p.id;
    }
    ctx.catalog.markArrival(ticketId, w.W5);

    const currentOf = (pos: Position) => ctx.tickets.getActiveAssignment(ticketId, pos)!.worker_id;
    const pairs: Array<[Position, number, number]> = [
      [Position.LEADER, w.W1, ids.W5],
      [Position.SAFETY_OFFICER, w.W2, ids.W9],
      [Position.LIAISON, w.W3, ids.W10],
      [Position.GUARD, w.W4, ids.W11]
    ];

    // 先全部发起（不同岗位可并存 PENDING）
    const initiated = pairs.map(([pos, outgoing, incoming]) => {
      const ho = ctx.handovers.initiate({ ticketId, position: pos, incomingWorkerId: incoming, initiatedBy: outgoing });
      return { ho, pos, outgoing, incoming };
    });
    // 再交错双向确认
    for (const item of initiated) {
      ctx.handovers.confirm(item.ho.id, ConfirmParty.OUTGOING, item.outgoing);
    }
    for (const item of initiated) {
      const res = ctx.handovers.confirm(item.ho.id, ConfirmParty.INCOMING, item.incoming);
      expect(res.switched).toBe(true);
      expect(currentOf(item.pos)).toBe(item.incoming);
    }
    const snapshot = ctx.tickets.getResponsibilitySnapshot(ticketId);
    expect(snapshot).toHaveLength(4);
    expect(new Set(snapshot.map((s) => s.worker_id)).size).toBe(4);
  });

  it('同岗位存在 PENDING 时禁止再发起；拒绝后可重新发起，链 prev 仅串联 COMPLETED', async () => {
    const { ctx } = h;
    const ticketId = 1;
    const w = await workerIds();
    ctx.catalog.markArrival(ticketId, w.W5);

    const h1 = ctx.handovers.initiate({ ticketId, position: Position.LEADER, incomingWorkerId: w.W5, initiatedBy: w.W1 });
    expect(() =>
      ctx.handovers.initiate({ ticketId, position: Position.LEADER, incomingWorkerId: w.W5, initiatedBy: w.W1 })
    ).toThrow(/在途交接/);

    ctx.handovers.reject(h1.id, w.W1, '负责人暂不离岗');
    expect(ctx.handovers.requireHandover(h1.id).status).toBe(HandoverStatus.REJECTED);
    expect(ctx.tickets.getActiveAssignment(ticketId, Position.LEADER)!.worker_id).toBe(w.W1);

    const h2 = ctx.handovers.initiate({ ticketId, position: Position.LEADER, incomingWorkerId: w.W5, initiatedBy: w.W1 });
    ctx.handovers.confirm(h2.id, ConfirmParty.OUTGOING, w.W1);
    ctx.handovers.confirm(h2.id, ConfirmParty.INCOMING, w.W5);
    expect(h2.prev_handover_id).toBeNull(); // 前一交接被拒绝，不入链

    // 再交接回 W1，prev 指向 h2
    const h3 = ctx.handovers.initiate({ ticketId, position: Position.LEADER, incomingWorkerId: w.W1, initiatedBy: w.W5 });
    expect(h3.prev_handover_id).toBe(h2.id);
  });

  it('责任快照冻结发起时刻，不随后续切换而改变', async () => {
    const { ctx } = h;
    const ticketId = 1;
    const w = await workerIds();
    ctx.catalog.markArrival(ticketId, w.W5);
    const h1 = ctx.handovers.initiate({ ticketId, position: Position.LEADER, incomingWorkerId: w.W5, initiatedBy: w.W1 });
    ctx.handovers.confirm(h1.id, ConfirmParty.OUTGOING, w.W1);
    ctx.handovers.confirm(h1.id, ConfirmParty.INCOMING, w.W5);

    const stored = ctx.handovers.requireHandover(h1.id);
    const leaderSnap = stored.responsibility_snapshot.find((s) => s.position === Position.LEADER)!;
    expect(leaderSnap.worker_id).toBe(w.W1); // 即便当前已是 W5，快照仍记录发起时 W1
  });
});

async function workerIds(): Promise<Record<string, number>> {
  const people = h.ctx.catalog.listPeople();
  const map: Record<string, number> = {};
  people.forEach((p, i) => {
    map[`W${i + 1}`] = p.id;
  });
  return map;
}
