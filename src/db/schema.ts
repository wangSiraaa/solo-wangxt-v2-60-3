import type { Database } from 'better-sqlite3';

/**
 * 工作票关键岗位交接 —— 数据库结构
 *
 * 设计要点：
 * - assignments 对每个必需岗位至多一条有效（无 ended_at）记录，并用部分唯一索引强约束，
 *   交接切换原子化为 UPDATE 旧行 ended_at + INSERT 新行，杜绝“短暂无人负责/一人双岗”。
 * - handovers 保存发起时责任快照（JSON）、双向确认时间、超时截止、拒绝原因、模拟回执引用。
 * - audit_log 仅追加，seq 为严格递增审计顺序；重启后顺序不依赖内存状态。
 */
export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS people (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  employee_no TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS tickets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'CREATED',
  planned_start   INTEGER NOT NULL,   -- 计划开工（epoch ms，模拟时钟）
  planned_end     INTEGER NOT NULL,   -- 计划完工（资格需覆盖到此）
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS required_positions (
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id),
  position   TEXT NOT NULL,
  PRIMARY KEY (ticket_id, position)
);

CREATE TABLE IF NOT EXISTS qualifications (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id      INTEGER NOT NULL REFERENCES people(id),
  position       TEXT NOT NULL,
  valid_from     INTEGER NOT NULL,
  valid_to       INTEGER NOT NULL,
  UNIQUE (worker_id, position, valid_from)
);

CREATE TABLE IF NOT EXISTS presence (
  ticket_id   INTEGER NOT NULL REFERENCES tickets(id),
  worker_id   INTEGER NOT NULL REFERENCES people(id),
  on_site     INTEGER NOT NULL DEFAULT 0,
  arrived_at  INTEGER,
  departed_at INTEGER,
  PRIMARY KEY (ticket_id, worker_id)
);

CREATE TABLE IF NOT EXISTS assignments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER NOT NULL REFERENCES tickets(id),
  position    TEXT NOT NULL,
  worker_id   INTEGER NOT NULL REFERENCES people(id),
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  handover_id INTEGER REFERENCES handovers(id)  -- 由哪次交接接任
);
-- 每个工作票、每个岗位至多一条在任（ended_at IS NULL）记录
CREATE UNIQUE INDEX IF NOT EXISTS ux_assignment_active
  ON assignments(ticket_id, position) WHERE ended_at IS NULL;
-- 同一人在同一工作票上至多担任一个在任岗位（禁止兼任，保证切换后不会空岗/双岗冲突）
CREATE UNIQUE INDEX IF NOT EXISTS ux_assignment_worker_active
  ON assignments(ticket_id, worker_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS handovers (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id                INTEGER NOT NULL REFERENCES tickets(id),
  position                 TEXT NOT NULL,
  outgoing_worker_id       INTEGER NOT NULL REFERENCES people(id),
  incoming_worker_id       INTEGER NOT NULL REFERENCES people(id),
  initiated_by             INTEGER NOT NULL REFERENCES people(id),
  status                   TEXT NOT NULL DEFAULT 'PENDING',
  initiated_at             INTEGER NOT NULL NOT NULL,
  confirm_deadline         INTEGER NOT NULL,
  outgoing_confirmed_at    INTEGER,
  incoming_confirmed_at    INTEGER,
  completed_at             INTEGER,
  rejected_by              INTEGER REFERENCES people(id),
  rejected_at              INTEGER,
  reject_reason            TEXT,
  timed_out_at             INTEGER,
  voided_at                INTEGER,
  prev_handover_id         INTEGER REFERENCES handovers(id),  -- 交接链指针
  responsibility_snapshot  TEXT NOT NULL,                       -- 发起时全岗位责任快照 JSON
  init_receipt_ref         TEXT NOT NULL,
  completion_receipt_ref   TEXT,
  created_audit_seq        INTEGER NOT NULL,
  completed_audit_seq      INTEGER
);
CREATE INDEX IF NOT EXISTS ix_handover_ticket ON handovers(ticket_id, id);
CREATE INDEX IF NOT EXISTS ix_handover_status ON handovers(status, confirm_deadline);

CREATE TABLE IF NOT EXISTS simulation_receipts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ref         TEXT NOT NULL UNIQUE,   -- 业务可引用回执号
  type        TEXT NOT NULL,
  ticket_id   INTEGER REFERENCES tickets(id),
  handover_id INTEGER REFERENCES handovers(id),
  created_at  INTEGER NOT NULL,
  payload     TEXT NOT NULL          -- JSON
);

CREATE TABLE IF NOT EXISTS ticket_closures (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id             INTEGER NOT NULL UNIQUE REFERENCES tickets(id),
  closed_at             INTEGER NOT NULL,
  final_responsibility  TEXT NOT NULL,  -- 销记时最终责任矩阵 JSON（可追溯最终责任人）
  receipt_ref           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT, -- 严格递增审计顺序
  seq         INTEGER NOT NULL UNIQUE,           -- 显式顺序号，重启后保持一致
  event_type  TEXT NOT NULL,
  ticket_id   INTEGER,
  handover_id INTEGER,
  actor_id    INTEGER,
  occurred_at INTEGER NOT NULL,
  payload     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clock_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  now_ms INTEGER NOT NULL
);
`;
