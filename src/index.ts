import { AppContext } from './services/context.js';
import { createApp } from './api/app.js';

const DB_FILE = process.env.HANDOVER_DB ?? ':memory:';
const PORT = Number(process.env.PORT ?? 3000);

const ctx = AppContext.create(DB_FILE);
const app = createApp(ctx);

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`关键岗位交接服务已启动: port=${PORT} db=${DB_FILE}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      ctx.close();
      process.exit(0);
    });
  });
}

export { app, server };
