import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppContext } from '../../src/services/context.js';
import { createApp } from '../../src/api/app.js';
import type { Application } from 'express';

export interface Harness {
  ctx: AppContext;
  app: Application;
  dbFile: string;
  /** 固定基准时间：2026-01-10T08:00:00Z */
  T0: number;
  stop: () => void;
}

/** supertest 直接驱动 Express app，无需绑定端口 */
export function makeHarness(opts: { dbFile?: string; now?: number } = {}): Harness {
  const dbFile = opts.dbFile ?? mkdtempSync(join(tmpdir(), 'handover-')) + '/test.db';
  const T0 = opts.now ?? Date.parse('2026-01-10T08:00:00.000Z');
  const ctx = AppContext.create(dbFile, T0);
  const app = createApp(ctx);
  return {
    ctx,
    app,
    dbFile,
    T0,
    stop: () => ctx.close()
  };
}

/** 在同一数据库文件上重新装配（模拟服务重启），恢复虚拟时钟到 now */
export function reopenHarness(dbFile: string, now?: number): Harness {
  const ctx = AppContext.create(dbFile, now);
  const app = createApp(ctx);
  return {
    ctx,
    app,
    dbFile,
    T0: now ?? ctx.clock.now(),
    stop: () => ctx.close()
  };
}

/** 测试用时间常量（毫秒） */
export const MIN = 60_000;
export const HOUR = 60 * MIN;
