import { Router } from 'express';
import type { AppContext } from '../../services/context.js';
import { Position } from '../../domain/enums.js';
import { Errors } from '../../domain/errors.js';
import { bodyOf, paramInt, parseTime, requireInt, requirePosition, requireString } from '../validate.js';
import { auditOut, closureOut, handoverOut, receiptOut, responsibilityOut, ticketOut } from '../serializers.js';

/** 工作票生命周期、布岗、销记、责任矩阵、审计与回执查询 */
export function ticketRouter(ctx: AppContext): Router {
  const router = Router();

  router.post('/tickets', (req, res, next) => {
    try {
      const body = bodyOf(req);
      const rawPositions = body.positions;
      if (!Array.isArray(rawPositions) || rawPositions.length === 0) {
        throw Errors.invalidPayload('字段 positions 必须是非空数组（LEADER/SAFETY_OFFICER/LIAISON/GUARD）');
      }
      const positions: Position[] = [];
      for (const p of rawPositions) {
        const obj = { position: p };
        positions.push(requirePosition(obj));
      }
      const ticket = ctx.tickets.createTicket({
        code: requireString(body, 'code'),
        title: requireString(body, 'title'),
        plannedStart: parseTime(body.planned_start ?? body.plannedStart, 'planned_start'),
        plannedEnd: parseTime(body.planned_end ?? body.plannedEnd, 'planned_end'),
        positions
      });
      res.status(201).json({ ticket: ticketOut(ticket, ctx.tickets.listRequiredPositions(ticket.id)) });
    } catch (e) {
      next(e);
    }
  });

  router.get('/tickets/:id', (req, res, next) => {
    try {
      const id = paramInt(req, 'id');
      const ticket = ctx.tickets.requireTicket(id);
      ctx.handovers.sweepTimeouts();
      res.json({
        ticket: ticketOut(ticket, ctx.tickets.listRequiredPositions(id), ctx.tickets.getClosure(id))
      });
    } catch (e) {
      next(e);
    }
  });

  /** 计划开工后进入作业进行中 */
  router.post('/tickets/:id/start', (req, res, next) => {
    try {
      const id = paramInt(req, 'id');
      const ticket = ctx.tickets.markStarted(id);
      res.json({ ticket: ticketOut(ticket, ctx.tickets.listRequiredPositions(id)) });
    } catch (e) {
      next(e);
    }
  });

  /** 初始布岗 */
  router.post('/tickets/:id/assignments', (req, res, next) => {
    try {
      const id = paramInt(req, 'id');
      const body = bodyOf(req);
      const position = requirePosition(body);
      const workerId = requireInt(body, 'worker_id');
      ctx.tickets.assignPosition(id, position, workerId);
      res.status(201).json({ responsibility: responsibilityOut(ctx.tickets.getResponsibilitySnapshot(id)) });
    } catch (e) {
      next(e);
    }
  });

  router.get('/tickets/:id/responsibility', (req, res, next) => {
    try {
      const id = paramInt(req, 'id');
      ctx.tickets.requireTicket(id);
      res.json({ responsibility: responsibilityOut(ctx.tickets.getResponsibilitySnapshot(id)) });
    } catch (e) {
      next(e);
    }
  });

  /** 销记：固化最终责任人 */
  router.post('/tickets/:id/close', (req, res, next) => {
    try {
      const id = paramInt(req, 'id');
      const closure = ctx.tickets.closeTicket(id);
      const ticket = ctx.tickets.requireTicket(id);
      res.json({
        ticket: ticketOut(ticket, ctx.tickets.listRequiredPositions(id), closure),
        closure: closureOut(closure)
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/tickets/:id/closure', (req, res, next) => {
    try {
      const id = paramInt(req, 'id');
      ctx.tickets.requireTicket(id);
      const closure = ctx.tickets.getClosure(id);
      if (!closure) throw Errors.notFound(`工作票 ${id} 的销记记录`);
      res.json({ closure: closureOut(closure) });
    } catch (e) {
      next(e);
    }
  });

  router.get('/tickets/:id/handovers', (req, res, next) => {
    try {
      const id = paramInt(req, 'id');
      ctx.tickets.requireTicket(id);
      res.json({ handovers: ctx.handovers.listByTicket(id).map(handoverOut) });
    } catch (e) {
      next(e);
    }
  });

  /** 交接链（重启后顺序一致） */
  router.get('/tickets/:id/handover-chain', (req, res, next) => {
    try {
      const id = paramInt(req, 'id');
      ctx.tickets.requireTicket(id);
      const position = typeof req.query.position === 'string' ? (req.query.position as Position) : undefined;
      if (position && !Object.values(Position).includes(position)) {
        throw Errors.invalidPayload('position 查询参数非法');
      }
      res.json({ chain: ctx.handovers.getChain(id, position).map(handoverOut) });
    } catch (e) {
      next(e);
    }
  });

  router.get('/tickets/:id/audit', (req, res, next) => {
    try {
      const id = paramInt(req, 'id');
      ctx.tickets.requireTicket(id);
      res.json({ audit: ctx.ledger.listAudit(id).map(auditOut) });
    } catch (e) {
      next(e);
    }
  });

  router.get('/tickets/:id/receipts', (req, res, next) => {
    try {
      const id = paramInt(req, 'id');
      ctx.tickets.requireTicket(id);
      res.json({ receipts: ctx.ledger.listReceipts(id).map(receiptOut) });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
