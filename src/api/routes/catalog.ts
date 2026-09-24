import { Router } from 'express';
import type { AppContext } from '../../services/context.js';
import { Errors } from '../../domain/errors.js';
import { bodyOf, paramInt, parseTime, requirePosition, requireString } from '../validate.js';
import { personOut } from '../serializers.js';

/** 人员、资质、到离岗登记 */
export function catalogRouter(ctx: AppContext): Router {
  const router = Router();

  router.post('/people', (req, res, next) => {
    try {
      const body = bodyOf(req);
      const person = ctx.catalog.createPerson(requireString(body, 'name'), requireString(body, 'employee_no'));
      res.status(201).json({ person: personOut(person) });
    } catch (e) {
      next(e);
    }
  });

  router.get('/people', (_req, res) => {
    res.json({ people: ctx.catalog.listPeople().map(personOut) });
  });

  router.get('/people/:id', (req, res, next) => {
    try {
      res.json({ person: personOut(ctx.catalog.requirePerson(paramInt(req, 'id'))) });
    } catch (e) {
      next(e);
    }
  });

  router.post('/people/:id/qualifications', (req, res, next) => {
    try {
      const workerId = paramInt(req, 'id');
      const body = bodyOf(req);
      const position = requirePosition(body);
      const qual = ctx.catalog.addQualification(
        workerId,
        position,
        parseTime(body.valid_from ?? body.validFrom, 'valid_from'),
        parseTime(body.valid_to ?? body.validTo, 'valid_to')
      );
      res.status(201).json({ qualification: qual });
    } catch (e) {
      next(e);
    }
  });

  router.post('/tickets/:id/presence/:workerId/arrive', (req, res, next) => {
    try {
      const result = ctx.catalog.markArrival(paramInt(req, 'id'), paramInt(req, 'workerId'));
      res.status(201).json({ on_site: true, arrived_at: { epoch_ms: result.arrived_at, iso: new Date(result.arrived_at).toISOString() } });
    } catch (e) {
      next(e);
    }
  });

  router.post('/tickets/:id/presence/:workerId/departure', (req, res, next) => {
    try {
      ctx.catalog.markDeparture(paramInt(req, 'id'), paramInt(req, 'workerId'));
      res.json({ on_site: false });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
