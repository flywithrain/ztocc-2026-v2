# 万能导入 V2：异步事件驱动与全链路可观测性

Next.js 16 + TypeScript + Drizzle ORM + Neon PostgreSQL + Upstash QStash + Vercel Private Blob。保留 V2 Excel/PDF/JSON、规则引擎、AI 规则和预览编辑；生产下单链路改为 Private Blob 直传、Transactional Outbox、QStash Worker 和批量写库。

## 生产链路

```text
Browser → Private Blob Client Upload
        → POST /api/import-tasks（仅 Blob 引用，≤64 KiB）
        → Neon import_tasks + Outbox
        → QStash Direct Publish / Flow Control=4
        → ImportFileUploaded Worker（下载并解析原文件）
        → 1,000 行 Private Blob 批次
        → ImportBatchCreated Worker（校验与批量写 Neon）
```

## 页面与 API

- `/`：上传原文件、规则解析、预览。
- `/import-tasks/:taskId`：2 秒刷新进度、错误筛选/导出、降级和 Trace。
- `/import-monitor`：QStash/Outbox/DLQ、队列等待、活跃 Worker、吞吐与 P50/P95/P99。
- `/traces/:traceId`：全链路时间线。
- `POST /api/import-files/upload`：Vercel Blob Client Upload token。
- `POST /api/import-tasks`：仅接受 source/manifest Blob 引用、规则、SHA-256、大小；拒绝完整 `rows`。
- `POST /api/internal/import-events`：QStash 官方签名 Consumer。
- `POST /api/internal/import-events/failure`：重试耗尽后的 failure callback/DLQ 同步。
- `GET|POST /api/internal/import-worker`：恢复卡死批次并重投 Outbox，不直接绕过队列消费。
- `POST /api/internal/import-cleanup`：清理超过保留期的导入 Blob。

## 初始化

```bash
npm ci
npm run db:check
npm run db:migrate
npm run db:seed
npm run db:seed-load
npm run dev
```

不要把 `db:migrate`、`db:push` 或 seed 命令放进 Vercel Build Command。`db:seed-load` 会重建 20,000 条 `SKU_%` 压测主数据并生成 `test-data/10000-orders-fixed.xlsx`。

完整生产环境变量见 `.env.example`，关键组为：

- Neon：`DATABASE_URL`
- 应用：`APP_BASE_URL`
- QStash：`QSTASH_TOKEN`、current/next signing key、Flow Control、retries
- Blob：`BLOB_READ_WRITE_TOKEN`、`BLOB_STORE_ID`、24 小时保留和文件上限
- 服务间：`V2_API_KEY`、`CORS_ALLOWED_ORIGIN`
- 应急控制面：可选 `IMPORT_WORKER_TOKEN`、`IMPORT_CLEANUP_TOKEN`

## 自动化验证

```bash
npm run test:async-import
npm run db:check
npm run lint
npm run typecheck
npm run build
```

当前测试覆盖 10,000 行稳定分批、部分成功、最终聚合、幂等、Blob 路径/清理白名单、任务 API 禁止 rows、QStash Direct Publish 参数、current/next key 验签、伪造和正文篡改拒绝、message ID/delivery attempt。

真实 Neon 消费核心测试需显式授权：

```bash
RUN_NEON_INTEGRATION_TEST=true npm run test:async-import:integration
```

它创建唯一业务编码的 2 行临时任务，验证真实批量落库、部分成功、行错误、Trace、性能日志、投递元数据、重复消费幂等和卡死恢复，最后按精确 `task_id` 清理。

## 压测与部署

既有真实 Neon 数据库处理核心基线：10,000 行 56.798 秒、11,536 行/分钟。该值证明数据库批量处理能力，不替代新 Blob + QStash 正式链路验收。部署后必须重新执行 20 次轻量任务创建 P95、10,000 行端到端、retry/DLQ、恢复与监控验收。

- 部署步骤与全部变量：[DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)
- 压测结果与边界：[LOAD_TEST_REPORT.md](./LOAD_TEST_REPORT.md)
- 架构假设：[REFACTORING_ASSUMPTIONS.md](./REFACTORING_ASSUMPTIONS.md)
- 考试逐项验收：[EXAM_ACCEPTANCE_REPORT.md](./EXAM_ACCEPTANCE_REPORT.md)
