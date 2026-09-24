import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_SQL } from './schema.js';

export interface DbHandle {
  db: Database.Database;
  /**
   * 以 IMMEDIATE 方式开启写事务：第一时间获取 RESERVED 锁，
   * 保证“并发完成交接”在数据库层串行化，最终只有一个事务能命中切换。
   */
  txn: <T>(fn: () => T) => T;
  close: () => void;
}

export function createDatabase(file: string = ':memory:'): DbHandle {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_SQL);

  const begin = db.prepare('BEGIN IMMEDIATE');
  const commit = db.prepare('COMMIT');
  const rollback = db.prepare('ROLLBACK');

  const txn = <T>(fn: () => T): T => {
    begin.run();
    try {
      const result = fn();
      commit.run();
      return result;
    } catch (err) {
      if (db.inTransaction) rollback.run();
      throw err;
    }
  };

  return {
    db,
    txn,
    close: () => db.close()
  };
}
