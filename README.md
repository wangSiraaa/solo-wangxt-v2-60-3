# 作业进行中关键岗位交接服务

实现作业进行中关键岗位（**负责人 / 安全员 / 联络员 / 防护员**）的交接：计划开工之后、销记之前可发起交接，
交班人与接班人**双向确认**齐备时，在单个数据库事务内完成**原子责任切换**，并保证任一必需岗位始终有人负责、不兼任。

## 技术栈

- Node.js 20 + TypeScript（ESM）
- Express（HTTP/JSON）
- better-sqlite3（同步、ACID；`BEGIN IMMEDIATE` + 部分唯一索引 + 条件 UPDATE）
- Vitest + Supertest（集成/验收测试）

## 运行

```bash
npm install
npm test                 # 集成测试
npm run typecheck        # 类型检查
HANDOVER_DB=./data/app.db npm start   # 启动（默认 :memory:）
```

## 核心不变量

| 不变量 | 保证手段 |
| --- | --- |
| 仅 IN_PROGRESS（计划开工后、销记前）可交接 | 服务层状态门 + 审计 |
| 双向确认才切换 | `outgoing_confirmed_at` 与 `incoming_confirmed_at` 均非空才进入 finalize |
| 不空岗、不兼任 | 部分唯一索引：`(ticket_id,position) WHERE ended_at IS NULL`、`(ticket_id,worker_id) WHERE ended_at IS NULL` |
| 原子切换 | 旧在任行 `ended_at` 与新在任行 insert 在同一 `BEGIN IMMEDIATE` 事务；旧行条件 UPDATE `WHERE ended_at IS NULL` 保证并发仅一次命中 |
| 无部分切换 | 接班人到岗/资质覆盖窗口/交班人仍在任/未兼任任一不满足 → SAVEPOINT 回滚本次确认尝试，责任与另一方确认保留 |
| 超时迟到确认不夺权 | 确认前比较模拟时钟与 `confirm_deadline`；超时只置 `TIMED_OUT`（持久化），随后返回 409 |
| 重复/并发确认仅一次交接 | 已 COMPLETED 幂等返回 `redundant:true`；COMPLETED 收尾条件 `WHERE status='PENDING' AND confirm_deadline>=now` |
| 销记可追溯最终责任人 | `ticket_closures.final_responsibility` 固化责任矩阵 + `TICKET_CLOSED` 回执；有在途交接时阻止销记 |
| 重启一致 | 交接链 `prev_handover_id` + `created_audit_seq`、审计 `seq` 均落库，不依赖内存 |

另保留：发起时**责任快照**（全岗位 JSON）、**超时状态**、**拒绝原因**、**模拟回执关联**
（`init_receipt_ref` / `completion_receipt_ref`，回执见 `simulation_receipts`）。

## 状态机

```
PENDING ──双方确认齐备且复核通过──▶ COMPLETED      （终态：责任已切换）
   ├────任一方拒绝(reason)───────▶ REJECTED       （终态：责任不变）
   ├────now > confirm_deadline──▶ TIMED_OUT       （终态：责任不变）
   └────（销记前阻止在途交接）───▶ VOIDED          （兜底终态）
```

## 关键接口（详见 openapi/openapi.yaml）

- `POST /api/tickets` / `POST /api/tickets/:id/start` / `POST /api/tickets/:id/close`
- `POST /api/tickets/:id/assignments`（初始布岗）
- `POST /api/people/:id/qualifications`、`POST /api/tickets/:id/presence/:workerId/arrive`
- `POST /api/handovers`（发起）
- `POST /api/handovers/:id/confirm-outgoing` / `confirm-incoming`
- `POST /api/handovers/:id/reject`（必填 reason）
- `GET  /api/tickets/:id/handover-chain`、`/closure`、`/audit`、`/receipts`
- 模拟时钟：`POST /api/clock/advance { delta_ms }`、`POST /api/handovers/sweep-timeouts`

错误码见 OpenAPI `ErrorBody.errorCode`（如 `INCOMING_NOT_ARRIVED`、`QUALIFICATION_INSUFFICIENT`、
`HANDOVER_TIMED_OUT`、`PENDING_HANDOVERS_BLOCK_CLOSE`、`TICKET_CLOSED`）。

## 测试覆盖（tests/）

`handover.acceptance.test.ts` 逐条覆盖验收项：

1. 正常双确认后的原子责任切换（四岗不空/不兼任、快照、回执、审计顺序）；
2. 资质不足/未到岗 → 无部分切换（SAVEPOINT 回滚，责任不变，补正后可完成）；
3. 重复确认幂等、并发双确认只形成一次交接（一张完成回执/一条完成审计）；
4. 超时后迟到确认不能夺取责任（TIMED_OUT 持久化、sweep、截止前完成不受影响）；
5. 销记固化最终责任人、在途交接阻止销记、拒绝原因必填、销记后拒绝交接；
6. 关闭重开数据库后交接链 prev 指针、审计 seq 连续性与最终责任人一致。

`handover.service.test.ts` 覆盖服务层：切换时刻 ended==started 无空窗、四岗独立交接、
在途唯一、拒绝后重发、快照冻结。
