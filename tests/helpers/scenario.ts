import supertest from 'supertest';
import type { Harness } from './harness.js';
import { MIN } from './harness.js';
import { Position } from '../../src/domain/enums.js';

/**
 * 预置一个“作业进行中、四岗齐备”的标准场景：
 *  计划窗口：T0-2h … T0+6h（当前时钟 T0，已开工）
 *  在任：  W1 负责人 / W2 安全员 / W3 联络员 / W4 防护员
 *  候选接班人：W5（资质到 T0+10h，未到岗）/ W6（资质过期到 T0+1h）
 *  另有 W7 已担任“防护员”场景时使用的兼任冲突人，W8 无资质。
 */
export interface Scenario {
  ticketId: number;
  workers: Record<string, number>;
  plannedEnd: number;
}

export async function setupStandardScenario(h: Harness, opts: { positions?: Position[] } = {}): Promise<Scenario> {
  const api = supertest(h.app);
  const T0 = h.T0;
  const plannedStart = T0 - 2 * 60 * MIN;
  const plannedEnd = T0 + 6 * 60 * MIN;
  const positions = opts.positions ?? [
    Position.LEADER,
    Position.SAFETY_OFFICER,
    Position.LIAISON,
    Position.GUARD
  ];

  // 人员
  const workerNames: Array<[string, string]> = [
    ['W1', 'E001'], ['W2', 'E002'], ['W3', 'E003'], ['W4', 'E004'],
    ['W5', 'E005'], ['W6', 'E006'], ['W7', 'E007'], ['W8', 'E008']
  ];
  const workers: Record<string, number> = {};
  for (const [name, no] of workerNames) {
    const res = await api.post('/api/people').send({ name, employee_no: no }).expect(201);
    workers[name] = res.body.person.id;
  }

  // 资质：现任 4 人 + W5/W7 覆盖到窗口结束之后；W6 仅到 T0+1h（不足）；W8 无资质
  const longQual = (workerId: number, position: Position) =>
    api.post(`/api/people/${workerId}/qualifications`).send({
      position,
      valid_from: T0 - 365 * 24 * 60 * MIN,
      valid_to: T0 + 10 * 60 * MIN
    });
  for (const [w, p] of [
    ['W1', Position.LEADER], ['W2', Position.SAFETY_OFFICER],
    ['W3', Position.LIAISON], ['W4', Position.GUARD]
  ] as const) {
    await longQual(workers[w], p).expect(201);
  }
  await longQual(workers.W5, Position.LEADER).expect(201);
  await longQual(workers.W5, Position.SAFETY_OFFICER).expect(201);
  await longQual(workers.W7, Position.GUARD).expect(201);
  await api.post(`/api/people/${workers.W6}/qualifications`).send({
    position: Position.LEADER,
    valid_from: T0 - 365 * 24 * 60 * MIN,
    valid_to: T0 + 60 * MIN
  }).expect(201);

  // 工作票
  const created = await api.post('/api/tickets').send({
    code: `WP-${Math.abs(plannedStart)}`,
    title: '接触网检修作业',
    planned_start: plannedStart,
    planned_end: plannedEnd,
    positions
  }).expect(201);
  const ticketId = created.body.ticket.id;

  // 布岗
  for (const [w, p] of [
    ['W1', Position.LEADER], ['W2', Position.SAFETY_OFFICER],
    ['W3', Position.LIAISON], ['W4', Position.GUARD]
  ] as const) {
    await api.post(`/api/tickets/${ticketId}/assignments`).send({ position: p, worker_id: workers[w] }).expect(201);
  }

  // 到岗登记（现任 4 人；接班人默认不到岗，由各用例按需登记）
  for (const w of ['W1', 'W2', 'W3', 'W4']) {
    await api.post(`/api/tickets/${ticketId}/presence/${workers[w]}/arrive`).expect(201);
  }

  // 进入作业进行中
  await api.post(`/api/tickets/${ticketId}/start`).expect(200);

  return { ticketId, workers, plannedEnd };
}

export function apiOf(h: Harness) {
  return supertest(h.app);
}
