import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { HOUR, Harness, makeHarness, MIN, reopenHarness } from './helpers/harness.js';
import { apiOf, setupStandardScenario, type Scenario } from './helpers/scenario.js';
import { HandoverStatus, Position } from '../src/domain/enums.js';

let h: Harness;
let sc: Scenario;

beforeEach(async () => {
  h = makeHarness();
  sc = await setupStandardScenario(h);
});
afterEach(() => h.stop());

/** 取某岗位当前责任人 */
async function currentLeader(): Promise<number> {
  const res = await supertest(h.app).get(`/api/tickets/${sc.ticketId}/responsibility`).expect(200);
  const entry = res.body.responsibility.find((e: any) => e.position.code === Position.LEADER);
  return entry.worker_id;
}

describe('前置条件：仅作业进行中可发起交接', () => {
  it('计划开工之前不能发起交接（BEFORE_PLANNED_START）', async () => {
    const api = apiOf(h);
    const future = h.T0 + 10 * 24 * 60 * MIN;
    const ticket = await api.post('/api/tickets').send({
      code: 'WP-FUTURE',
      title: '未来作业',
      planned_start: h.T0 + 2 * HOUR,
      planned_end: h.T0 + 8 * HOUR,
      positions: [Position.LEADER]
    }).expect(201);
    const id = ticket.body.ticket.id;
    await api.post(`/api/tickets/${id}/assignments`).send({ position: Position.LEADER, worker_id: sc.workers.W1 }).expect(201);
    // W5 到岗
    await api.post(`/api/tickets/${id}/presence/${sc.workers.W5}/arrive`).expect(201);

    const res = await api.post('/api/handovers').send({
      ticket_id: id,
      position: Position.LEADER,
      incoming_worker_id: sc.workers.W5,
      initiated_by: sc.workers.W1
    });
    expect(res.status).toBe(409);
    expect(res.body.error.errorCode).toBe('BEFORE_PLANNED_START');
    expect(future).toBeGreaterThan(0);
  });

  it('销记后不能再交接（TICKET_CLOSED）', async () => {
    const api = apiOf(h);
    await api.post(`/api/tickets/${sc.ticketId}/close`).expect(200);
    const res = await api.post('/api/handovers').send({
      ticket_id: sc.ticketId,
      position: Position.LEADER,
      incoming_worker_id: sc.workers.W5,
      initiated_by: sc.workers.W1
    });
    expect(res.status).toBe(409);
    expect(res.body.error.errorCode).toBe('TICKET_CLOSED');
  });

  it('发起人必须是本票当前关键岗位人员', async () => {
    const api = apiOf(h);
    const res = await api.post('/api/handovers').send({
      ticket_id: sc.ticketId,
      position: Position.LEADER,
      incoming_worker_id: sc.workers.W5,
      initiated_by: sc.workers.W8 // 无岗位人员
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('关键岗位');
  });
});

// ---------------------------------------------------------------- 验收 1
describe('验收1：正常双确认后的原子责任切换', () => {
  it('交班人+接班人双向确认齐备瞬间完成切换；四岗始终各有一人；快照/回执/审计齐全', async () => {
    const api = apiOf(h);
    const { ticketId, workers } = sc;
    await api.post(`/api/tickets/${ticketId}/presence/${workers.W5}/arrive`).expect(201);

    // 发起
    const init = await api.post('/api/handovers').send({
      ticket_id: ticketId,
      position: Position.LEADER,
      incoming_worker_id: workers.W5,
      initiated_by: workers.W1
    }).expect(201);
    const hid = init.body.handover.id;
    expect(init.body.handover.status).toBe(HandoverStatus.PENDING);
    expect(init.body.receipt.type).toBe('HANDOVER_INITIATED');
    expect(init.body.receipt.ref).toBe(init.body.handover.receipts.init);
    // 责任快照包含发起时四个岗位责任人
    const snap = init.body.handover.responsibility_snapshot;
    expect(snap).toHaveLength(4);
    const snapLeader = snap.find((e: any) => e.position.code === Position.LEADER);
    expect(snapLeader.worker_id).toBe(workers.W1);
    expect(snapLeader.worker_id).not.toBe(workers.W5);

    // 切换前：负责人仍是 W1
    expect(await currentLeader()).toBe(workers.W1);

    // 交班人确认（单方确认不切换）
    const c1 = await api.post(`/api/handovers/${hid}/confirm-outgoing`).send({ worker_id: workers.W1 }).expect(200);
    expect(c1.body.switched).toBe(false);
    expect(c1.body.redundant).toBe(false);
    expect(await currentLeader()).toBe(workers.W1);

    // 接班人确认 → 双确认齐备，原子切换
    const c2 = await api.post(`/api/handovers/${hid}/confirm-incoming`).send({ worker_id: workers.W5 }).expect(200);
    expect(c2.body.switched).toBe(true);
    expect(c2.body.redundant).toBe(false);
    expect(c2.body.handover.status).toBe(HandoverStatus.COMPLETED);
    expect(c2.body.completion_receipt.type).toBe('HANDOVER_COMPLETED');
    expect(c2.body.handover.receipts.completion).toBe(c2.body.completion_receipt.ref);

    // 责任矩阵：负责人已切到 W5，其余三岗不变；无空岗
    const matrix = (await api.get(`/api/tickets/${ticketId}/responsibility`).expect(200)).body.responsibility;
    expect(matrix).toHaveLength(4);
    const byPos = Object.fromEntries(matrix.map((e: any) => [e.position.code, e.worker_id]));
    expect(byPos.LEADER).toBe(workers.W5);
    expect(byPos.SAFETY_OFFICER).toBe(workers.W2);
    expect(byPos.LIAISON).toBe(workers.W3);
    expect(byPos.GUARD).toBe(workers.W4);
    // 所有责任人互不相同（不兼任）
    expect(new Set(Object.values(byPos))).toHaveLength(4);

    // 交接记录持久保留双向确认时间、完成时间
    const got = (await api.get(`/api/handovers/${hid}`).expect(200)).body.handover;
    expect(got.outgoing_confirmed_at).not.toBeNull();
    expect(got.incoming_confirmed_at).not.toBeNull();
    expect(got.completed_at).not.toBeNull();

    // 审计顺序：INITIATED → CONFIRMED(OUT) → CONFIRMED(IN) → COMPLETED
    const audit = (await api.get(`/api/tickets/${ticketId}/audit`).expect(200)).body.audit;
    const handoverEvents = audit.filter((e: any) => e.handover_id === hid).map((e: any) => e.event_type);
    expect(handoverEvents).toEqual([
      'HANDOVER_INITIATED',
      'HANDOVER_CONFIRMED',
      'HANDOVER_CONFIRMED',
      'HANDOVER_COMPLETED'
    ]);
    expect(audit.map((e: any) => e.seq)).toEqual([...audit.keys()].map((i) => i + 1));
  });

  it('反向确认顺序（接班人先确认、交班人后确认）同样在双确认时完成', async () => {
    const api = apiOf(h);
    const { ticketId, workers } = sc;
    await api.post(`/api/tickets/${ticketId}/presence/${workers.W5}/arrive`).expect(201);
    const hid = (
      await api.post('/api/handovers').send({
        ticket_id: ticketId,
        position: Position.LEADER,
        incoming_worker_id: workers.W5,
        initiated_by: workers.W1
      })
    ).body.handover.id;
    await api.post(`/api/handovers/${hid}/confirm-incoming`).send({ worker_id: workers.W5 }).expect(200);
    expect(await currentLeader()).toBe(workers.W1);
    const done = await api.post(`/api/handovers/${hid}/confirm-outgoing`).send({ worker_id: workers.W1 }).expect(200);
    expect(done.body.switched).toBe(true);
    expect(await currentLeader()).toBe(workers.W5);
  });
});

// ---------------------------------------------------------------- 验收 2
describe('验收2：资质不足或未到岗时不产生部分切换', () => {
  it('接班人未到岗：双确认时 409 INCOMING_NOT_ARRIVED，责任与交接状态均保持可补正', async () => {
    const api = apiOf(h);
    const { ticketId, workers } = sc;
    // 不做 W5 到岗登记
    const hid = (
      await api.post('/api/handovers').send({
        ticket_id: ticketId,
        position: Position.LEADER,
        incoming_worker_id: workers.W5,
        initiated_by: workers.W1
      })
    ).body.handover.id;
    await api.post(`/api/handovers/${hid}/confirm-outgoing`).send({ worker_id: workers.W1 }).expect(200);
    const fail = await api.post(`/api/handovers/${hid}/confirm-incoming`).send({ worker_id: workers.W5 });
    expect(fail.status).toBe(409);
    expect(fail.body.error.errorCode).toBe('INCOMING_NOT_ARRIVED');

    // 无部分切换：负责人仍 W1；失败的确认事务整体回滚（含接班人确认时间）
    expect(await currentLeader()).toBe(workers.W1);
    let got = (await api.get(`/api/handovers/${hid}`).expect(200)).body.handover;
    expect(got.status).toBe(HandoverStatus.PENDING);
    expect(got.completed_at).toBeNull();
    expect(got.incoming_confirmed_at).toBeNull();
    expect(got.outgoing_confirmed_at).not.toBeNull();

    // 交班人重复确认始终幂等，不会“替”接班人完成
    const replay = await api.post(`/api/handovers/${hid}/confirm-outgoing`).send({ worker_id: workers.W1 }).expect(200);
    expect(replay.body.redundant).toBe(true);
    expect(replay.body.switched).toBe(false);
    expect(await currentLeader()).toBe(workers.W1);

    // 到岗后重新走双向确认即可完成（接班人首次有效确认触发原子切换）
    await api.post(`/api/tickets/${ticketId}/presence/${workers.W5}/arrive`).expect(201);
    const done = await api.post(`/api/handovers/${hid}/confirm-incoming`).send({ worker_id: workers.W5 }).expect(200);
    expect(done.body.switched).toBe(true);
    expect(await currentLeader()).toBe(workers.W5);
    got = (await api.get(`/api/handovers/${hid}`).expect(200)).body.handover;
    expect(got.status).toBe(HandoverStatus.COMPLETED);
  });

  it('资质不能覆盖剩余作业窗口：422 QUALIFICATION_INSUFFICIENT，事务整体回滚', async () => {
    const api = apiOf(h);
    const { ticketId, workers } = sc;
    // W6 资质仅到 T0+1h，计划完工 T0+6h
    await api.post(`/api/tickets/${ticketId}/presence/${workers.W6}/arrive`).expect(201);
    const hid = (
      await api.post('/api/handovers').send({
        ticket_id: ticketId,
        position: Position.LEADER,
        incoming_worker_id: workers.W6,
        initiated_by: workers.W1
      })
    ).body.handover.id;
    await api.post(`/api/handovers/${hid}/confirm-outgoing`).send({ worker_id: workers.W1 }).expect(200);
    const fail = await api.post(`/api/handovers/${hid}/confirm-incoming`).send({ worker_id: workers.W6 });
    expect(fail.status).toBe(422);
    expect(fail.body.error.errorCode).toBe('QUALIFICATION_INSUFFICIENT');
    expect(fail.body.error.details.reason).toContain('覆盖');

    // 旧责任人未被结束，无新 assignment 插入
    expect(await currentLeader()).toBe(workers.W1);
    const got = (await api.get(`/api/handovers/${hid}`)).body.handover;
    expect(got.status).toBe(HandoverStatus.PENDING);
    expect(got.receipts.completion).toBeNull();
  });

  it('无任何资质证书的接班人被拒', async () => {
    const api = apiOf(h);
    const { ticketId, workers } = sc;
    await api.post(`/api/tickets/${ticketId}/presence/${workers.W8}/arrive`).expect(201);
    const hid = (
      await api.post('/api/handovers').send({
        ticket_id: ticketId,
        position: Position.LEADER,
        incoming_worker_id: workers.W8,
        initiated_by: workers.W1
      })
    ).body.handover.id;
    await api.post(`/api/handovers/${hid}/confirm-outgoing`).send({ worker_id: workers.W1 }).expect(200);
    const fail = await api.post(`/api/handovers/${hid}/confirm-incoming`).send({ worker_id: workers.W8 });
    expect(fail.status).toBe(422);
    expect(fail.body.error.errorCode).toBe('QUALIFICATION_INSUFFICIENT');
    expect(await currentLeader()).toBe(workers.W1);
  });

  it('接班人已在本票担任另一必需岗位：发起即 409，杜绝兼任导致原岗位空岗', async () => {
    const api = apiOf(h);
    const { ticketId, workers } = sc;
    // 尝试让现任安全员 W2 接任负责人
    const res = await api.post('/api/handovers').send({
      ticket_id: ticketId,
      position: Position.LEADER,
      incoming_worker_id: workers.W2,
      initiated_by: workers.W1
    });
    expect(res.status).toBe(409);
    expect(res.body.error.errorCode).toBe('INCOMING_HOLDS_OTHER_POSITION');
    expect(await currentLeader()).toBe(workers.W1);
  });
});

// ---------------------------------------------------------------- 验收 3
describe('验收3：重复确认和并发完成只形成一次交接', () => {
  it('同一方重复确认幂等；COMPLETED 后再确认返回 redundant，不产生第二次交接', async () => {
    const api = apiOf(h);
    const { ticketId, workers } = sc;
    await api.post(`/api/tickets/${ticketId}/presence/${workers.W5}/arrive`).expect(201);
    const hid = (
      await api.post('/api/handovers').send({
        ticket_id: ticketId,
        position: Position.LEADER,
        incoming_worker_id: workers.W5,
        initiated_by: workers.W1
      })
    ).body.handover.id;

    const r1 = await api.post(`/api/handovers/${hid}/confirm-outgoing`).send({ worker_id: workers.W1 }).expect(200);
    expect(r1.body.redundant).toBe(false);
    const r2 = await api.post(`/api/handovers/${hid}/confirm-outgoing`).send({ worker_id: workers.W1 }).expect(200);
    expect(r2.body.redundant).toBe(true);
    expect(r2.body.switched).toBe(false);

    await api.post(`/api/handovers/${hid}/confirm-incoming`).send({ worker_id: workers.W5 }).expect(200);
    // 完成后的迟到/重复确认
    const after = await api.post(`/api/handovers/${hid}/confirm-incoming`).send({ worker_id: workers.W5 }).expect(200);
    expect(after.body.redundant).toBe(true);
    expect(after.body.switched).toBe(false);
    const afterOut = await api.post(`/api/handovers/${hid}/confirm-outgoing`).send({ worker_id: workers.W1 }).expect(200);
    expect(afterOut.body.redundant).toBe(true);

    // 仅一条完成审计、一张完成回执
    const audit = (await api.get(`/api/tickets/${ticketId}/audit`)).body.audit;
    const completes = audit.filter((e: any) => e.event_type === 'HANDOVER_COMPLETED');
    expect(completes).toHaveLength(1);
    const receipts = (await api.get(`/api/tickets/${ticketId}/receipts`)).body.receipts;
    expect(receipts.filter((r: any) => r.type === 'HANDOVER_COMPLETED')).toHaveLength(1);
  });

  it('非交接当事人不能确认（PARTY_MISMATCH）', async () => {
    const api = apiOf(h);
    const { ticketId, workers } = sc;
    await api.post(`/api/tickets/${ticketId}/presence/${workers.W5}/arrive`);
    const hid = (
      await api.post('/api/handovers').send({
        ticket_id: ticketId,
        position: Position.LEADER,
        incoming_worker_id: workers.W5,
        initiated_by: workers.W1
      })
    ).body.handover.id;
    const wrong = await api.post(`/api/handovers/${hid}/confirm-outgoing`).send({ worker_id: workers.W3 });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.errorCode).toBe('PARTY_MISMATCH');
  });

  it('并发：两个相同岗位的交接竞争完成，只有一个成功，责任矩阵不变量不破', async () => {
    const api = apiOf(h);
    const { ticketId, workers } = sc;
    await api.post(`/api/tickets/${ticketId}/presence/${workers.W5}/arrive`);
    // 让 W5 具备多岗位资质（LEADER 已有），此处并发完成 LEADER 交接 + 重复完成同交接
    const hid = (
      await api.post('/api/handovers').send({
        ticket_id: ticketId,
        position: Position.LEADER,
        incoming_worker_id: workers.W5,
        initiated_by: workers.W1
      })
    ).body.handover.id;
    await api.post(`/api/handovers/${hid}/confirm-outgoing`).send({ worker_id: workers.W1 }).expect(200);

    // 并发两个“接班人确认”（第二个看到的可能是 PENDING 也可能是 COMPLETED）
    const results = await Promise.all([
      api.post(`/api/handovers/${hid}/confirm-incoming`).send({ worker_id: workers.W5 }),
      api.post(`/api/handovers/${hid}/confirm-incoming`).send({ worker_id: workers.W5 })
    ]);
    const switched = results.filter((r) => r.body.switched === true);
    const redundant = results.filter((r) => r.body.redundant === true);
    expect(switched).toHaveLength(1);
    expect(redundant).toHaveLength(1);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await currentLeader()).toBe(workers.W5);

    const receipts = (await api.get(`/api/tickets/${ticketId}/receipts`)).body.receipts;
    expect(receipts.filter((r: any) => r.type === 'HANDOVER_COMPLETED')).toHaveLength(1);
  });

  it('跨岗位：同一接班人不可能同时吃下两个必需岗位；后完成者被拒且无部分切换，原岗不空', async () => {
    const api = apiOf(h);
    const { ticketId, workers } = sc;
    // W5 同时具备负责人/安全员资质且到岗
    await api.post(`/api/tickets/${ticketId}/presence/${workers.W5}/arrive`);
    // 两个不同岗位、同一接班人的在途交接可以并存（发起时 W5 尚无在任岗位）
    const leaderHid = (
      await api.post('/api/handovers').send({
        ticket_id: ticketId, position: Position.LEADER,
        incoming_worker_id: workers.W5, initiated_by: workers.W1
      })
    ).body.handover.id;
    const safetyHid = (
      await api.post('/api/handovers').send({
        ticket_id: ticketId, position: Position.SAFETY_OFFICER,
        incoming_worker_id: workers.W5, initiated_by: workers.W2
      })
    ).body.handover.id;

    // 负责人交接先完成：W5 成为负责人
    await api.post(`/api/handovers/${leaderHid}/confirm-outgoing`).send({ worker_id: workers.W1 }).expect(200);
    await api.post(`/api/handovers/${leaderHid}/confirm-incoming`).send({ worker_id: workers.W5 }).expect(200);

    // 安全员交接再试图完成：W5 已任负责人 → 兼任冲突，整体回滚，安全员仍 W2
    await api.post(`/api/handovers/${safetyHid}/confirm-outgoing`).send({ worker_id: workers.W2 }).expect(200);
    const blocked = await api.post(`/api/handovers/${safetyHid}/confirm-incoming`).send({ worker_id: workers.W5 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.errorCode).toBe('INCOMING_HOLDS_OTHER_POSITION');

    const matrix = (await api.get(`/api/tickets/${ticketId}/responsibility`)).body.responsibility;
    const byPos = Object.fromEntries(matrix.map((e: any) => [e.position.code, e.worker_id]));
    expect(byPos.LEADER).toBe(workers.W5);
    expect(byPos.SAFETY_OFFICER).toBe(workers.W2); // 安全员没有空出
    const safetyHandover = (await api.get(`/api/handovers/${safetyHid}`)).body.handover;
    expect(safetyHandover.status).toBe(HandoverStatus.PENDING);
    expect(safetyHandover.completed_at).toBeNull();
  });

  it('一方确认后另一方拒绝：REJECTED 保留拒绝原因，责任不变，之后不能再确认', async () => {
    const api = apiOf(h);
    const { ticketId, workers } = sc;
    await api.post(`/api/tickets/${ticketId}/presence/${workers.W5}/arrive`);
    const hid = (
      await api.post('/api/handovers').send({
        ticket_id: ticketId, position: Position.LEADER,
        incoming_worker_id: workers.W5, initiated_by: workers.W1
      })
    ).body.handover.id;
    await api.post(`/api/handovers/${hid}/confirm-outgoing`).send({ worker_id: workers.W1 }).expect(200);
    const rej = await api.post(`/api/handovers/${hid}/reject`).send({
      worker_id: workers.W5,
      reason: '接班人发现自身防护装备不达标，拒绝接班'
    }).expect(200);
    expect(rej.body.handover.status).toBe(HandoverStatus.REJECTED);
    expect(rej.body.handover.rejected.by).toBe(workers.W5);
    expect(rej.body.handover.rejected.reason).toContain('防护装备');
    expect(await currentLeader()).toBe(workers.W1);

    const late = await api.post(`/api/handovers/${hid}/confirm-incoming`).send({ worker_id: workers.W5 });
    expect(late.status).toBe(409);
    expect(late.body.error.errorCode).toBe('HANDOVER_NOT_PENDING');
    // 拒绝后可重新发起
    const again = await api.post('/api/handovers').send({
      ticket_id: ticketId, position: Position.LEADER,
      incoming_worker_id: workers.W5, initiated_by: workers.W1
    }).expect(201);
    expect(again.body.handover.id).not.toBe(hid);
  });
});

// ---------------------------------------------------------------- 验收 4
describe('验收4：超时后迟到确认不能夺取责任', () => {
  it('超过截止时间：确认被拒 409 HANDOVER_TIMED_OUT，交接 TIMED_OUT，责任人不变', async () => {
    const api = apiOf(h);
    const { ticketId, workers } = sc;
    await api.post(`/api/tickets/${ticketId}/presence/${workers.W5}/arrive`);
    const init = await api.post('/api/handovers').send({
      ticket_id: ticketId,
      position: Position.LEADER,
      incoming_worker_id: workers.W5,
      initiated_by: workers.W1,
      timeout_ms: 30 * MIN
    }).expect(201);
    const hid = init.body.handover.id;

    // 交班人先确认
    await api.post(`/api/handovers/${hid}/confirm-outgoing`).send({ worker_id: workers.W1 }).expect(200);

    // 推进模拟时钟越过截止
    h.ctx.clock.advance(31 * MIN);

    // 接班人迟到确认
    const late = await api.post(`/api/handovers/${hid}/confirm-incoming`).send({ worker_id: workers.W5 });
    expect(late.status).toBe(409);
    expect(late.body.error.errorCode).toBe('HANDOVER_TIMED_OUT');

    const got = (await api.get(`/api/handovers/${hid}`)).body.handover;
    expect(got.status).toBe(HandoverStatus.TIMED_OUT);
    expect(got.timed_out_at).not.toBeNull();
    expect(got.completed_at).toBeNull();
    expect(await currentLeader()).toBe(workers.W1);

    // 超时回执存在
    const receipts = (await api.get(`/api/tickets/${ticketId}/receipts`)).body.receipts;
    expect(receipts.some((r: any) => r.type === 'HANDOVER_TIMED_OUT')).toBe(true);

    // 超时后交班人也不能再确认
    const lateOut = await api.post(`/api/handovers/${hid}/confirm-outgoing`).send({ worker_id: workers.W1 });
    expect(lateOut.status).toBe(409);
    expect(lateOut.body.error.errorCode).toBe('HANDOVER_TIMED_OUT');
  });

  it('双确认都未发生即超时：sweep 扫描结算 TIMED_OUT，之后可重新发起交接', async () => {
    const api = apiOf(h);
    const { ticketId, workers } = sc;
    await api.post(`/api/tickets/${ticketId}/presence/${workers.W5}/arrive`);
    const hid = (
      await api.post('/api/handovers').send({
        ticket_id: ticketId,
        position: Position.LEADER,
        incoming_worker_id: workers.W5,
        initiated_by: workers.W1,
        timeout_ms: 15 * MIN
      })
    ).body.handover.id;

    h.ctx.clock.advance(16 * MIN);
    const sweep = await api.post('/api/handovers/sweep-timeouts').expect(200);
    expect(sweep.body.timed_out.some((x: any) => x.id === hid)).toBe(true);

    // 可重新发起并正常完成
    const init2 = await api.post('/api/handovers').send({
      ticket_id: ticketId,
      position: Position.LEADER,
      incoming_worker_id: workers.W5,
      initiated_by: workers.W1
    }).expect(201);
    const hid2 = init2.body.handover.id;
    // 交接链指针：新交接 prev 指向... 前一交接 TIMED_OUT 非 COMPLETED，故 prev_handover_id 应为 null（链仅串联完成）
    expect(init2.body.handover.prev_handover_id).toBeNull();
    await api.post(`/api/handovers/${hid2}/confirm-outgoing`).send({ worker_id: workers.W1 }).expect(200);
    await api.post(`/api/handovers/${hid2}/confirm-incoming`).send({ worker_id: workers.W5 }).expect(200);
    expect(await currentLeader()).toBe(workers.W5);
  });

  it('在截止时间前完成则不受之后时钟推进影响', async () => {
    const api = apiOf(h);
    const { ticketId, workers } = sc;
    await api.post(`/api/tickets/${ticketId}/presence/${workers.W5}/arrive`);
    const hid = (
      await api.post('/api/handovers').send({
        ticket_id: ticketId,
        position: Position.LEADER,
        incoming_worker_id: workers.W5,
        initiated_by: workers.W1,
        timeout_ms: 30 * MIN
      })
    ).body.handover.id;
    h.ctx.clock.advance(29 * MIN);
    await api.post(`/api/handovers/${hid}/confirm-outgoing`).send({ worker_id: workers.W1 }).expect(200);
    await api.post(`/api/handovers/${hid}/confirm-incoming`).send({ worker_id: workers.W5 }).expect(200);
    h.ctx.clock.advance(2 * HOUR);
    const got = (await api.get(`/api/handovers/${hid}`)).body.handover;
    expect(got.status).toBe(HandoverStatus.COMPLETED);
  });
});

// ---------------------------------------------------------------- 验收 5
describe('验收5：销记记录能追溯最终责任人', () => {
  it('销记固化最终责任矩阵与回执；有在途交接时阻止销记；销记后拒绝一切交接操作', async () => {
    const api = apiOf(h);
    const { ticketId, workers } = sc;

    // 先完成一次负责人交接：W1 → W5
    await api.post(`/api/tickets/${ticketId}/presence/${workers.W5}/arrive`);
    const hid = (
      await api.post('/api/handovers').send({
        ticket_id: ticketId,
        position: Position.LEADER,
        incoming_worker_id: workers.W5,
        initiated_by: workers.W1
      })
    ).body.handover.id;
    await api.post(`/api/handovers/${hid}/confirm-outgoing`).send({ worker_id: workers.W1 });
    await api.post(`/api/handovers/${hid}/confirm-incoming`).send({ worker_id: workers.W5 });

    // 再起一个在途交接（安全员），此时销记应被阻止
    await api.post(`/api/tickets/${ticketId}/presence/${workers.W7}/arrive`);
    // 给 W7 安全员资质以便发起（发起不校验资格，但保持数据合理）
    await api.post(`/api/people/${workers.W7}/qualifications`).send({
      position: Position.SAFETY_OFFICER,
      valid_from: h.T0 - 365 * 24 * 60 * MIN,
      valid_to: h.T0 + 10 * 60 * MIN
    });
    const pendingHid = (
      await api.post('/api/handovers').send({
        ticket_id: ticketId,
        position: Position.SAFETY_OFFICER,
        incoming_worker_id: workers.W7,
        initiated_by: workers.W2
      })
    ).body.handover.id;
    const blocked = await api.post(`/api/tickets/${ticketId}/close`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.errorCode).toBe('PENDING_HANDOVERS_BLOCK_CLOSE');
    expect(blocked.body.error.details.handoverIds).toContain(pendingHid);

    // 拒绝该在途交接（带原因），然后销记
    const rej = await api.post(`/api/handovers/${pendingHid}/reject`).send({
      worker_id: workers.W2,
      reason: '安全员接班人现场状况不满足，停止交接'
    }).expect(200);
    expect(rej.body.handover.status).toBe(HandoverStatus.REJECTED);
    expect(rej.body.handover.rejected.reason).toContain('现场状况');

    const close = await api.post(`/api/tickets/${ticketId}/close`).expect(200);
    const finalByPos = Object.fromEntries(
      close.body.closure.final_responsibility.map((e: any) => [e.position.code, e.worker_id])
    );
    expect(finalByPos.LEADER).toBe(workers.W5);
    expect(finalByPos.SAFETY_OFFICER).toBe(workers.W2);
    expect(finalByPos.LIAISON).toBe(workers.W3);
    expect(finalByPos.GUARD).toBe(workers.W4);

    // 销记记录可单独追溯
    const closure = (await api.get(`/api/tickets/${ticketId}/closure`).expect(200)).body.closure;
    expect(closure.receipt_ref).toBeTruthy();
    const receipt = (await api.get(`/api/tickets/${ticketId}/receipts`)).body.receipts.find(
      (r: any) => r.ref === closure.receipt_ref
    );
    expect(receipt.type).toBe('TICKET_CLOSED');

    // 拒绝原因必须填写
    // （在新票上快速验证 REJECT_REASON_REQUIRED，避免销记后状态干扰）
    const fresh = makeHarness();
    try {
      const fsc = await setupStandardScenario(fresh);
      const h2 = (
        await supertest(fresh.app)
          .post('/api/handovers')
          .send({ ticket_id: fsc.ticketId, position: Position.LEADER, incoming_worker_id: fsc.workers.W5, initiated_by: fsc.workers.W1 })
      ).body.handover.id;
      const noReason = await supertest(fresh.app).post(`/api/handovers/${h2}/reject`).send({ worker_id: fsc.workers.W1, reason: '   ' });
      expect(noReason.status).toBe(400);
      expect(noReason.body.error.errorCode).toBe('REJECT_REASON_REQUIRED');
    } finally {
      fresh.stop();
    }
  });
});

// ---------------------------------------------------------------- 验收 6
describe('验收6：重启后交接链与审计顺序保持一致', () => {
  it('关闭重开数据库：交接链 prev 指针、审计 seq、责任矩阵、销记责任人全部一致', async () => {
    const api = apiOf(h);
    const { ticketId, workers } = sc;
    await api.post(`/api/tickets/${ticketId}/presence/${workers.W5}/arrive`);

    // 链 1：W1 → W5（负责人）
    const h1 = (
      await api.post('/api/handovers').send({
        ticket_id: ticketId, position: Position.LEADER,
        incoming_worker_id: workers.W5, initiated_by: workers.W1
      })
    ).body.handover.id;
    await api.post(`/api/handovers/${h1}/confirm-outgoing`).send({ worker_id: workers.W1 });
    await api.post(`/api/handovers/${h1}/confirm-incoming`).send({ worker_id: workers.W5 });

    // 推进一点时间，链 2：W5 → W1（负责人再交回，W1 已到岗）
    h.ctx.clock.advance(60 * MIN);
    const h2 = (
      await api.post('/api/handovers').send({
        ticket_id: ticketId, position: Position.LEADER,
        incoming_worker_id: workers.W1, initiated_by: workers.W5
      })
    ).body.handover.id;
    await api.post(`/api/handovers/${h2}/confirm-outgoing`).send({ worker_id: workers.W5 });
    await api.post(`/api/handovers/${h2}/confirm-incoming`).send({ worker_id: workers.W1 });

    // 重启前取证
    const chainBefore = (await api.get(`/api/tickets/${ticketId}/handover-chain?position=LEADER`)).body.chain;
    const auditBefore = (await api.get(`/api/tickets/${ticketId}/audit`)).body.audit;
    const completedBefore = chainBefore.filter((x: any) => x.status === HandoverStatus.COMPLETED);
    expect(completedBefore).toHaveLength(2);
    expect(completedBefore[1].prev_handover_id).toBe(completedBefore[0].id);

    await api.post(`/api/tickets/${ticketId}/close`).expect(200);

    // ===== 重启：同库文件重新装配，时钟恢复到当前时刻 =====
    const nowAtClose = h.ctx.clock.now();
    h.stop();
    const h2ctx = reopenHarness(h.dbFile, nowAtClose);
    try {
      const api2 = supertest(h2ctx.app);

      const ticket = (await api2.get(`/api/tickets/${ticketId}`)).body.ticket;
      expect(ticket.status).toBe('CLOSED');

      const chainAfter = (await api2.get(`/api/tickets/${ticketId}/handover-chain?position=LEADER`)).body.chain;
      const completedAfter = chainAfter.filter((x: any) => x.status === HandoverStatus.COMPLETED);
      expect(completedAfter.map((x: any) => x.id)).toEqual(completedBefore.map((x: any) => x.id));
      expect(completedAfter[1].prev_handover_id).toBe(completedAfter[0].id);
      // 链严格按 created_audit_seq 升序
      const seqs = chainAfter.map((x: any) => x.audit.created_seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

      // 取证在 close 之前完成；重启后审计应在原序列尾部多出 TICKET_CLOSED
      const auditAfter = (await api2.get(`/api/tickets/${ticketId}/audit`)).body.audit;
      expect(auditAfter).toHaveLength(auditBefore.length + 1);
      expect(auditAfter.slice(0, auditBefore.length).map((e: any) => e.event_type)).toEqual(
        auditBefore.map((e: any) => e.event_type)
      );
      expect(auditAfter[auditAfter.length - 1].event_type).toBe('TICKET_CLOSED');
      // seq 全局严格连续
      const allSeq = (await api2.get('/api/audit')).body.audit.map((e: any) => e.seq);
      expect(allSeq).toEqual([...allSeq.keys()].map((i) => i + 1));

      // 销记追溯最终责任人：LEADER 经两次交接后回到 W1
      const closure = (await api2.get(`/api/tickets/${ticketId}/closure`)).body.closure;
      const byPos = Object.fromEntries(closure.final_responsibility.map((e: any) => [e.position.code, e.worker_id]));
      expect(byPos.LEADER).toBe(workers.W1);
      expect(byPos.SAFETY_OFFICER).toBe(workers.W2);

      // 重启后销记票仍不能交接
      const refused = await api2.post('/api/handovers').send({
        ticket_id: ticketId, position: Position.LEADER,
        incoming_worker_id: workers.W5, initiated_by: workers.W1
      });
      expect(refused.status).toBe(409);
      expect(refused.body.error.errorCode).toBe('TICKET_CLOSED');
    } finally {
      h2ctx.stop();
    }
  });
});
