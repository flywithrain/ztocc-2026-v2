# V2 异步事件驱动与全链路可观测性 —— 交付文档

> 本文件整合项目的 **README、架构设计、接口文档、重构假设说明、演示访问说明** 为一体，作为考试提交物的统一入口。
> 技术栈：Next.js 16 · TypeScript · Drizzle ORM · Neon PostgreSQL · Upstash QStash · Vercel Private Blob。

---

## 1. 项目简介

本项目是 V4.0 AI 考试的 V2 异步事件驱动交付版。它保留 Excel/PDF/JSON、多 Sheet、规则引擎、AI 规则和预览编辑能力，并将**正式导入链路重构为异步事件驱动 + 全链路可观测**架构：浏览器直传 Private Blob，`POST /api/import-tasks` 只接收轻量文件引用并立即返回，Outbox → QStash → Vercel Worker 异步解析、分批、批量校验与落库，全程以 `trace_id` 贯穿。

### 提交物清单

| 提交物 | 位置 |
|---|---|
| 在线系统 | https://ztocc-2026-v2.vercel.app/ |
| 源码仓库 | https://github.com/flywithrain/ztocc-2026-v2 |
| 压测数据脚本（20,000 条 SKU） | [`scripts/seed-data.ts`](../scripts/seed-data.ts)（`npm run db:seed-load`） |
| 10,000 行压测 Excel | [`test-data/10000-orders-fixed.xlsx`](../test-data/10000-orders-fixed.xlsx) |
| 正式链路压测脚本 | [`scripts/load-test.ts`](../scripts/load-test.ts)（`npm run load:test`） |
| 真实 Neon 集成测试 | [`scripts/integration-test-async-import.ts`](../scripts/integration-test-async-import.ts) |
| 压测报告（线上实测） | [`docs/LOAD_TEST_REPORT.md`](./LOAD_TEST_REPORT.md) |
| 数据库迁移 | [`drizzle/0000_free_tarantula.sql`](../drizzle/0000_free_tarantula.sql)、[`drizzle/0001_dusty_alex_wilder.sql`](../drizzle/0001_dusty_alex_wilder.sql) |

---

## 2. 演示访问说明

系统为考试演示环境，**当前无需演示账号**。可直接访问以下页面：

| 页面 | 地址 |
|---|---|
| 导入与预览（首页） | https://ztocc-2026-v2.vercel.app/ |
| 完整导入历史 | https://ztocc-2026-v2.vercel.app/import-history |
| 队列与性能监控 | https://ztocc-2026-v2.vercel.app/import-monitor |
| 全链路 Trace 检索 | https://ztocc-2026-v2.vercel.app/traces |
| 任务详情 | 从“导入历史”→“任务详情”进入 |
| Trace 详情 | 从“导入历史”→“Trace 链路”进入 |

如 Vercel 临时启用 Deployment Protection，评审前需关闭保护或提供公开可访问入口。无需向评审人员提供 Neon、Blob、QStash 或 AI 密钥。

---

## 3. 架构设计

### 3.1 异步任务流程

```text
Browser
  │
  ├─ 1. Vercel Private Blob Client Upload（原始文件）
  │
  └─ 2. POST /api/import-tasks（仅 Blob 引用、规则、SHA-256、大小）
           │
           ├─ Neon: import_tasks
           ├─ Neon: event_outbox（同一事务）
           └─ 返回 202 + task_id + trace_id
                    │
                    ▼
          Outbox Dispatcher / Lease Claim
                    │
                    ▼
       Upstash QStash Direct Publish + Flow Control
                    │
                    ▼
       POST /api/internal/import-events
       Vercel Serverless Worker / QStash 验签
                    │
         ┌──────────┴──────────┐
         ▼                     ▼
 ImportFileUploaded      ImportBatchCreated
 下载并解析原文件        读取 1,000 行批次 Blob
 写入批次 Blob           批量校验 SKU/外部编码
 生成批次 Outbox         批量写 shipments/orders
         └──────────┬──────────┘
                    ▼
       import_tasks / errors / performance / trace
```

### 3.2 Transactional Outbox

任务记录与首个 `ImportFileUploaded` 事件在同一 Neon 事务中创建，避免“任务已存在但消息丢失”。Dispatcher 使用 claim token、`publishing` 状态和 30 秒租约认领事件，再通过 QStash 发布，回写 provider message ID；失败指数退避，恢复控制面扫描过期租约重新投递。

### 3.3 Queue 与 Worker

QStash 是专业 HTTP 消息队列，负责持久化、并发控制、重试、签名、failure callback 与 DLQ。消费者是 Vercel Route `POST /api/internal/import-events`，每次投递触发函数，用 `Receiver.verify()` 校验 current/next signing key 后调用 `processImportEvent()`。Flow Control 默认并发 4，避免批次竞争 Neon 连接与任务热点行。

### 3.4 批量处理策略

- 原文件走 Private Blob 直传，不进 `/api/import-tasks` 大 JSON 请求体。
- Worker 复用 V2 `parse-engine.ts` 解析原文件，按 1,000 行拆批。
- QStash 消息只携带小型事件信封，批次数据存 Private Blob。
- 每批一次性 `IN` 查询 SKU、外部编码与已存在数据。
- `shipments`/`orders` 用批量 SQL / `jsonb_to_recordset` 写入，不逐行插入。
- `task_id + unit_id` 唯一约束、原子认领、稳定 UUID、`ON CONFLICT DO NOTHING` 提供幂等。
- 单行失败不回滚整批，最终可进入 `partial_success`。

### 3.5 全链路可观测性

`trace_id` 贯穿 API、Blob、Outbox、QStash、Worker、错误、性能日志与 DB 写入。`/traces` 支持按 task_id、trace_id、文件名、批次、行号范围、错误码组合检索；详情按 `API → Blob → Outbox → QStash Queue → Worker → DB` 聚合。监控页展示 queue wait、活跃 Worker、Outbox pending/failed、QStash 发布、DLQ、吞吐与 P50/P95/P99。

---

## 4. 重构假设说明

### 4.1 架构选择
同步请求不再承载 10,000 行 JSON。浏览器直传 Private Blob，`POST /api/import-tasks` 仅提交文件引用、规则 ID、SHA-256、大小与可选编辑清单引用。任务、`ImportFileUploaded` Outbox 与 Trace 在 Neon 原子创建并立即返回；QStash 调用 Worker 下载原文件、复用 V2 解析引擎解析，按 1,000 行拆批保存为 Private Blob，由 `ImportBatchCreated` 消费。

### 4.2 处理单元与容量规划
默认 `IMPORT_BATCH_SIZE=1000`、`IMPORT_WORKER_CONCURRENCY=4`。每批对最多 1,000 个 SKU 做一次 `IN` 批量查询，并把错误、运单、SKU 明细、批次计数、性能日志、Trace 合并到单次 Neon HTTP 事务提交。多个 Worker 对同一 `import_tasks` 行原子累加会产生热点锁竞争（首波 4 批 46–49 秒）；最终改为先写各自 `import_task_batches`，全部批次结束再聚合主任务，移除热点行竞争。线上压测 10,000 行总耗时 30 秒、吞吐约 2 万行/分钟。

### 4.3 Outbox 与专业队列可靠性
任务/批次与对应事件在 Neon 事务中原子提交，避免业务状态存在但事件丢失。Dispatcher 用 `FOR UPDATE SKIP LOCKED`、30 秒 lease 与 claim token 认领 `pending/failed` Outbox，`Client.publishJSON()` Direct Publish，固定 retries、retry delay、failure callback、去重与 Flow Control 并发 4；QStash 消费路由 `Receiver.verify()` 校验签名，最终失败回调同步 `dead-lettered`。正式主链路不再把 PostgreSQL 任务表伪装为外部消息队列，也不再使用旧 `IMPORT_QUEUE_WEBHOOK_URL`。

### 4.4 幂等、重试与恢复
稳定键 `task_id + unit_id`，数据库唯一索引保护；Worker 仅原子认领 `pending/failed` 单元，`completed` 再消费直接返回。性能日志同样以 `task_id + unit_id` 唯一。超过 5 分钟的 `processing` 单元可恢复为 `failed` 重新认领。运单/明细 ID 由 `task_id + 外部编码/行号 + SKU` 生成稳定 UUID，`ON CONFLICT DO NOTHING` 防重复插入；`batch_id=task_id` 便于核对与清理。

### 4.5 部分成功
行级业务错误不回滚整批：错误行写 `import_task_errors`，成功行继续落库，最终 `partial_success`。系统级数据库错误使整个单元失败并重试，避免不确定的部分提交。

### 4.6 SKU 降级
SKU 查询超过 `SKU_VALIDATION_TIMEOUT_MS`（默认 3 秒）时，仅执行本地必填/电话/数量/收货信息一致性校验，任务写 `degraded=true`、原因与 Trace 告警；服务恢复后新单元自动恢复主数据校验。降级任务需人工确认后重跑，避免静默修改已入库数据。

### 4.7 错误与隐私
手机号保存为 `138****0000`，地址仅保留前 6 位与末 2 位，中间脱敏，单值最多 500 字符。错误明细保留批次、全局行号、字段、错误码、原因、建议与 Trace ID。

### 4.8 压测数据与清理
`npm run db:seed-load` 定向重建 `SKU_%` 20,000 条并覆盖 `test-data/10000-orders-fixed.xlsx`（每 97 行插入一个非法 SKU）。Blob 默认保留 24 小时，QStash Schedule 每小时调用 `/api/internal/import-cleanup`，仅删除已结束任务且限于 `imports/source/`、`imports/manifests/`、`imports/batches/` 前缀。

### 4.9 重复上传与事件版本
文件计算 SHA-256 `file_hash` 并建索引，允许重复上传但保留可检索指纹。事件统一含 `event_id`、`event_type`、`schema_version`、`aggregate_id`、`trace_id`、`occurred_at`、`payload`；新增字段可选，语义不兼容时升级 `schema_version` 并行兼容。

### 4.10 待确认问题
1. 同一外部编码跨任务是否允许覆盖？
2. SKU 降级导入是否需要审批与补校验 SLA？
3. 大促峰值是超大单文件还是多租户并发？
4. 错误明细与 Trace 的长期保留期限？
5. QStash Free 配额耗尽后的预算与并发上限？
6. 队列积压、失败率、P99 的正式告警阈值与渠道？

---

## 5. 页面与接口文档

### 5.1 用户页面

| 页面 | 用途 |
|---|---|
| `/` | 上传、规则选择；≤2 MiB 预览，>2 MiB 直接创建异步任务 |
| `/preview` | 小文件预览、编辑、确认提交 |
| `/import-history` | 完整导入历史、筛选、分页、任务/Trace 双入口 |
| `/import-tasks/:taskId` | 2 秒轮询进度、批次、错误筛选、CSV 导出、降级提示 |
| `/import-monitor` | QStash/Outbox/DLQ、队列等待、吞吐、并发、P50/P95/P99 |
| `/traces` | 六维组合 Trace 检索 |
| `/traces/:traceId` | API → Blob → Outbox → Queue → Worker → DB 聚合时间线 |

### 5.2 上传与任务

| 方法与路径 | 说明 |
|---|---|
| `POST /api/import-files/upload` | 生成 Blob Client Upload 短期 token，限制 Private 路径、MIME、大小 |
| `POST /api/import-tasks` | 创建轻量异步任务；仅接受 Blob 引用、规则、哈希、MIME、大小、行数提示；完整 `rows` 返回 400 |
| `GET /api/import-tasks/:taskId` | 任务状态、阶段、进度、批次、吞吐、ETA |
| `GET /api/import-tasks/:taskId/errors` | 按错误码/字段/批次/行号筛选分页 |
| `GET /api/import-tasks/:taskId/errors/export` | 导出 CSV 错误明细 |
| `POST /api/import-tasks/:taskId/process` | 任务级恢复，只重投不绕过 QStash 消费 |
| `GET /api/import-history` | 按文件名/task_id/trace_id/状态筛选分页 |

### 5.3 Queue、恢复与清理

| 方法与路径 | 说明 |
|---|---|
| `POST /api/internal/import-events` | QStash 主消费者，current/next signing key 验签 |
| `POST /api/internal/import-events/failure` | 重试耗尽 failure callback，记 DLQ 并同步终态 |
| `GET|POST /api/internal/import-worker` | 恢复过期 lease、解析与卡死批次并重投 |
| `POST /api/internal/import-cleanup` | 删除已结束且超保留期的 Blob |

### 5.4 Trace 与监控

| 方法与路径 | 说明 |
|---|---|
| `GET /api/traces/search` | task_id/trace_id/文件名/批次/行号范围/错误码组合检索 |
| `GET /api/traces/:traceId` | 聚合任务、规则、事件、Outbox、批次、性能、错误、DB 写入数 |
| `GET /api/import-monitor/summary` | 队列、QStash、DLQ、吞吐、分位数、错误分布、慢批次、最近任务 |

内部 QStash Route 必须用官方签名；恢复与清理 Route 可配置独立应急 token。完整字段定义以 Route Handler 与 TypeScript 类型为准。

---

## 6. 本地启动与环境配置

### 6.1 安装启动
```bash
npm ci
npm run db:check
npm run dev
```
Windows 可运行根目录 `start.bat`。如需初始化空库：
```bash
npm run db:migrate
npm run db:seed
```
注意：当前考试 Neon 已执行迁移，勿重复初始化；不要把迁移/seed 加入 Vercel Build Command。

### 6.2 环境变量
生产必需：
```env
DATABASE_URL="..."
APP_BASE_URL="https://ztocc-2026-v2.vercel.app"
BLOB_READ_WRITE_TOKEN="..."
QSTASH_TOKEN="..."
QSTASH_CURRENT_SIGNING_KEY="..."
QSTASH_NEXT_SIGNING_KEY="..."
```
可选调优（均有安全默认值）：
```env
QSTASH_FLOW_CONTROL_KEY="v2-import-worker"
QSTASH_WORKER_PARALLELISM="4"
QSTASH_RETRIES="3"
IMPORT_BATCH_SIZE="1000"
IMPORT_BLOB_RETENTION_HOURS="24"
IMPORT_MAX_FILE_SIZE_MB="50"
IMPORT_WORKER_TOKEN="..."
IMPORT_CLEANUP_TOKEN="..."
```
所有真实密钥只放 Vercel/本地环境变量，不得提交 `.env.local`。

---

## 7. 压测数据与执行方式

### 7.1 生成 SKU 与 Excel
```bash
npm run db:seed-load
```
运行 `scripts/seed-data.ts`：定向重建 `SKU_%` 20,000 条、生成 `test-data/10000-orders-fixed.xlsx`（10,000 行 + 固定间隔非法 SKU），不清理生产业务表。

### 7.2 正式线上链路压测
```bash
LOAD_TEST_BASE_URL="https://ztocc-2026-v2.vercel.app" \
LOAD_TEST_RULE_ID="<已保存规则 UUID>" \
LOAD_TEST_CREATE_SAMPLES="20" \
npm run load:test
```
脚本执行：① 20 个小文件样本 → Blob 上传 P95 与任务创建 P95；② 1 个 10,000 行文件 → 全链路 2 秒轮询至终态。退出码校验：任务创建 P95 ≤ 1,000 ms、10,000 行 ≤ 60,000 ms、轮询无 HTTP 500/504。

### 7.3 当前线上压测结论
权威结果见 **[`docs/LOAD_TEST_REPORT.md`](./LOAD_TEST_REPORT.md)**（2026-08-07 线上实测）：

```text
10,000 行全链路：30.046 秒（目标 ≤ 60 秒）✅
吞吐：≈ 19,970 行/分钟（目标 ≥ 10,000）✅
成功 9,887 / 失败 113（104 非法 SKU + 10 外部编码占用）
任务创建 P95：≈ 900 ms（目标 ≤ 1,000 ms）✅
```

---

## 8. 自动化测试与发布门禁
```bash
npm run test:async-import
npm run db:check
npm run lint
npm run typecheck
npm run build
```
真实 Neon 消费核心测试需显式授权：
```bash
RUN_NEON_INTEGRATION_TEST=true npm run test:async-import:integration
```
覆盖：分批、部分成功、完成批次不可重复认领、物理行号与 `rowIndex` 分离、Blob 路径/域名/清理白名单、任务 API 拒绝 `rows`、QStash Publish/Flow Control/重试/failure callback、验签与伪造拒绝、message ID/delivery attempt、真实 Neon 批量写入/行级错误/Trace/性能日志/幂等/卡死恢复。

---

## 9. 故障模拟与恢复验证
1. **QStash 重试**：消费者短暂返回 500，确认重试后任务继续。
2. **重复投递幂等**：重投同一 event/task/unit，确认完成批次不重复认领、数据不翻倍。
3. **Outbox 租约恢复**：构造过期 `publishing + lease_expires_at`，调用恢复 Route 转可重试并重发。
4. **文件解析恢复**：构造过期 `parsing + parse_lease_expires_at`，恢复为 `parse_failed/pending` 并重投。
5. **批次卡死恢复**：超过阈值的 `processing` 批次重置可重试并经 QStash 重消费。
6. **DLQ 终态**：批次耗尽重试，Outbox/批次 dead-letter，父任务进入 `failed/dead_lettered`。
7. **SKU 降级**：模拟 SKU 查询超时，任务不中断且错误有降级码与修复建议。
8. **Blob 清理**：仅清理已结束且超 `blob_retain_until` 的 `imports/source|manifests|batches/`。

恢复 Route：`POST /api/internal/import-worker`、`POST /api/internal/import-cleanup`。生产建议在 QStash Schedules 创建 `v2-import-recovery (*/5 * * * *)` 与 `v2-import-blob-cleanup (0 * * * *)`。

---

## 10. 部署摘要
1. Vercel 连接 Neon、Private Blob、Upstash QStash 到 V2 Production。
2. 确认 `APP_BASE_URL=https://ztocc-2026-v2.vercel.app`、必需凭据作用于 Production。
3. 保持原有 V2/V3 与 AI 解析变量不变。
4. 开启 Functions → Fluid Compute；确认域名未被 Deployment Protection 阻挡。
5. Build Command 用 `npm run build`，不自动迁移/seed。
6. 创建恢复与 Blob 清理两个 QStash Schedule。
7. `/import-monitor` 确认 QStash 已配置、无异常 DLQ。
8. 执行正式线上压测与重试/幂等/恢复/DLQ 验收。

---

## 11. 已知边界
- 按考试单租户演示设计；真实多租户需补鉴权与租户隔离。
- 首页按 2 MiB 阈值分流（体验策略），不改变任务 API 的 50 MiB 文件上限。
- Blob 默认保留 24 小时，可调整以满足复核窗口。
- 历史兼容任务可能缺新 QStash message ID / Blob pathname；新任务写入完整元数据。
- 压测结论以 [`docs/LOAD_TEST_REPORT.md`](./LOAD_TEST_REPORT.md) 线上实测为准。