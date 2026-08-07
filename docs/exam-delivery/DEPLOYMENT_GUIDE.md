# V2 生产部署手册（当前 Vercel 项目差异配置）

本文按当前实际情况编写：Neon、Vercel Private Blob、Upstash QStash 已在 Vercel 控制台创建并连接到 V2；原有 V2/V3 调用和 AI 解析已经配置并正常使用。本次只列异步导入改造新增或需要核对的项目。

## 1. 当前架构

```text
浏览器 → Vercel Private Blob 客户端直传
       → POST /api/import-tasks（只提交 Blob 引用）
       → Neon import_tasks + Transactional Outbox
       → Upstash QStash Direct Publish（Flow Control 并发 4）
       → /api/internal/import-events（Vercel Serverless Worker）
       → 解析原始文件 / 处理 1,000 行批次 / 批量写 Neon
```

QStash 是队列与 HTTP 投递系统。消费者不是单独部署的常驻服务器，而是 V2 项目中的 `/api/internal/import-events` Vercel Function。QStash 主动 POST 消息，Vercel 按请求启动 Worker，代码验证 QStash 签名后调用 `processImportEvent()`。

## 2. 已完成，不需要重复操作

以下事项不需要再次修改：

- Neon 已连接 V2，继续使用当前 Production `DATABASE_URL`。
- `drizzle/0001_dusty_alex_wilder.sql` 已在当前 Neon 执行成功；不要再次手工迁移。
- Blob 已连接 V2，不需要重新创建 Store。
- QStash 已连接 V2，不需要再创建 FIFO Queue、Redis 或独立 Worker 项目。
- 原有 V2/V3 交互未改变，`V2_API_KEY`、`CORS_ALLOWED_ORIGIN`、V3 的 `V2_API_BASE_URL` 不需要修改。
- AI 规则解析未改变，原有 `DEEPSEEK_API_URL`、`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL` 不需要修改。
- 不需要新增全局 Middleware。
- 不要将 `db:migrate`、`db:push` 或 `db:seed-load` 加入 Vercel Build Command。

当前 Production 也是考试演示库，可以不做完整备份。若 Neon 套餐允许，可选创建一个分支作为误操作回退点，但不是本次部署阻断项。

## 3. Vercel 环境变量：只需核对以下内容

进入：

```text
Vercel → V2 Project → Settings → Environment Variables
```

### 3.1 本次唯一需要手工新增或确认的变量

```env
APP_BASE_URL="https://<V2正式域名>"
```

要求：

- 使用 V2 Production 的公开 HTTPS 域名；
- 不带末尾 `/`；
- 不要填写 V3 域名；
- 如果更换正式域名，需要同步更新后重新部署。

`APP_BASE_URL` 用于生成 QStash 的消费者地址和 failure callback 地址，例如：

```text
https://<V2正式域名>/api/internal/import-events
https://<V2正式域名>/api/internal/import-events/failure
```

### 3.2 Vercel 集成应自动注入，必须检查存在

Neon、Blob、QStash 连接到 V2 后，Vercel 应向项目注入以下变量：

```env
DATABASE_URL="..."
BLOB_READ_WRITE_TOKEN="..."
QSTASH_TOKEN="..."
QSTASH_CURRENT_SIGNING_KEY="..."
QSTASH_NEXT_SIGNING_KEY="..."
```

只检查变量名称存在且作用域包含 Production，不要在聊天中发送变量值。

注意：

- 代码不读取 `BLOB_STORE_ID`，无需额外配置。
- 如果 Vercel QStash 集成没有自动生成 Current/Next Signing Key，需从 QStash 控制台复制后手工添加。
- 修改或补充任何环境变量后必须重新部署，旧 Deployment 不会自动获得新值。

### 3.3 可不配置，代码已有默认值

以下变量只有需要调整策略时才配置；不配置时就是右侧默认值：

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

本次考试建议保持默认值，不需要手工新增。

### 3.4 可选应急变量

```env
IMPORT_WORKER_TOKEN="独立长随机密钥"
IMPORT_CLEANUP_TOKEN="另一个独立长随机密钥"
```

这两个变量仅用于人工调用恢复/清理接口。QStash 正式调用使用签名验证，因此考试演示不是必须配置。

不要再配置旧变量：

```text
IMPORT_QUEUE_WEBHOOK_URL
IMPORT_QUEUE_WEBHOOK_TOKEN
CRON_SECRET
```

## 4. Vercel 项目设置

### 4.1 构建配置

保持：

```text
Root Directory: v2
Framework: Next.js
Node.js: 22.x
Install Command: npm ci
Build Command: npm run build
```

`vercel.json` 已配置 `hkg1`，不需要手工设置函数地区。

### 4.2 开启 Fluid Compute

控制台路径：

```text
Vercel → V2 Project → Settings → Functions → Fluid Compute
```

如果已显示 `Enabled`，无需操作。若未开启：

1. 开启 Fluid Compute；
2. 保存；
3. 重新部署 Production。

Fluid Compute 让多个 QStash Worker 调用更高效地复用 Vercel Function 实例，降低冷启动并改善 Blob/Neon 网络等待型任务的执行效率。新建 Vercel 项目通常已经默认开启。

### 4.3 检查 Deployment Protection

QStash 必须能从公网调用 V2 内部 Route。正式 Production 域名不能被登录页或 Deployment Protection 拦截。

至少确认以下地址能够到达应用，而不是跳转到 Vercel 登录页：

```text
https://<V2正式域名>/api/internal/import-events
https://<V2正式域名>/api/internal/import-events/failure
```

无 QStash 签名直接调用第一个地址返回 `401` 是正确行为，说明 Route 可达且鉴权生效。

## 5. 创建两个 QStash Schedule

**Schedule 不在 Vercel Integrations 页面创建。** Vercel 集成只负责把 QStash 连接到项目并注入环境变量。请打开 [Upstash Console](https://console.upstash.com/)，使用创建 Vercel 集成时关联的同一个 Upstash 账号，然后进入：

```text
Upstash Console → QStash → Schedules → Create Schedule
```

如果 Vercel 集成详情中有 `Manage`、`Open in Upstash` 或类似入口，也可以点击后跳转到同一个 Upstash Console。资源连接不会自动创建恢复和清理计划，需要手工建立以下两个 Schedule。

### 5.1 卡死任务恢复

```text
Schedule ID：v2-import-recovery
Destination：https://<V2正式域名>/api/internal/import-worker
Cron：*/5 * * * *
Method：POST
Body：{}
Content-Type：application/json
Retries：使用默认值 3
```

该 Route 只恢复卡死批次并重新投递 Outbox，不绕过 QStash 直接写库。

### 5.2 过期 Blob 清理

```text
Schedule ID：v2-import-blob-cleanup
Destination：https://<V2正式域名>/api/internal/import-cleanup
Cron：0 * * * *
Method：POST
Body：{"limit":25}
Content-Type：application/json
Retries：使用默认值 3
```

Cron 默认按 UTC 计算，但这里都是固定间隔任务，因此不受时区影响。创建后可在 QStash 的 Schedules 页面看到两个任务，并在 Logs/Messages 中检查每次投递结果。

该 Route 只清理已经结束、超过 `blob_retain_until` 且位于以下隔离前缀中的 Blob：

```text
imports/source/
imports/manifests/
imports/batches/
```

两个 Schedule 都由 QStash 自动签名，不需要配置 `CRON_SECRET`。

## 6. 最终部署操作顺序

1. 确认 Neon、Blob、QStash 三个资源都连接到 V2，连接作用域包含 Production；Blob Store 为 Private 模式。
2. 在 V2 Production 环境变量中添加或确认 `APP_BASE_URL`。
3. 检查五个自动注入变量：`DATABASE_URL`、`BLOB_READ_WRITE_TOKEN`、`QSTASH_TOKEN`、`QSTASH_CURRENT_SIGNING_KEY`、`QSTASH_NEXT_SIGNING_KEY`。
4. 保持原有 V2/V3 和 AI 变量不变。
5. 检查 Fluid Compute 已开启。
6. 确认 Production 域名没有被 Deployment Protection 阻挡。
7. 重新部署 V2 Production。
8. 部署成功后创建两个 QStash Schedule。
9. 打开 `/import-monitor`，确认不再显示 `qstash.configured=false`。

## 7. 部署后验收

先做基础检查：

1. 首页上传文件时，浏览器直接上传 Private Blob；
2. `/api/import-tasks` 请求体不含完整 `rows`，任务创建返回 202；
3. QStash Logs 能看到 `ImportFileUploaded` 与 `ImportBatchCreated`；
4. `/import-monitor` 显示 QStash published、Outbox、DLQ、队列等待和活跃 Worker；
5. 最终任务状态为 `completed` 或预期的 `partial_success`；
6. Vercel Function Logs 没有持续 500/504。

部署完成后只需提供：

- V2 正式 URL；
- 一个可用的解析规则 ID；
- Deployment Protection 是否关闭。

不要发送 Neon、Blob、QStash 或 AI 密钥。助手将直接对正式 URL 执行 20 次任务创建 P95、10,000 行全链路、幂等、重试、恢复、DLQ 和监控验收。

## 8. 本次新增/修改文件

- 依赖：`package.json`、`package-lock.json`
- 配置：`.env.example`、`.gitignore`、`eslint.config.mjs`、`next.config.ts`
- 数据库：`src/lib/db-schema.ts`、`drizzle/0001_dusty_alex_wilder.sql`、`drizzle/meta/*`
- Blob：`src/lib/blob-paths.ts`、`src/lib/blob-storage.ts`、`src/app/api/import-files/upload/route.ts`
- QStash：`src/lib/qstash-publisher.ts`、`src/lib/qstash-receiver.ts`
- 消费与恢复：`src/app/api/internal/import-events/**`、`src/app/api/internal/import-worker/route.ts`、`src/app/api/internal/import-cleanup/route.ts`
- 异步主链路：`src/lib/import-service.ts`、`src/lib/import-types.ts`、`src/lib/file-reader.ts`
- 页面与 API：`src/app/page.tsx`、`src/app/preview/page.tsx`、`src/app/api/import-tasks/route.ts`
- 监控：`src/app/api/import-monitor/summary/route.ts`、`src/app/import-monitor/page.tsx`

不要提交 `.env.local`、`.vercel/`、`.next*`、`node_modules/` 或临时压测输出。

## 9. 回滚

1. 暂停两个 QStash Schedule，必要时暂停新消息投递。
2. 在 Vercel Deployments 对上一稳定版本执行 Promote/Instant Rollback。
3. 不要删除 Outbox、批次或 DLQ 记录，它们是恢复与审计依据。
4. 数据库迁移是向后兼容加列，旧应用可以继续运行；不要直接执行破坏性 `DROP COLUMN`。
5. 排障期间不要提前清理相关 source/manifest/batch Blob。
