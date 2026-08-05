# V2 生产部署手册（Vercel Hobby + QStash + Private Blob + Neon）

## 1. 架构与职责

```text
浏览器 → Vercel Private Blob 客户端直传
       → POST /api/import-tasks（只提交 Blob 引用）
       → Neon import_tasks + Transactional Outbox
       → Upstash QStash Direct Publish（Flow Control 并发 4）
       → /api/internal/import-events（官方签名验证）
       → 解析原始文件 / 处理 1,000 行批次 / 批量写 Neon
```

QStash 不在 Vercel 控制台中“开启”。请在 Upstash Console 创建 QStash；Vercel 只保存凭据并承载回调 Route。Vercel Blob 则在 Vercel 项目 Storage 中创建和绑定。

## 2. Neon：先备份，再迁移

1. 在 Neon 为当前 Production 创建分支/备份。
2. 本机 `v2/.env.local` 的 `DATABASE_URL` 指向目标数据库。
3. 在 `v2` 目录执行：

```bash
npm ci
npm run db:check
npm run db:migrate
```

本次新增迁移为 `drizzle/0001_dusty_alex_wilder.sql`。它只增加 Blob、处理阶段、QStash message ID、Outbox lease 和 DLQ 字段，并将旧 `file_payload` 改为可空，不删除业务数据。

不要把 `db:migrate` 或 `db:push` 写进 Vercel Build Command。生产不需要执行 `db:seed-load`，除非明确要写入考试压测 SKU。

## 3. Vercel：项目与 Private Blob

1. 导入 Git 项目；若仓库同时含 V2/V3，Root Directory 选择 `v2`。
2. Framework 选择 Next.js；Node.js 22.x；Build Command 保持 `npm run build`。
3. 在 **Storage → Create Database → Blob** 创建 Blob Store，并连接当前 V2 项目。
4. Blob Store 必须使用 **Private** 访问模式。
5. 连接后 Vercel 通常自动注入 `BLOB_READ_WRITE_TOKEN`；同时记录 Store ID，配置 `BLOB_STORE_ID`。
6. 开启 Fluid Compute。`vercel.json` 已固定 `hkg1`，无需新增全局中间件。

## 4. Upstash QStash

1. 登录 Upstash Console，进入 QStash。
2. 从 QStash 控制台复制：
   - Token；
   - Current Signing Key；
   - Next Signing Key。
3. 不需要在控制台手工创建 FIFO Queue。代码使用 Direct Publish，并设置 Flow Control：
   - key：`v2-import-worker`；
   - parallelism：`4`；
   - retries：`3`；
   - failure callback：`/api/internal/import-events/failure`。
4. 部署完成后，在 QStash Schedules 创建两个计划任务：

```text
每 5 分钟：POST https://<V2正式域名>/api/internal/import-worker
每 1 小时：POST https://<V2正式域名>/api/internal/import-cleanup
Body: {"limit":25}
```

两个路由都验证 QStash 官方签名。`import-worker` 只恢复卡死批次并重投 Outbox，不直接绕过队列落库；`import-cleanup` 只清理已结束任务且超过 `blob_retain_until` 的 `imports/source`、`imports/manifests`、`imports/batches` 对象。Vercel Hobby Cron 不是主调度方式。

## 5. Vercel Production 环境变量

### 必填：数据库、应用地址、QStash、Blob

```env
DATABASE_URL="Neon pooled/serverless 连接串"
APP_BASE_URL="https://<V2正式域名>"
QSTASH_TOKEN="..."
QSTASH_CURRENT_SIGNING_KEY="..."
QSTASH_NEXT_SIGNING_KEY="..."
QSTASH_FLOW_CONTROL_KEY="v2-import-worker"
QSTASH_WORKER_PARALLELISM="4"
QSTASH_RETRIES="3"
QSTASH_RETRY_DELAY="1000"
BLOB_STORE_ID="..."
BLOB_READ_WRITE_TOKEN="Vercel 绑定 Blob 后生成"
IMPORT_BLOB_RETENTION_HOURS="24"
IMPORT_MAX_FILE_SIZE_MB="50"
```

`APP_BASE_URL` 必须是公开 HTTPS 正式域名，不能带末尾 `/`。QStash 无法回调受 Vercel Deployment Protection 阻挡的 URL。

### 必填：V2/V3 与导入参数

```env
V2_API_KEY="独立长随机密钥"
CORS_ALLOWED_ORIGIN="https://<V3正式域名>"
IMPORT_BATCH_SIZE="1000"
IMPORT_WORKER_CONCURRENCY="4"
SKU_VALIDATION_TIMEOUT_MS="3000"
```

V3 同时配置：

```env
V2_API_BASE_URL="https://<V2正式域名>"
V2_API_KEY="与 V2 完全一致"
```

### 可选

```env
IMPORT_WORKER_TOKEN="手工执行恢复控制面的应急密钥"
IMPORT_CLEANUP_TOKEN="手工执行 Blob 清理的独立应急密钥"
DEEPSEEK_API_URL="..."
DEEPSEEK_API_KEY="..."
DEEPSEEK_MODEL="..."
```

AI 规则生成未启用时，三个 DeepSeek 变量可不配。不要再配置旧变量 `IMPORT_QUEUE_WEBHOOK_URL`、`IMPORT_QUEUE_WEBHOOK_TOKEN`、`CRON_SECRET`。

## 6. 必须提交的新增/修改配置与运行文件

- 依赖：`package.json`、`package-lock.json`
- 环境模板：`.env.example`
- 忽略与静态检查：`.gitignore`、`eslint.config.mjs`
- 数据库：`src/lib/db-schema.ts`、`drizzle/0001_dusty_alex_wilder.sql`、`drizzle/meta/*`
- Blob：`src/lib/blob-paths.ts`、`src/lib/blob-storage.ts`、`src/app/api/import-files/upload/route.ts`
- QStash：`src/lib/qstash-publisher.ts`、`src/lib/qstash-receiver.ts`
- 消费、恢复与清理：`src/app/api/internal/import-events/**`、`src/app/api/internal/import-worker/route.ts`、`src/app/api/internal/import-cleanup/route.ts`
- 主链路：`src/lib/import-service.ts`、`src/lib/import-types.ts`、`src/lib/file-reader.ts`
- 前端与任务 API：`src/app/page.tsx`、`src/app/preview/page.tsx`、`src/app/api/import-tasks/route.ts`
- 监控：`src/app/api/import-monitor/summary/route.ts`、`src/app/import-monitor/page.tsx`

不要提交 `.env.local`、`.vercel/`、`.next*`、`node_modules/`、`*.tgz`。

## 7. 发布门禁与部署后验收

部署前在 `v2` 执行：

```bash
npm ci
npm run db:check
npm run test:async-import
RUN_NEON_INTEGRATION_TEST=true npm run test:async-import:integration
npm run lint
npm run typecheck
npm run build
```

部署后先验证：

1. 首页上传文件时，浏览器直接上传 Private Blob；
2. `/api/import-tasks` 请求体不含 `rows`，并在 1 秒内返回 202；
3. 无 `Upstash-Signature` 调用 `/api/internal/import-events` 返回 401；
4. QStash Logs 能看到 `ImportFileUploaded` 和 10 个 `ImportBatchCreated` 消息；
5. 监控页显示 QStash published、Outbox pending/failed、DLQ、队列等待与活跃 Worker；
6. 重复投递同一批次不会重复入库；
7. 最终失败进入 QStash DLQ，并同步数据库 `dead-lettered`；
8. 10,000 行全链路不超过 60 秒，无 500/504。

您部署完成后只需提供：V2 正式 URL、可用规则 ID、是否关闭 Deployment Protection。不要在聊天中发送 Neon、QStash、Blob 或 API 密钥；助手将直接对正式 URL 完成 20 次创建 P95、10,000 行、幂等、重试、恢复、DLQ 和监控验收。

## 8. 回滚

1. 先暂停 QStash Schedule，必要时在 QStash 控制台暂停/停止新消息。
2. 在 Vercel Deployments 将上一稳定版本 Promote/Instant Rollback。
3. 不要删除 Outbox、批次或 DLQ 记录；它们是恢复和审计依据。
4. 数据库迁移是向后兼容加列，旧应用可继续运行；若必须数据库回退，优先切回 Neon 备份分支，不直接在生产执行破坏性 DROP COLUMN。
5. Blob 默认保留 24 小时；排障完成前不要提前清理相关 source/manifest/batch Blob。
