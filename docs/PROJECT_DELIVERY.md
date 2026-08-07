# V2 异步事件驱动与全链路可观测性 —— 交付文档

> 本文件是考试「十三、提交物清单」中所有**文档类提交物**的统一入口，整合以下内容：
> 压测报告 / 架构设计 / 重构假设说明 / 接口文档 / README / 演示访问说明 / 部署手册 / 验收报告 / 反思题。
>
> 技术栈：Next.js 16 · TypeScript · Drizzle ORM · Neon PostgreSQL · Upstash QStash · Vercel Private Blob。

---

## 目录

1. [项目简介与提交物清单](#1-项目简介与提交物清单)
2. [演示访问说明](#2-演示访问说明)
3. [架构设计文档](#3-架构设计文档)
4. [重构假设说明](#4-重构假设说明)
5. [接口文档](#5-接口文档)
6. [README：本地启动与环境变量](#6-readme本地启动与环境变量)
7. [部署手册](#7-部署手册)
8. [压测报告（线上实测）](#8-压测报告线上实测)
9. [自动化测试与发布门禁](#9-自动化测试与发布门禁)
10. [故障模拟与恢复验证](#10-故障模拟与恢复验证)
11. [考试逐项验收报告](#11-考试逐项验收报告)
12. [反思题](#12-反思题)
13. [已知边界](#13-已知边界)

---

## 1. 项目简介与提交物清单

本项目是 V4.0 AI 考试的 V2 异步事件驱动交付版。它保留 Excel/PDF/JSON、多 Sheet、规则引擎、AI 规则和预览编辑能力，并将**正式导入链路重构为异步事件驱动 + 全链路可观测**架构：浏览器直传 Private Blob，`POST /api/import-tasks` 只接收轻量文件引用并立即返回，Outbox → QStash → Vercel Worker 异步解析、分批、批量校验与落库，全程以 `trace_id` 贯穿。

### 提交物清单（对应考试「十三」）

| 提交物 | 位置 |
|---|---|
| 在线系统 | https://ztocc-2026-v2.vercel.app/ |
| 源码仓库 | https://github.com/flywithrain/ztocc-2026-v2 |
| 压测数据脚本（20,000 条 SKU） | [`scripts/seed-data.ts`](../scripts/seed-data.ts)（`npm run db:seed-load`） |
| 10,000 行压测 Excel | [`test-data/10000-orders-fixed.xlsx`](../test-data/10000-orders-fixed.xlsx) |
| 正式链路压测脚本 | [`scripts/load-test.ts`](../scripts/load-test.ts)（`npm run load:test`） |
| 真实 Neon 集成测试 | [`scripts/integration-test-async-import.ts`](../scripts/integration-test-async-import.ts) |
| 压测报告 | 本文 §8 |
| 架构设计文档 | 本文 §3 |
| 《重构假设说明》 | 本文 §4 |
| 接口文档 | 本文 §5 |
| README | 本文 §6 + 根目录 [`README.md`](../README.md) |
| 演示账号或访问说明 | 本文 §2 |
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
| 任务详情 | 从"导入历史"→"任务详情"进入 |
| Trace 详情 | 从"导入历史"→"Trace 链路"进入 |

如 Vercel 临时启用 Deployment Protection，评审前需关闭保护或提供公开可访问入口。无需向评审人员提供 Neon、Blob、QStash 或 AI 密钥。

---

## 3. 架构设计文档

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

任务记录与首个 `ImportFileUploaded` 事件在同一 Neon 事务中创建，避免"任务已存在但消息丢失"。Dispatcher 使用 claim token、`publishing` 状态和 30 秒租约认领事件，再通过 QStash 发布，回写 provider message ID；失败指数退避，恢复控制面扫描过期租约重新投递。

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

## 5. 接口文档

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

## 6. README：本地启动与环境变量

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

### 6.3 压测数据与执行方式

**生成 SKU 与 Excel：**
```bash
npm run db:seed-load
```
运行 `scripts/seed-data.ts`：定向重建 `SKU_%` 20,000 条、生成 `test-data/10000-orders-fixed.xlsx`（10,000 行 + 固定间隔非法 SKU），不清理生产业务表。

**正式线上链路压测：**
```bash
LOAD_TEST_BASE_URL="https://ztocc-2026-v2.vercel.app" \
LOAD_TEST_RULE_ID="<已保存规则 UUID>" \
LOAD_TEST_CREATE_SAMPLES="20" \
npm run load:test
```
脚本执行：① 20 个小文件样本 → Blob 上传 P95 与任务创建 P95；② 1 个 10,000 行文件 → 全链路 2 秒轮询至终态。退出码校验：任务创建 P95 ≤ 1,000 ms、10,000 行 ≤ 60,000 ms、轮询无 HTTP 500/504。

---

## 7. 部署手册

### 7.1 当前架构

```text
浏览器 → Vercel Private Blob 客户端直传
       → POST /api/import-tasks（只提交 Blob 引用）
       → Neon import_tasks + Transactional Outbox
       → Upstash QStash Direct Publish（Flow Control 并发 4）
       → /api/internal/import-events（Vercel Serverless Worker）
       → 解析原始文件 / 处理 1,000 行批次 / 批量写 Neon
```

QStash 是队列与 HTTP 投递系统。消费者不是单独部署的常驻服务器，而是 V2 项目中的 `/api/internal/import-events` Vercel Function。QStash 主动 POST 消息，Vercel 按请求启动 Worker，代码验证 QStash 签名后调用 `processImportEvent()`。

### 7.2 已完成，不需要重复操作

- Neon 已连接 V2，继续使用当前 Production `DATABASE_URL`。
- `drizzle/0001_dusty_alex_wilder.sql` 已在当前 Neon 执行成功；不要再次手工迁移。
- Blob 已连接 V2，不需要重新创建 Store。
- QStash 已连接 V2，不需要再创建 FIFO Queue、Redis 或独立 Worker 项目。
- 原有 V2/V3 交互未改变，`V2_API_KEY`、`CORS_ALLOWED_ORIGIN`、V3 的 `V2_API_BASE_URL` 不需要修改。
- AI 规则解析未改变，原有 `DEEPSEEK_API_URL`、`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL` 不需要修改。
- 不需要新增全局 Middleware。
- 不要将 `db:migrate`、`db:push` 或 `db:seed-load` 加入 Vercel Build Command。

### 7.3 Vercel 环境变量

进入 `Vercel → V2 Project → Settings → Environment Variables`。

**本次唯一需要手工新增或确认的变量：**
```env
APP_BASE_URL="https://<V2正式域名>"
```
- 使用 V2 Production 的公开 HTTPS 域名；不带末尾 `/`；不要填写 V3 域名。
- 用于生成 QStash 的消费者地址和 failure callback 地址。

**Vercel 集成应自动注入，必须检查存在：**
```env
DATABASE_URL="..."
BLOB_READ_WRITE_TOKEN="..."
QSTASH_TOKEN="..."
QSTASH_CURRENT_SIGNING_KEY="..."
QSTASH_NEXT_SIGNING_KEY="..."
```

**可不配置，代码已有默认值：**
```env
QSTASH_FLOW_CONTROL_KEY="v2-import-worker"
QSTASH_WORKER_PARALLELISM="4"
QSTASH_RETRIES="3"
QSTASH_RETRY_DELAY="1000"
IMPORT_BATCH_SIZE="1000"
IMPORT_WORKER_CONCURRENCY="4"
SKU_VALIDATION_TIMEOUT_MS="3000"
IMPORT_BLOB_RETENTION_HOURS="24"
IMPORT_MAX_FILE_SIZE_MB="50"
```

**可选应急变量：**
```env
IMPORT_WORKER_TOKEN="独立长随机密钥"
IMPORT_CLEANUP_TOKEN="另一个独立长随机密钥"
```

不要再配置旧变量：`IMPORT_QUEUE_WEBHOOK_URL`、`IMPORT_QUEUE_WEBHOOK_TOKEN`、`CRON_SECRET`。

### 7.4 Vercel 项目设置

- 保持：Root Directory `v2`、Framework `Next.js`、Node.js `22.x`、Install `npm ci`、Build `npm run build`。
- `vercel.json` 已配置 `hkg1`，不需要手工设置函数地区。
- 开启 Functions → Fluid Compute。
- 检查 Deployment Protection：确认 Production 域名未被拦截。

### 7.5 创建两个 QStash Schedule

在 [Upstash Console](https://console.upstash.com/) → QStash → Schedules → Create Schedule 创建：

**卡死任务恢复：**
```text
Destination：https://<V2正式域名>/api/internal/import-worker
Cron：*/5 * * * *
Method：POST  Body：{}  Content-Type：application/json
```

**过期 Blob 清理：**
```text
Destination：https://<V2正式域名>/api/internal/import-cleanup
Cron：0 * * * *
Method：POST  Body：{"limit":25}  Content-Type：application/json
```

### 7.6 最终部署操作顺序

1. 确认 Neon、Blob、QStash 三个资源都连接到 V2，作用域包含 Production；Blob Store 为 Private 模式。
2. 在 V2 Production 环境变量中添加或确认 `APP_BASE_URL`。
3. 检查五个自动注入变量存在且作用域包含 Production。
4. 保持原有 V2/V3 和 AI 变量不变。
5. 检查 Fluid Compute 已开启。
6. 确认 Production 域名没有被 Deployment Protection 阻挡。
7. 重新部署 V2 Production。
8. 部署成功后创建两个 QStash Schedule。
9. 打开 `/import-monitor`，确认不再显示 `qstash.configured=false`。

### 7.7 部署后验收

1. 首页上传文件时，浏览器直接上传 Private Blob；
2. `/api/import-tasks` 请求体不含完整 `rows`，任务创建返回 202；
3. QStash Logs 能看到 `ImportFileUploaded` 与 `ImportBatchCreated`；
4. `/import-monitor` 显示 QStash published、Outbox、DLQ、队列等待和活跃 Worker；
5. 最终任务状态为 `completed` 或预期的 `partial_success`；
6. Vercel Function Logs 没有持续 500/504。

### 7.8 回滚

1. 暂停两个 QStash Schedule，必要时暂停新消息投递。
2. 在 Vercel Deployments 上一稳定版本执行 Promote/Instant Rollback。
3. 不要删除 Outbox、批次或 DLQ 记录，它们是恢复与审计依据。
4. 数据库迁移是向后兼容加列，旧应用可以继续运行；不要直接执行破坏性 `DROP COLUMN`。
5. 排障期间不要提前清理相关 source/manifest/batch Blob。

---

## 8. 压测报告（线上实测）

> 基于真实在线部署环境实测。部署地址：https://ztocc-2026-v2.vercel.app/

### 8.1 测试信息

- 测试时间：2026-08-07
- 目标环境：Vercel + Neon PostgreSQL + Upstash QStash + Vercel Private Blob
- 压测脚本：`scripts/load-test.ts`（真实浏览器同款链路：Client Upload 直传 Private Blob → POST `/api/import-tasks`）
- 解析规则：`压测标准订单10列`（规则 ID `ddae94cc-3458-4699-99a5-42dfc0709104`，经规则引擎配置，非硬编码）
- 压测文件：`test-data/10000-orders-fixed.xlsx`，10,000 行、5,000 个运单、104 条故意构造的非法 SKU
- SKU 主数据：20,000 条（`scripts/seed-data.ts` 生成）
- 处理单元：1,000 行/批，共 10 批；Worker 并发 4（QStash Flow Control）

### 8.2 核心指标

| 指标 | 实测 | 目标 | 结论 |
|---|---:|---:|---|
| 10,000 行全链路 | **30,046 ms** | ≤ 60,000 ms | 达标 |
| 处理吞吐 | **≈ 19,970 行/分钟** | ≥ 10,000 行/分钟 | 达标 |
| 任务创建 P95（20 样本） | ~900 ms | ≤ 1,000 ms | 达标 |
| 成功行 | 9,887 | — | 部分成功 |
| 失败行 | 113 | 104 条非法 SKU | 全部定位 |
| 完成批次 | 10 / 10 | 10 / 10 | 达标 |
| 行级错误 | 104 条 E001 | 可定位行和字段 | 达标 |
| 批次性能 P50 / P95 | 2,418 / 4,122 ms | 每批 1 条日志 | 达标 |
| Trace 事件 | 69 条 | 全链路可追踪 | 达标 |
| HTTP 错误 | 0 | 0 | 达标 |

> 失败行构成为 104 条非法 SKU（E001）+ 少数外部编码冲突（E005，由 P95 样本小文件复用了同一批外部编码 `LOAD_%` 所致，属压测方法论副作用，非业务缺陷）。

### 8.3 最终任务

- 任务 ID：`399786a3-c323-4f30-bec8-1f16f63acaeb`
- Trace ID：`19a49fca-d39a-4013-b12d-03aa8384be3a`
- 最终状态：`partial_success`（9,887 成功 + 113 失败，符合"部分成功 + 行级错误"设计）

### 8.4 批次性能明细（10 批，total_duration_ms）

`1602 / 2075 / 2338 / 2381 / 2418 / 2606 / 2966 / 3168 / 3439 / 4122`

- P50 ≈ 2,418 ms；P95 ≈ 4,122 ms
- 首波 4 个并发批次未出现热点锁竞争导致的秒级长尾

### 8.5 任务创建性能说明

任务创建采用轻量快路径：`POST /api/import-tasks` 仅承载文件引用（Blob URL、规则 ID、SHA-256、MIME、大小、行数提示），在同一 Neon 事务中原子写入 `import_tasks` 与 `event_outbox` 后立即返回 `202 + task_id + trace_id`，完整 `rows` 直接 400。因此任务创建 P95 ≈ 900 ms，满足 ≤ 1,000 ms 的"上传即返回"要求；实际批量解析与落库均在 QStash Worker 侧异步完成，不阻塞接口响应。

### 8.6 自动化与幂等证据

- 20 个 P95 样本任务全部到达终态（重复消费返回 0 批次，证明幂等）。
- 10,000 行任务端到端 30 s 内完成，无重复批次、无 HTTP 错误。
- 104 条非法 SKU 全部被 E001 行级错误捕获并定位；合法 SKU 批量校验与 UPSERT 落库成功。

### 8.7 优化与瓶颈总结

- 初版逐条 Outbox 更新 / 多分块 INSERT 导致长尾；现改为 `UPDATE ... RETURNING` 原子批量认领、单次 Neon HTTP 事务合并写入、任务级聚合进度代替热点锁竞争。
- 10,000 行全链路 30 s 达标，验证了批量校验、批量落库、部分成功、幂等、卡死恢复、Trace 与性能日志在真实线上的有效性。

### 8.8 结论

真实线上端到端验证全部达标：**10,000 行全链路 30 s（目标 60 s）、吞吐约 2 万行/分钟（目标 1 万）、任务创建 P95 ≈ 900 ms（目标 ≤ 1 s）**，Traces、性能日志、部分成功与行级错误机制均按设计工作。

---

## 9. 自动化测试与发布门禁
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

## 10. 故障模拟与恢复验证
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

## 11. 考试逐项验收报告

### 11.1 前置红线

| 红线 | 状态 | 证据 |
|---|---|---|
| 在线可访问系统 | 已提供 | `https://ztocc-2026-v2.vercel.app/` |
| 20,000 SKU 脚本 | 已完成 | `scripts/seed-data.ts`；真实 Neon 已确认 20,000 条 |
| 10,000 行 Excel | 已完成 | `test-data/10000-orders-fixed.xlsx`；10,000 行、104 个非法 SKU |
| 不同步逐行 INSERT | 已完成 | QStash Worker、1,000 行批次、`jsonb_to_recordset` 批量写库、单批事务 |
| 大文件不进入请求内存链路 | 已完成 | Vercel Private Blob Client Upload；任务 API ≤64 KiB 且显式拒绝 `rows` |
| 保存原始文件/可复读引用 | 已完成 | source Blob、edit manifest、batch Blob；默认 24 小时保留 |
| 必须引入队列或任务系统 | 已完成 | `@upstash/qstash` Direct Publish + Flow Control + retries + failure callback + DLQ |
| 无真实密钥入库 | 代码符合 | 所有凭据来自环境变量 |

### 11.2 十一个功能模块

| 模块 | 状态 | 说明 |
|---|---|---|
| 1. 压测数据准备 | 已完成 | 可重复灌入 20,000 SKU；生成 10,000 行 Excel |
| 2. 上传即返回 | 已完成 | 浏览器直传 Blob；任务接口只写轻量引用并返回 202；线上 P95 ≈ 900 ms |
| 3. Outbox 与队列 | 已完成 | Transactional Outbox；lease/claim；QStash message ID；指数退避；恢复扫描 |
| 4. Worker 异步处理 | 已完成 | `ImportFileUploaded` 解析事件与 `ImportBatchCreated` 批次事件分离 |
| 5. 幂等保护 | 已完成 | `task_id + unit_id` 唯一、原子认领、稳定 UUID、`ON CONFLICT DO NOTHING` |
| 6. 行级错误 | 已完成 | 行号、字段、脱敏值、错误码、原因、建议、Trace；筛选/分页/CSV |
| 7. 任务结果页 | 已完成 | 2 秒轮询、批次聚合、吞吐、ETA、错误和降级提示 |
| 8. 监控看板 | 已完成 | queue wait、active workers、Outbox pending/failed、QStash published、DLQ、P50/P95/P99 |
| 9. Trace 检索 | 已完成 | 独立 `/traces` 检索页支持 task_id、trace_id、文件名、批次号、行号范围、错误码；详情聚合 API、Outbox、QStash Queue、Worker、DB、性能和失败行 |
| 10. 容灾降级 | 已完成 | SKU 超时降级、QStash retry/DLQ、Outbox 恢复、卡死批次恢复 |
| 11. 假设说明 | 已完成 | 本文 §4 |

### 11.3 队列与对象存储静态证据

- 依赖：`@upstash/qstash@2.11.3`、`@vercel/blob@2.6.1`。
- Publisher：`Client.publishJSON()`，含 retries、retryDelay、failureCallback、Flow Control parallelism=4、内容去重。
- Receiver：`Receiver.verify()`，支持 current/next signing key，基于原始 body 和 URL 验签。
- Consumer：`/api/internal/import-events`；非 2xx 触发 QStash 重试。
- 最终失败：`/api/internal/import-events/failure` 同步 Outbox/批次/任务 `dead-lettered`。
- 恢复控制面：`/api/internal/import-worker`，不绕过 QStash 直接落库。
- Blob 清理：`/api/internal/import-cleanup`，只清理结束任务和三个导入隔离前缀。

### 11.4 数据模型与迁移

`drizzle/0001_dusty_alex_wilder.sql` 已应用到最终 Neon 数据库。迁移只增加 Blob、处理阶段、QStash delivery、Outbox lease/DLQ 字段，并将旧 `file_payload` 改为可空。

### 11.5 自动化与真实数据库结果

- 核心 + QStash/Blob 合同测试：11/11 通过。
- ESLint：通过（0 error）。
- TypeScript：通过。
- Drizzle schema check：通过。
- Next.js 16.2.6 生产构建：通过。
- 真实 Neon 消费核心集成测试：15 项断言通过。
- 线上压测：10,000 行 30.046 秒，吞吐 ≈ 19,970 行/分钟，任务创建 P95 ≈ 900 ms，全部达标。

### 11.6 Trace 检索验收

- 独立入口：顶部导航 `Trace 检索` → `/traces`。
- 六类搜索条件：`task_id`、`trace_id`、文件名、批次号、行号范围、错误码；支持组合查询。
- 详情聚合：`/api/traces/[traceId]` 返回 `import_tasks`、解析规则、原文件/兼容载荷引用、Trace 事件、Outbox、QStash message/delivery、批次、性能日志、行级错误和 DB 写入计数。
- 时间线按 API → Blob → Outbox → Queue/Worker → DB 分阶段展示。
- 线上压测任务验收：按 task_id 命中 1 个任务、69 个 Trace 事件；详情聚合 10 个批次、10 条性能日志。

### 11.7 安全与生产边界

- QStash Consumer 和 failure callback 强制官方签名验证。
- 恢复/清理控制面支持 QStash 签名；可选独立应急 token。
- Private Blob token 仅在服务端；客户端使用短期上传 token。
- Blob URL/pathname 限制为 Vercel Blob 域名和导入前缀；拒绝 `..`。
- 手机号、地址写错误日志前脱敏。
- 任务、错误、Trace、监控读取 API 仍缺登录/租户隔离；考试按单租户演示可接受。

---

## 12. 反思题

### 12.1 为什么 V2 下单导入链路不能继续采用同步阻塞方式？什么时候同步反而更简单可靠？

**为什么不能同步**

- **请求体与响应包过大**：10,000 行的完整 JSON 若随 `POST /api/import-tasks` 提交，请求体可达数 MB，函数 Max Duration 与内存暴涨，且浏览器会出现长时间无响应/超时崩溃。本项目把原文件改为 Blob Client Upload 直传，请求只带文件引用，接口 1 秒内返回。
- **处理时长不可控**：批量校验 + 批量落库 10,000 行在真实线上约 30 秒，远超同步请求合理等待范围。同步会导致网关/函数超时、客户端连接中断、重试造成重复写入。
- **缺少恢复与可观测性**：同步一旦失败难以定位到行级错误，也没有 trace、批次、重试入口。
- **吞吐与并发受限**：同步下每个请求占用一个函数实例直到完成，无法用队列做并发削峰与背压。

**什么时候同步更简单可靠**

- 数据量小（几十到几百行）、处理毫秒级、且用户需要即时结果（如小文件预览、单笔校验）。
- 对一致性要求为"要么全成要么全败"且无需跨系统重试的场景，同步事务天然原子。
- 低并发、无削峰需求，且失败可立即重试给用户。
- 本项目对小文件（≤2 MiB）仍走同步预览/编辑，只有大文件走异步，正是"按规模选择"。

### 12.2 处理单元变大或变小，会分别带来什么影响？

本项目的"处理单元"是批次（默认 1,000 行/批）。

**单元变大（如 5,000 行/批）**
- 优点：总事务数减少、批次 Blob 数减少、索引/日志写入合并更多，宏观吞吐可能提升。
- 缺点：单批事务变长，单次 Neon 事务持有时间与锁范围变大，失败重试代价高；一个批次失败重试时重放的数据量更大；P95 长尾更明显；内存与函数时长压力上升；行级错误隔离粒度变粗。

**单元变小（如 100 行/批）**
- 优点：单批轻、失败重试代价小、错误隔离更细、进度更平滑。
- 缺点：事务/调用次数变多，Outbox 与批次记录数量增大，网络往返与索引写入开销上升，吞吐下降；QStash 消息更密，队列与 Blob 碎片更多。

**本项目选择**：1,000 行/批是权衡点——单次 `IN` 批量查询 SKU/外部编码、单次 Neon 事务提交，兼顾吞吐（约 2 万行/分钟）与错误隔离。

### 12.3 如果吞吐目标从 10,000 单/分钟提升到 50,000 单/分钟，最先成为瓶颈的是 Worker、Redis 队列还是数据库写入？你会如何扩展？

**最先成为瓶颈的是数据库写入。** 10,000 行时已是多条批量 UPSERT 再加性能/Trace 合并写入 Neon；吞吐 ×5 后，单次 Neon HTTP 事务的写入量、索引维护、`import_tasks` 行级聚合与 `batch_performance_log`/`trace_events` 的写入将最先打满数据库连接与 IO。

**扩展方向：**
1. **数据库层**：区分读/写连接；订单与明细表按 `task_id` 分区或分表；把 `trace_events`/`batch_performance_log` 与核心业务表分离存储或异步批量刷写。
2. **Worker 层**：提高 QStash 并发并按批次水平扩容；用更大批次（如 2,000–5,000）摊薄事务开销；必要时把 Worker 从 Serverless 迁到常驻实例以消除冷启动。
3. **削峰与背压**：用 QStash 并发数作为数据库背压闸门，避免并发打爆 Neon 连接池。
4. **写入优化**：进一步合并 SQL（`jsonb_to_recordset` 多条批量）、关闭非关键索引的实时维护。

### 12.4 如果队列消息重复投递，为什么"业务幂等"比"消息只投递一次"更重要？

- **"只投递一次"在分布式下无法绝对保证**：网络重试、ack 丢失、消费者超时后重投，都会造成重复投递。
- **本项目用"业务幂等"兜底**：以 `task_id + unit_id` 为稳定键建立唯一约束，Worker 只原子认领 `pending/failed` 单元，`completed` 的单元再消费直接返回 0 批次；运单/明细 ID 由 `task_id + 外部编码/行号 + SKU` 生成稳定 UUID，`ON CONFLICT DO NOTHING` 防重复插入。
- **结论**：把"去重"下沉到业务数据层（唯一键 + 原子认领 + 幂等写），比在消息层强行保证"恰好一次"更可靠、更简单。

### 12.5 如果某个处理单元中有部分行失败，你认为应该整体回滚还是成功行先入库？为什么？

**应成功行先入库（部分成功），本项目即如此。**

- **业务可接受**：一行（如非法 SKU）失败不应拖垮整个单元的合法行；导入场景期望"能落多少落多少"，失败行进入 `import_task_errors` 供人工修正后重跑。
- **失败面最小化**：整体回滚会把 104 条非法 SKU 放大成整批失败，重试成本高且用户无法获得部分成果。
- **本项目的实现**：行级业务错误不回滚批次，错误写错误明细、成功行继续落库，任务最终 `partial_success`；只有系统级数据库错误才使整个单元 fail 并重试。

### 12.6 错误明细中需要保留原始值，但手机号和地址属于敏感信息，你如何平衡排障效率和数据安全？

- **先明确"排障需要什么"**：判断一行为何失败，通常只需要区分度足够的脱敏指纹（前缀、长度、格式特征），而非完整明文。
- **本项目采用存储时脱敏**：手机号保存为 `138****0000`（保留区号与末 4 位），地址仅保留前 6 位与末 2 位、中间脱敏，单值最多 500 字符。
- **结论**：用"脱敏后足够排障的指纹"替代"完整明文"，把数据安全做成默认，把明文访问做成例外且受控。

### 12.7 如果 Outbox 表持续增长到千万级，你会如何清理、归档和设计索引？

- **明确生命周期**：Outbox 事件在"已投递且被确认"后即无业务价值，是典型的可归档数据。
- **清理策略**：已成功/已确认的事件超过保留期（如 7–30 天）定期删除；终态失败（dead-lettered）保留更久供审计，超期归档；pending/failed（待投递）必须保留并加索引，不能盲删。
- **归档**：把超过保留期的已确认事件批量迁移到归档表，或用分区表按 `created_at` 按月分区，旧分区直接 `DETACH` 归档。
- **索引设计**：`(status, created_at)` 支撑 Dispatcher 高效扫描待投递事件；`(lease_expires_at)` 支撑租约/卡死恢复扫描；`(trace_id)` 支撑反查；避免在已投递事件上建过多索引。

### 12.8 如果 AI 生成的解析规则导致大量字段映射错误，监控系统如何帮助快速发现是规则问题而不是数据库问题？

核心思路：**用"按维度分组的失败/错误画像"把问题定位到规则层**。

- **错误码维度**：若大量失败集中在"字段映射/必填/格式"类错误码，指向规则配置；若集中在数据库超时/唯一约束冲突，则指向数据/写入层。
- **一致性维度**：单条规则 ID 下失败率骤升、且成功行特征与历史基线差异大，可判定为规则回归；数据库故障通常表现为跨规则、跨任务同时失败率抬升。
- **Trace 关联**：`trace_id` 贯穿 API → Blob → Outbox → QStash → Worker → DB。监控页把错误、批次、性能按 `trace_id`/`rule_id` 聚合，能直接看到该规则下"解析成功的行 vs 被标记失败的行"以及失败发生在校验前还是写入后。
- **统计与告警**：监控页展示按规则维度的错误分布、失败率、错误码占比、慢批次；当"某规则失败率 > 阈值 + 错误码以映射类为主"时触发规则告警（而非数据库告警）。

---

## 13. 已知边界

- 按考试单租户演示设计；真实多租户需补鉴权与租户隔离。
- 首页按 2 MiB 阈值分流（体验策略），不改变任务 API 的 50 MiB 文件上限。
- Blob 默认保留 24 小时，可调整以满足复核窗口。
- 历史兼容任务可能缺新 QStash message ID / Blob pathname；新任务写入完整元数据。
- 压测结论以本文 §8 线上实测为准。

---

## 附：核心设计自检对照

| 考点 | 本项目落点 |
|---|---|
| 异步任务 | Blob 直传 + 轻量 `POST /api/import-tasks` + QStash Worker |
| 批量处理 | 1,000 行/批、单次 `IN` 校验、`jsonb_to_recordset` 批量写 |
| 幂等 | `task_id+unit_id` 唯一约束、原子认领、稳定 UUID、`ON CONFLICT DO NOTHING` |
| Outbox | 事务内原子写入 + lease 认领 + 恢复控制面 |
| 可观测性 | `trace_id` 贯穿 + 六维 Trace 检索 + 监控聚合 |