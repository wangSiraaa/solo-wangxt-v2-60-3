import { Router } from 'express';
import type { AppContext } from '../../services/context.js';
import { Errors } from '../../domain/errors.js';
import { bodyOf, parseTime } from '../validate.js';
import { auditOut, handoverOut, receiptOut } from '../serializers.js';

/**
 * 管理/模拟控制接口：
 * - 虚拟时钟推进，用于确定性地制造“超时后迟到确认”；
 * - 主动扫描超时；全量审计/回执/交接查询。
 */
export function adminRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/clock', (_req, res) => {
    const now = ctx.clock.now();
    res.json({ now: { epoch_ms: now, iso: new Date(now).toISOString() } });
  });

  router.post('/clock/set', (req, res, next) => {
    try {
      const body = bodyOf(req);
      ctx.clock.setNow(parseTime(body.now, 'now'));
      const now = ctx.clock.now();
      res.json({ now: { epoch_ms: now, iso: new Date(now).toISOString() } });
    } catch (e) {
      next(e);
    }
  });

  router.post('/clock/advance', (req, res, next) => {
    try {
      const body = bodyOf(req);
      const delta = body.delta_ms ?? body.deltaMs;
      if (typeof delta !== 'number' || !Number.isFinite(delta)) {
        throw Errors.invalidPayload('字段 delta_ms 必须是整数毫秒数');
      }
      ctx.clock.advance(Math.trunc(delta));
      const now = ctx.clock.now();
      res.json({ now: { epoch_ms: now, iso: new Date(now).toISOString() } });
    } catch (e) {
      next(e);
    }
  });

  router.post('/handovers/sweep-timeouts', (_req, res) => {
    const timedOut = ctx.handovers.sweepTimeouts().map(handoverOut);
    res.json({ timed_out: timedOut });
  });

  router.get('/audit', (_req, res) => {
    res.json({ audit: ctx.ledger.listAudit().map(auditOut) });
  });

  router.get('/receipts', (_req, res) => {
    res.json({ receipts: ctx.ledger.listReceipts().map(receiptOut) });
  });

  return router;
}
