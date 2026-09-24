/**
 * 虚拟时钟：所有领域时间均取自此处，测试可任意推进/回拨，
 * 以确定性地验证“超时后迟到确认不能夺取责任”。
 */
export class Clock {
  private nowMs: number;

  constructor(startAt: number = Date.now()) {
    this.nowMs = startAt;
  }

  now(): number {
    return this.nowMs;
  }

  setNow(ms: number): void {
    this.nowMs = ms;
  }

  advance(ms: number): void {
    this.nowMs += ms;
  }

  toISO(ms: number = this.nowMs): string {
    return new Date(ms).toISOString();
  }
}
