# 作业关键岗位交接服务（Key-Position Handover）

铁路/施工类作业票场景：作业进行中，**负责人 / 安全员 / 联络员 / 防护员**四类
必需岗位需要换人时，发起“关键岗位交接”。系统保证交接必须经交班人与接班人
**双向确认**、接班人满足到岗与资质条件，并在单个数据库事务内完成**原子责任
切换**——任何时刻不存在必需岗位短暂无人负责；销记后不得再交接，且最终责任人
与交接链可追溯。

## 技术栈

Python 3.11 · FastAPI · SQLAlchemy 2.0 · SQLite(WAL) · Pydantic v2 · pytest/httpx

## 快速开始

```bash
pip install -r requirements.txt          # 隔离环境自行选择
uvicorn app.main:app --reload            # http://127.0.0.1:8000/docs
pytest -q                                 # 集成测试（24 个用例）
python -m scripts.export_openapi          # 重新生成 docs/openapi.{json,yaml}
```

数据库默认 `sqlite:////workspace/data/app.db`，可用环境变量 `DATABASE_URL` 覆盖；
首次启动自动建表。

## 领域模型

| 表 | 说明 |
|---|---|
| `workers` | 人员、资质（可担任岗位列表）、到岗时间（离场置空） |
| `jobs` / `job_positions` | 作业票及开票时确定的必需岗位集合 |
| `assignments` | **每个作业+岗位唯一一行当前责任人**，交接只 UPDATE 这一行 |
| `handovers` | 交接单：双方确认状态、责任快照、超时、拒绝原因、链序 |
| `receipts` | 模拟回执（发起出具 / 完成生效 / 拒绝超时作废） |
| `handover_events` | 交接单审计事件，`(handover_id, seq)` 严格递增 |
| `job_events` | 作业级审计事件，`(job_id, seq)` 严格递增 |

### 交接状态机

```
                 交班人 CONFIRMED + 接班人 CONFIRMED
        PENDING ──────────────条件 UPDATE 成功──────────▶ COMPLETED
          │                       （同事务原子切换 assignments 责任人）
          ├─ 任一方 REJECT（必填原因）──────────────────▶ REJECTED
          └─ now ≥ expires_at（惰性/扫描/确认时）───────▶ EXPIRED
```

- 只有 `ACTIVE` 作业可发起交接；`PLANNED` 与 `CLOSED` 均拒绝（销记后不得交接）。
- 同一作业同一岗位至多一条 `PENDING`（SQLite 部分唯一索引 `ux_pending_handover`）。
- 接班人条件（发起时与完成瞬间各校验一次）：
  - **已到岗**（`arrived_at` 非空）；
  - **资质覆盖剩余作业窗口**（具备该岗位资质；作业开工后窗口为全周期子集，
    无独立到期建模）；
  - 不得同时担任该作业其他必需岗位（否则会造成另一岗位空缺）。
- 交班人必须是该岗位当前责任人；发起人必须是交班人或接班人本人。
- 交接超时默认 300 秒（建票时 30..86400 可配，发起时可覆盖）。

## 关键不变量与实现手段

1. **原子责任切换、零空岗窗口**：`assignments` 对 `(job_id, position)` 唯一，
   完成时在事务内执行带谓词的 `UPDATE assignments SET worker_id=接班人
   WHERE worker_id=交班人` 并校验 `rowcount=1`。不删除行、不插入第二行，
   责任人从交班人原子变为接班人，不存在“无人负责”的中间态。
2. **双向确认**：双方各有 `*_status / *_confirmed_at`；只有两者均为
   CONFIRMED 时才执行完成。
3. **不产生部分切换**：凑齐双确认的那次请求会**先复验**接班人条件；不通过
   时只记录 `BLOCKED` 审计事件，本次确认不落库、责任人完全不变。
4. **重复确认幂等**：已 COMPLETED 或同一方重复确认直接返回，不新增事件。
5. **并发完成只一次**：
   - 每个事务开始即 `BEGIN IMMEDIATE`（`app/db.py` 的 begin 事件钩子）取得
     SQLite 写锁，并发确认在数据库层面串行化；后进入的事务在锁内**重读**到
     对方已提交的确认；
   - 完成动作是带 `status=PENDING AND 双方CONFIRMED` 谓词的条件 UPDATE，
     `rowcount` 保证最多一次 COMPLETED；`chain_seq` 由
     `SET chain_seq=chain_seq+1` 原子递增。
6. **超时不夺权**：确认在写事务内重读 `expires_at`，到期则先提交 EXPIRED
   状态再返回 `HANDOVER_EXPIRED`；迟到的确认/拒绝一律 409，责任人保持交班人。
7. **责任快照与模拟回执**：发起时固化全岗位 `responsibility_snapshot`（之后
   不变，作为证据）；回执 `ISSUED → CONFIRMED/CANCELED` 与交接 1:1 关联持久化。
8. **销记追溯**：销记要求不存在未超时的 PENDING（到期的先惰性超时），并把
   `final_responsibility_snapshot` 与 `final_handover_chain` 固化到作业记录，
   同时写 `CLOSED` 作业事件。
9. **重启一致**：所有状态、链序、审计 seq 均持久化；`handover_events.seq`
   按交接单从 1 连续、`job_events.seq` 按作业从 1 连续，重启后按 seq 重放
   即为稳定顺序；重启前挂起的 PENDING 交接可在重启后继续完成。

## HTTP API 摘要

| 方法 & 路径 | 说明 |
|---|---|
| `POST /workers` · `GET /workers` · `GET /workers/{id}` | 登记/查询人员 |
| `POST /workers/{id}/arrival` · `/departure` | 到岗 / 离场 |
| `POST /jobs` · `GET /jobs` · `GET /jobs/{id}` | 建票/查询 |
| `POST /jobs/{id}/assignments` · `GET .../assignments` | 布岗 / 当前责任人 |
| `POST /jobs/{id}/start` · `/close` | 开工 / 销记 |
| `GET /jobs/{id}/events` | 作业级审计时间线 |
| `POST /handovers` | 发起交接 |
| `POST /handovers/{id}/confirm` · `/reject` | 双向确认 / 拒绝（带原因） |
| `GET /handovers/{id}` · `/events` | 交接详情（含快照、回执、事件） |
| `GET /handovers/chain?job_id=&position=` | 岗位交接链 |
| `POST /handovers/sweep-expired?job_id=` | 显式扫描超时单 |

完整契约见 [`docs/openapi.yaml`](docs/openapi.yaml) /
[`docs/openapi.json`](docs/openapi.json)，交互式文档 `/docs`。

### 典型流程

```bash
# 1) 建人（资质+到岗）、建票（默认四岗）、布岗、开工
curl -s localhost:8000/workers -d '{"employee_no":"L1","name":"张三",
  "qualifications":["LEADER"],"arrived":true}' -H 'Content-Type: application/json'
# ...其余岗位人员同理；建票 → /jobs/{id}/assignments → /jobs/{id}/start

# 2) 交班人发起交接（接班人 L2 具备 LEADER 资质且已到岗）
curl -s localhost:8000/handovers -d '{"job_id":1,"position":"LEADER",
  "outgoing_worker_id":1,"incoming_worker_id":2,"initiated_by_worker_id":1}' \
  -H 'Content-Type: application/json'

# 3) 双向确认（顺序无关、重复确认幂等）
curl -s localhost:8000/handovers/1/confirm -d '{"worker_id":1}' -H 'Content-Type: application/json'
curl -s localhost:8000/handovers/1/confirm -d '{"worker_id":2}' -H 'Content-Type: application/json'
# → status=COMPLETED，assignments 的 LEADER 已原子切换为 2，回执 CONFIRMED

# 4) 销记：最终责任人与交接链固化到作业
curl -s localhost:8000/jobs/1/close -d '{}' -H 'Content-Type: application/json'
```

### 错误码

`NOT_FOUND`(404)、`JOB_NOT_ACTIVE` / `PENDING_HANDOVER_EXISTS` /
`HANDOVER_NOT_PENDING` / `HANDOVER_EXPIRED` / `NOT_HANDOVER_PARTY` /
`CANNOT_REJECT` / `POSITION_BUSY` / `PENDING_HANDOVER_BLOCKS_CLOSE` /
`REQUIRED_POSITION_VACANT`(409)、
`INCOMING_NOT_ELIGIBLE`（`problems: NOT_ARRIVED | QUALIFICATION_MISMATCH |
HOLDS_OTHER_POSITION`）/ `INITIATOR_NOT_HOLDER`(422)、`BAD_REQUEST`(400)。

## 测试与验收对照

`tests/` 全部走 HTTP 集成栈（TestClient），并发用例通过线程直连同一数据库
验证写锁串行化；每用例独立临时库，时钟可注入固定/推进。

| 验收点 | 测试 |
|---|---|
| 正常双确认后的原子责任切换 | `test_1_atomic_switch.py`（含零空岗、DB 唯一约束、链序） |
| 资质不足/未到岗不产生部分切换 | `test_2_eligibility_reject.py`（含完成瞬间失去资格、拒绝留痕） |
| 重复确认 & 并发完成只一次 | `test_3_idempotency_concurrency.py`（单方重复、双方并发、线程压测） |
| 超时迟到确认不夺权 | `test_4_timeout.py`（惰性超时、扫描、销记阻塞、开工/销记边界） |
| 销记追溯最终责任人 | `test_5_close_traceability.py`（最终快照、交接链、快照不可变） |
| 重启后链与审计顺序一致 | `test_6_restart_consistency.py`（断池模拟重启、seq 连续、PENDING 续接） |

## 目录结构

```
app/
  domain/      enums / models / errors
  services/    clock, receipts, audit, jobs, handovers(核心)
  api/         schemas, serializers, routers, main
scripts/       export_openapi
docs/          openapi.json / openapi.yaml
tests/         6 个验收主题的集成测试
```
