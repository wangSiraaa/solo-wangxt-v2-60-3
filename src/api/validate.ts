import type { Request } from 'express';
import { Errors } from '../domain/errors.js';
import { Position } from '../domain/enums.js';

/** 解析 epoch 毫秒数或 ISO 时间字符串 */
export function parseTime(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  throw Errors.invalidPayload(`字段 ${field} 必须是 epoch 毫秒数或 ISO 8601 时间字符串`, { field });
}

export function requireInt(body: Record<string, unknown>, field: string): number {
  const v = body[field];
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  throw Errors.invalidPayload(`字段 ${field} 必须是正整数`, { field });
}

export function requireString(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v === 'string' && v.trim()) return v.trim();
  throw Errors.invalidPayload(`字段 ${field} 必须是非空字符串`, { field });
}

const POSITIONS = new Set<string>(Object.values(Position));

export function requirePosition(body: Record<string, unknown>, field = 'position'): Position {
  const v = body[field];
  if (typeof v === 'string' && POSITIONS.has(v)) return v as Position;
  throw Errors.invalidPayload(`字段 ${field} 必须是合法岗位编码：${[...POSITIONS].join('/')}`, { field });
}

export function paramInt(req: Request, name: string): number {
  const raw = req.params[name];
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw Errors.invalidPayload(`路径参数 ${name} 必须是正整数`);
  return n;
}

export function bodyOf(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}
