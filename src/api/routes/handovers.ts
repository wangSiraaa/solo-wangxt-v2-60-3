import { Router, type Request, type Response } from 'express';
import type { AppContext } from '../../services/context.js';
import { ConfirmParty } from '../../domain/enums.js';
import { bodyOf, paramInt, requireInt, requirePosition, requireString } from '../validate.js';
import { handoverOut, receiptOut } from '../serializers.js';

/**
 * 关键岗位交接：
 * - POST   /handovers                       发起（计划开工后、作业进行中）
 * - POST   /handovers/:id/confirm-outgoing  交班人确认
 * - POST   /handovers/:id/confirm-incoming  接班人确认
 * - POST   /handovers/:id/reject            任一方拒绝（必填原因）
 * - GET    /handovers/:id                   查询（自动结算超时）
 */
export function handoverRouter(ctx: AppContext): Router {
  const router = Router();

  router.post('/handovers', (req, res, next) => {
    try {
      const body = bodyOf(req);
      const timeoutRaw = body.timeout_ms ?? body.timeoutMs;
      const handover = ctx.handovers.initiate({
        ticketId: requireInt(body, 'ticket_id'),
        position: requirePosition(body),
        incomingWorkerId: requireInt(body, 'incoming_worker_id'),
        initiatedBy: requireInt(body, 'initiated_by'),
        outgoingWorkerId:
          typeof body.outgoing_worker_id === 'number' && Number.isInteger(body.outgoing_worker_id)
            ? (body.outgoing_worker_id as number)
            : undefined,
        timeoutMs:
          typeof timeoutRaw === 'number' && Number.isInteger(timeoutRaw) && timeoutRaw > 0
            ? (timeoutRaw as number)
            : undefined
      });
      const receipt = ctx.ledger.getReceiptByRef(handover.init_receipt_ref);
      res.status(201).json({
        handover: handoverOut(handover),
        receipt: receipt ? receiptOut(receipt) : null
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/handovers/:id', (req, res, next) => {
    try {
      const id = paramInt(req, 'id');
      ctx.handovers.sweepTimeouts();
      res.json({ handover: handoverOut(ctx.handovers.requireHandover(id)) });
    } catch (e) {
      next(e);
    }
  });

  const confirmHandler = (party: ConfirmParty) => (req: Request, res: Response, next: (e?: unknown) => void) => {
    try {
      const id = paramInt(req, 'id');
      const body = bodyOf(req);
      const workerId = requireInt(body, 'worker_id');
      const result = ctx.handovers.confirm(id, party, workerId);
      res.json({
        handover: handoverOut(result.handover),
        redundant: result.redundant,
        switched: result.switched,
        completion_receipt: result.handover.completion_receipt_ref
          ? receiptOut(ctx.ledger.getReceiptByRef(result.handover.completion_receipt_ref)!)
          : null
      });
    } catch (e) {
      next(e);
    }
  };

  router.post('/handovers/:id/confirm-outgoing', confirmHandler(ConfirmParty.OUTGOING));
  router.post('/handovers/:id/confirm-incoming', confirmHandler(ConfirmParty.INCOMING));

  router.post('/handovers/:id/reject', (req, res, next) => {
    try {
      const id = paramInt(req, 'id');
      const body = bodyOf(req);
      const workerId = requireInt(body, 'worker_id');
      // 空/缺失原因交给服务层统一报 REJECT_REASON_REQUIRED（HTTP 400）
      const reason = typeof body.reason === 'string' ? body.reason : '';
      const handover = ctx.handovers.reject(id, workerId, reason);
      res.json({ handover: handoverOut(handover) });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
