import { createDatabase, type DbHandle } from '../db/index.js';
import { Clock } from '../domain/clock.js';
import { CatalogService } from './catalog.js';
import { HandoverService } from './handover.js';
import { LedgerService } from './ledger.js';
import { TicketService } from './ticket.js';

/**
 * 应用装配根：统一持有数据库句柄、虚拟时钟与全部领域服务。
 * 重启时以同一数据库文件重新装配即可恢复全部状态（交接链、审计顺序均落库）。
 */
export class AppContext {
  readonly clock: Clock;
  readonly ledger: LedgerService;
  readonly catalog: CatalogService;
  readonly tickets: TicketService;
  readonly handovers: HandoverService;

  constructor(readonly handle: DbHandle, now?: number) {
    this.clock = new Clock(now);
    this.ledger = new LedgerService(handle, this.clock);
    this.catalog = new CatalogService(handle, this.clock);
    this.tickets = new TicketService(handle, this.clock, this.catalog, this.ledger);
    this.handovers = new HandoverService(handle, this.clock, this.tickets, this.catalog, this.ledger);
  }

  /** 只读用途的底层数据库句柄（测试/只读查询） */
  db() {
    return this.handle.db;
  }

  static create(file: string = ':memory:', now?: number): AppContext {
    return new AppContext(createDatabase(file), now);
  }

  close(): void {
    this.handle.close();
  }
}
