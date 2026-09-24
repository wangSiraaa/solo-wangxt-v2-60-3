import express, { Router, type Application, type NextFunction, type Request, type Response } from 'express';
import { AppContext } from '../services/context.js';
import { DomainError } from '../domain/errors.js';
import { catalogRouter } from './routes/catalog.js';
import { ticketRouter } from './routes/tickets.js';
import { handoverRouter } from './routes/handovers.js';
import { adminRouter } from './routes/admin.js';

export function createApp(ctx: AppContext): Application {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  const api = Router();
  api.use(catalogRouter(ctx));
  api.use(ticketRouter(ctx));
  api.use(handoverRouter(ctx));
  api.use(adminRouter(ctx));
  app.use('/api', api);

  app.use((req, res) => {
    res.status(404).json({ error: { errorCode: 'NOT_FOUND', message: `路径不存在: ${req.method} ${req.path}` } });
  });

  // 统一错误响应
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof DomainError) {
      res.status(err.httpStatus).json({
        error: { errorCode: err.errorCode, message: err.message, details: err.details ?? null }
      });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: { errorCode: 'INVALID_JSON', message: '请求体不是合法 JSON' } });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: { errorCode: 'INTERNAL', message } });
  });

  return app;
}
