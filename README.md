# 万能导入 V2：异步事件驱动与全链路可观测性

本项目是 V4.0 AI 考试的 V2 交付版本。技术栈为 Next.js 16、TypeScript、Drizzle ORM、Neon PostgreSQL、Upstash QStash 与 Vercel Private Blob。系统保留 Excel/PDF/JSON、多 Sheet、规则引擎、AI 规则和预览编辑能力，并将正式导入链路重构为异步事件驱动架构。

## 1. 正式提交入口

| 项目 | 地址或文件 |
|---|---|
| 在线系统 | [https://ztocc-2026-v2.vercel.app/](https://ztocc-2026-v2.vercel.app/) |
| 源码仓库 | [https://github.com/flywithrain/ztocc-2026-v2](https://github.com/flywithrain/ztocc-2026-v2) |
| 考试交付文档总目录 | [`docs/exam-delivery/`](./docs/exam-delivery/README.md) |
| 20,000 条 SKU 生成脚本 | [`scripts/seed-data.ts`](./scripts/seed-data.ts) |
| 10,000 行压测 Excel | [`test-data/10000-orders-fixed.xlsx`](./test-data/10000-orders-fixed.xlsx) |
| 正式链路压测脚本 | [`scripts/load-test.ts`](./scripts/load-test.ts) |
| 真实 Neon 集成测试 | [`scripts/integration-test-async-import.ts`](./scripts/integration-test-async-import.ts) |
| 压测报告 | [`docs/exam-delivery/LOAD_TEST_REPORT.md`](./docs/exam-delivery/LOAD_TEST_REPORT.md) |
| 架构设计与重构假设 | [`docs/exam-delivery/REFACTORING_ASSUMPTIONS.md`](./docs/exam-delivery/REFACTORING_ASSUMPTIONS.md) |
| 部署与环境配置 | [`docs/exam-delivery/DEPLOYMENT_GUIDE.md`](./docs/exam-delivery/DEPLOYMENT_GUIDE.md) |
| 考试逐项验收 | [`docs/exam-delivery/EXAM_ACCEPTANCE_REPORT.md`](./docs/exam-delivery/EXAM_ACCEPTANCE_REPORT.md) |
| 考试原题 | [`docs/exam-delivery/考试要求-文件版本.html`](./docs/exam-delivery/考试要求-文件版本.html) |
| 数据库迁移 | [`drizzle/0000_free_tarantula.sql`](./drizzle/0000_free_tarantula.sql)、[`drizzle/0001_dusty_alex_wilder.sql`](./drizzle/0001_dusty_alex_wilder.sql) |

## 2. 演示访问说明

系统为考试演示环境，当前无需演示账号。可直接访问以下页面：

- 导入与预览：[首页](https://ztocc-2026-v2.vercel.app/)
- 完整导入历史：[导入历史](https://ztocc-2026-v2.vercel.app/import-history)
- 队列与性能监控：[导入监控](https://ztocc-2026-v2.vercel.app/import-monitor)
- 全链路检索：[Trace 检索](https://ztocc-2026-v2.vercel.app/traces)
- 任务详情：从“导入历史”的“任务详情”进入
- Trace 详情：从“导入历史”的“Trace 链路”进入

如果 Vercel 临时启用了 Deployment Protection，评审前需关闭保护或提供可公开访问的演示入口。无需向评审人员提供 Neon、Blob、QStash 或 AI 密钥。

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

任务记录与首个 `ImportFileUploaded` 事件在同一 Neon 事务中创建，避免“任务已存在但消息丢失”。Dispatcher 使用 claim token、`publishing` 状态和租约认领事件，再通过 QStash 发布。发布结果保存 provider message ID；失败使用指数退避，恢复控制面扫描过期租约并重新投递。

### 3.3 Queue 与 Worker

QStash 是本项目的专业 HTTP 消息队列，负责持久化消息、并发控制、重试、签名、failure callback 和 DLQ。消费者不是独立常驻服务器，而是 Vercel Route：

```text
POST /api/internal/import-events
```

每次 QStash 投递都会触发 Vercel Function，函数验证 `Upstash-Signature` 后调用 `processImportEvent()`。Flow Control 默认并发为 4，避免大量批次同时竞争 Neon 连接和任务热点行。

### 3.4 批量处理策略

- 原文件通过 Private Blob 直传，不进入 `/api/import-tasks` 的大 JSON 请求体。
- Worker 复用 V2 规则引擎解析原文件，并按 1,000 行拆分批次。
- QStash 消息仅携带小型事件信封，不携带 1,000 行 PII 数据；批次数据保存在 Private Blob。
- 每批一次性查询 SKU、外部编码和已存在业务数据。
- `shipments`、`orders` 使用批量 SQL/`jsonb_to_recordset` 写入，不逐行查询或 INSERT。
- `task_id + unit_id` 唯一约束、原子认领、稳定 UUID 和 `ON CONFLICT DO NOTHING` 提供幂等保护。
- 单行失败不会回滚整批；成功行继续落库，最终任务可进入 `partial_success`。

### 3.5 全链路可观测性

`trace_id` 贯穿 API、Blob、Outbox、QStash、Worker、错误记录、性能日志和数据库写入。`/traces` 支持按 task_id、trace_id、文件名、批次、行号范围和错误码组合检索；详情按以下阶段聚合：

```text
API → Blob → Outbox → QStash Queue → Worker → DB
```

监控页展示 queue wait、活跃 Worker、Outbox pending/failed、QStash 发布、DLQ、吞吐以及 P50/P95/P99。

## 4. 页面与接口文档

### 4.1 用户页面

| 页面 | 用途 |
|---|---|
| `/` | 原文件上传、规则选择；≤2 MiB 文件进入预览，>2 MiB 文件直接创建异步任务 |
| `/preview` | 小文件行数据预览、编辑与确认提交 |
| `/import-history` | 完整导入历史、筛选、分页、task_id/trace_id、任务/Trace 双入口 |
| `/import-tasks/:taskId` | 2 秒轮询进度、批次、错误筛选、CSV 导出、降级提示 |
| `/import-monitor` | QStash/Outbox/DLQ、队列等待、吞吐、并发、P50/P95/P99 |
| `/traces` | 六维组合 Trace 检索 |
| `/traces/:traceId` | API → Blob → Outbox → Queue → Worker → DB 聚合时间线 |

### 4.2 上传与任务

| 方法与路径 | 说明 |
|---|---|
| `POST /api/import-files/upload` | 生成 Vercel Blob Client Upload 短期 token；限制 Private Blob 路径、MIME 和大小 |
| `POST /api/import-tasks` | 创建轻量异步任务；仅接受 Blob 引用、规则 ID、哈希、MIME、大小和行数提示；完整 `rows` 返回 400 |
| `GET /api/import-tasks/:taskId` | 查询任务状态、阶段、进度、批次、吞吐和 ETA |
| `GET /api/import-tasks/:taskId/errors` | 按错误码、字段、批次、行号筛选并分页查询错误 |
| `GET /api/import-tasks/:taskId/errors/export` | 导出 CSV 错误明细 |
| `POST /api/import-tasks/:taskId/process` | 任务级恢复控制面，只恢复并重投，不直接绕过 QStash 消费 |
| `GET /api/import-history` | 按文件名、task_id、trace_id、状态筛选完整导入历史并分页 |

### 4.3 Queue、恢复与清理

| 方法与路径 | 说明 |
|---|---|
| `POST /api/internal/import-events` | QStash 主消费者；官方 current/next signing key 验签 |
| `POST /api/internal/import-events/failure` | 重试耗尽后的 failure callback，记录 DLQ 并同步批次/任务终态 |
| `GET|POST /api/internal/import-worker` | 恢复过期 Outbox lease、文件解析与卡死批次，并重新投递 |
| `POST /api/internal/import-cleanup` | 删除已结束且超过保留期的 source/manifest/batch Blob |

### 4.4 Trace 与监控

| 方法与路径 | 说明 |
|---|---|
| `GET /api/traces/search` | 按 task_id、trace_id、文件名、批次号、行号范围、错误码组合检索 |
| `GET /api/traces/:traceId` | 聚合任务、规则、原文件引用、事件、Outbox、QStash、批次、性能、错误和 DB 写入数 |
| `GET /api/import-monitor/summary` | 返回队列、QStash、DLQ、吞吐、阶段分位数、错误分布、慢批次和最近任务 |

内部 QStash Route 必须使用官方签名；恢复与清理 Route 也可配置独立应急 token。接口的完整字段定义以 Route Handler 与 TypeScript 类型为准。

## 5. 本地启动

### 5.1 安装与启动

```bash
npm ci
npm run db:check
npm run dev
```

Windows 可运行项目根目录的 `start.bat`，它会打开用户可见的独立控制台，便于查看日志并通过 `Ctrl+C` 或关闭窗口停止服务。

如需初始化空数据库：

```bash
npm run db:migrate
npm run db:seed
```

注意：当前考试 Neon 已执行迁移；不要重复初始化，不要把 `db:migrate`、`db:push` 或 seed 命令加入 Vercel Build Command。

### 5.2 环境变量

完整契约见 [`.env.example`](./.env.example)。本次异步链路的生产必需变量为：

```env
DATABASE_URL="..."
APP_BASE_URL="https://ztocc-2026-v2.vercel.app"
BLOB_READ_WRITE_TOKEN="..."
QSTASH_TOKEN="..."
QSTASH_CURRENT_SIGNING_KEY="..."
QSTASH_NEXT_SIGNING_KEY="..."
```

可选调优变量均有安全默认值：

```env
QSTASH_FLOW_CONTROL_KEY="v2-import-worker"
QSTASH_WORKER_PARALLELISM="4"
QSTASH_RETRIES="3"
QSTASH_RETRY_DELAY="1000"
IMPORT_BATCH_SIZE="1000"
IMPORT_BLOB_RETENTION_HOURS="24"
IMPORT_MAX_FILE_SIZE_MB="50"
IMPORT_WORKER_TOKEN="..."
IMPORT_CLEANUP_TOKEN="..."
```

代码不读取 `BLOB_STORE_ID`，无需配置。原有 V2/V3 服务间变量与 DeepSeek AI 解析变量本次未改变；已有生产配置可保持不动。所有真实密钥只放在 Vercel/本地环境变量中，不得提交 `.env.local`。

## 6. 压测数据与执行方式

### 6.1 生成 20,000 条 SKU 和 10,000 行 Excel

```bash
npm run db:seed-load
```

该命令运行 [`scripts/seed-data.ts`](./scripts/seed-data.ts)：

- 定向重建 `SKU_%` 压测 SKU 主数据，共 20,000 条；
- 生成 [`test-data/10000-orders-fixed.xlsx`](./test-data/10000-orders-fixed.xlsx)；
- Excel 共 10,000 行业务数据，并按固定间隔插入非法 SKU，用于验证部分成功和行级错误；
- 不无条件清空生产业务表。

### 6.2 正式线上链路压测

先在系统中保存一条可用解析规则，然后运行：

```bash
LOAD_TEST_BASE_URL="https://ztocc-2026-v2.vercel.app" \
LOAD_TEST_RULE_ID="<已保存的规则 UUID>" \
LOAD_TEST_CREATE_SAMPLES="20" \
npm run load:test
```

脚本执行两类测试：

1. 20 个小文件样本：计算 Private Blob 上传 P95 和轻量任务创建 P95；
2. 1 个 10,000 行文件：经过 Private Blob → 任务 API → Outbox → QStash → Worker → Neon，2 秒轮询直至终态。

脚本输出 task_id、trace_id、P95、端到端耗时、吞吐、成功/失败行数、HTTP 错误数，并用退出码校验：

- 任务创建 P95 ≤ 1,000 ms；
- 10,000 行端到端 ≤ 60,000 ms；
- 轮询过程无 HTTP 500/504。

### 6.3 当前压测结论

[`docs/exam-delivery/LOAD_TEST_REPORT.md`](./docs/exam-delivery/LOAD_TEST_REPORT.md) 已记录真实 Neon 数据库处理核心基线：

```text
10,000 行总耗时：56.798 秒
吞吐：11,536 行/分钟
目标：≤ 60 秒
```

该结果证明批量数据库处理能力已达标，但不是对最终 Vercel + Private Blob + QStash 端到端链路的替代证明。最终线上成绩应使用上面的 `scripts/load-test.ts` 在最新部署版本重新生成，并把输出与截图补入压测报告。

## 7. 自动化测试与发布门禁

```bash
npm run test:async-import
npm run db:check
npm run lint
npm run typecheck
npm run build
```

真实 Neon 消费核心测试必须显式授权：

```bash
RUN_NEON_INTEGRATION_TEST=true npm run test:async-import:integration
```

覆盖范围包括：

- 10,000 行按 1,000 行稳定分批；
- 部分成功、最终状态聚合和完成批次不可重复认领；
- 原始物理行号与规范化 `rowIndex` 分离；
- Blob pathname、域名、前缀、大小和清理白名单；
- 任务 API 禁止完整 `rows`；
- QStash Direct Publish、Flow Control、重试、failure callback；
- current/next signing key 验签以及伪造/正文篡改拒绝；
- QStash message ID、delivery attempt；
- 真实 Neon 批量写入、行级错误、Trace、性能日志、幂等和卡死恢复。

当前详细验证结果见 [`docs/exam-delivery/EXAM_ACCEPTANCE_REPORT.md`](./docs/exam-delivery/EXAM_ACCEPTANCE_REPORT.md)。

## 8. 故障模拟与恢复验证

所有故障模拟都应使用独立测试任务，不要修改无关生产记录。推荐顺序：

1. **QStash 重试**：让测试消费者短暂返回 500，确认 QStash Logs 出现重试，恢复后任务继续处理。
2. **重复投递幂等**：对同一 event/task/unit 重投，确认完成批次不能再次认领，shipments/orders/错误数不重复增长。
3. **Outbox 租约恢复**：构造过期 `publishing + lease_expires_at` 测试事件，调用恢复 Route，确认转为可重试并重新发布。
4. **文件解析恢复**：构造过期 `processing_stage=parsing + parse_lease_expires_at` 测试任务，确认恢复为 `parse_failed/pending` 并重投文件事件。
5. **批次卡死恢复**：构造超过阈值的 `processing` 批次，确认重置为可重试状态并通过 QStash 重新消费。
6. **DLQ 终态**：让批次事件耗尽重试，确认 Outbox 与批次记录 dead-letter，父任务进入终态 `failed/dead_lettered`，监控红色告警可见。
7. **SKU 降级**：模拟 SKU 查询超时，确认任务不中断、错误有明确降级码和修复建议。
8. **Blob 清理**：仅对已结束且超过 `blob_retain_until` 的测试任务调用清理 Route，确认只删除 `imports/source/`、`imports/manifests/`、`imports/batches/` 前缀。

恢复 Route：

```text
POST /api/internal/import-worker
POST /api/internal/import-cleanup
```

生产环境建议在 Upstash Console → QStash → Schedules 创建：

```text
v2-import-recovery      */5 * * * *
v2-import-blob-cleanup  0 * * * *
```

签名、请求体、目标 URL 和安全注意事项见 [`docs/exam-delivery/DEPLOYMENT_GUIDE.md`](./docs/exam-delivery/DEPLOYMENT_GUIDE.md)。

## 9. 部署摘要

1. 在 Vercel 将 Neon、Private Blob 和 Upstash QStash 连接到 V2 Production。
2. 确认 `APP_BASE_URL=https://ztocc-2026-v2.vercel.app`。
3. 确认必需凭据均作用于 Production。
4. 保持原有 V2/V3 与 AI 解析变量不变。
5. 检查 Settings → Functions → Fluid Compute 已开启。
6. 确认 Production 域名未被 Deployment Protection 阻挡。
7. Build Command 使用 `npm run build`，不要自动执行迁移或 seed。
8. 部署后创建恢复与 Blob 清理两个 QStash Schedule。
9. 打开 `/import-monitor`，确认 QStash 已配置且无异常 DLQ。
10. 执行正式线上压测与重试、幂等、恢复、DLQ 验收。

完整步骤、变量作用域和回滚说明见 [`docs/exam-delivery/DEPLOYMENT_GUIDE.md`](./docs/exam-delivery/DEPLOYMENT_GUIDE.md)。

## 10. 已知边界

- 当前项目按考试单租户演示设计；任务、错误、Trace 和监控读取接口未实现完整多租户授权，真实多租户生产需补鉴权和租户隔离。
- 首页按 2 MiB 阈值分流：小文件保留浏览器预览编辑；大文件不在浏览器全量解析或生成 replace manifest，选择已保存规则后直接创建异步任务，由 Worker 从 Private Blob 复读和解析。阈值是体验策略，不改变任务 API 的 50 MiB 文件上限。
- Blob 默认保留 24 小时，之后由受保护清理任务删除；如考试需要更长复核窗口，应调整保留期。
- 历史兼容任务可能没有新 QStash message ID 或 Blob pathname；新任务会写入完整元数据。
- 56.798 秒为真实 Neon 数据库核心基线；最终正式链路成绩必须以最新线上压测输出为准。