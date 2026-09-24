import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import supertest from 'supertest';
import { makeHarness } from './helpers/harness.js';
import { setupStandardScenario } from './helpers/scenario.js';
import { HandoverStatus, Position, TicketStatus } from '../src/domain/enums.js';

const spec = readFileSync(join(process.cwd(), 'openapi/openapi.yaml'), 'utf8');

describe('OpenAPI 契约', () => {
  it('文档存在且声明 3.0', () => {
    expect(spec).toContain('openapi: 3.0.3');
  });

  it('覆盖全部关键路径与方法', () => {
    for (const path of [
      '/tickets:',
      '/tickets/{id}/start:',
      '/tickets/{id}/close:',
      '/tickets/{id}/closure:',
      '/tickets/{id}/handover-chain:',
      '/handovers:',
      '/handovers/{id}/confirm-outgoing:',
      '/handovers/{id}/confirm-incoming:',
      '/handovers/{id}/reject:',
      '/handovers/sweep-timeouts:',
      '/clock/advance:'
    ]) {
      expect(spec).toContain(path);
    }
  });

  it('枚举与领域代码一致', () => {
    for (const p of Object.values(Position)) expect(spec).toContain(p);
    for (const s of Object.values(HandoverStatus)) expect(spec).toContain(s);
    for (const s of Object.values(TicketStatus)) expect(spec).toContain(s);
  });

  it('错误码全部在文档中登记', () => {
    for (const code of [
      'BEFORE_PLANNED_START',
      'TICKET_CLOSED',
      'INCOMING_NOT_ARRIVED',
      'QUALIFICATION_INSUFFICIENT',
      'PENDING_HANDOVER_EXISTS',
      'HANDOVER_NOT_PENDING',
      'HANDOVER_TIMED_OUT',
      'PARTY_MISMATCH',
      'REJECT_REASON_REQUIRED',
      'PENDING_HANDOVERS_BLOCK_CLOSE',
      'OUTGOING_NOT_CURRENT',
      'INCOMING_HOLDS_OTHER_POSITION'
    ]) {
      expect(spec).toContain(code);
    }
  });
});

describe('API 冒烟：错误响应符合 ErrorBody 契约', () => {
  it('404/400 使用统一 error 结构', async () => {
    const h = makeHarness();
    try {
      const missing = await supertest(h.app).get('/api/handovers/9999');
      expect(missing.status).toBe(404);
      expect(missing.body.error.errorCode).toBe('NOT_FOUND');

      const bad = await supertest(h.app).post('/api/tickets').send({ code: 'X' });
      expect(bad.status).toBe(400);
      expect(bad.body.error.errorCode).toBe('INVALID_PAYLOAD');

      const badJson = await supertest(h.app)
        .post('/api/tickets')
        .set('Content-Type', 'application/json')
        .send('{not-json');
      expect(badJson.status).toBe(400);
      expect(badJson.body.error.errorCode).toBe('INVALID_JSON');
    } finally {
      h.stop();
    }
  });

  it('健康检查', async () => {
    const h = makeHarness();
    try {
      const res = await supertest(h.app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    } finally {
      h.stop();
    }
  });

  it('一次完整交接经 HTTP 的关键字段齐全（契约形状）', async () => {
    const h = makeHarness();
    try {
      const sc = await setupStandardScenario(h);
      const api = supertest(h.app);
      await api.post(`/api/tickets/${sc.ticketId}/presence/${sc.workers.W5}/arrive`);
      const init = await api
        .post('/api/handovers')
        .send({ ticket_id: sc.ticketId, position: Position.LEADER, incoming_worker_id: sc.workers.W5, initiated_by: sc.workers.W1 })
        .expect(201);
      expect(init.body.handover.position).toMatchObject({ code: Position.LEADER, label: '负责人' });
      expect(init.body.handover.confirm_deadline).toHaveProperty('iso');
      expect(init.body.handover.requires.both_confirmations).toBe(true);
      const id = init.body.handover.id;
      await api.post(`/api/handovers/${id}/confirm-outgoing`).send({ worker_id: sc.workers.W1 });
      const done = await api.post(`/api/handovers/${id}/confirm-incoming`).send({ worker_id: sc.workers.W5 }).expect(200);
      expect(done.body.completion_receipt.ref).toMatch(/^RCPT-/);
    } finally {
      h.stop();
    }
  });
});
