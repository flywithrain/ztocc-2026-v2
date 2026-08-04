# V2 提交与 Vercel 部署操作指南

## 1. 本次必须提交的文件

至少提交以下类别：

- `src/app/api/import-tasks/**`、`src/app/api/internal/import-worker/route.ts`
- `src/app/api/import-monitor/**`、`src/app/api/traces/**`
- `src/app/import-tasks/**`、`src/app/import-monitor/**`、`src/app/traces/**`
- `src/lib/import-service.ts`、`import-types.ts`、`import-core.ts`、`db-schema.ts`
- `drizzle/0000_free_tarantula.sql` 及 `drizzle/meta/**`
- `scripts/seed-data.ts`、压测/集成测试脚本
- `.env.example`、`next.config.ts`、`vercel.json`、`package.json`、`package-lock.json`
- `README.md`、验收报告、压测报告和最终验收截图

不要提交 `.env.local`、`.vercel/`、`.next*`、临时 HTTP 输出和旧版压测数据。执行：

```bash
git status --short
git check-ignore -v .env.local .next test-data/10000-orders-fixed.xlsx
npm ci
npm run deploy:check
```

## 2. Neon 数据库迁移（部署 Web 前执行）

1. 在 Neon 创建备份/分支，记录当前 Production 连接串。
2. 本地 `.env.local` 指向目标 Neon 数据库。
3. 先检查迁移，再执行迁移：

```bash
npm ci
npm run db:check
npm run db:migrate
npm run db:seed
npm run db:seed-load
```

`db:seed-load` 会维护 20,000 条压测 SKU 并生成 10,000 行测试文件；若生产不需要压测主数据，不要执行该命令。不要把 `db:push` 放入 Vercel `buildCommand`，避免每次部署自动修改生产结构。

如果目标数据库已经通过 `db:push` 建好同结构表，先对比实际结构与 `drizzle/0000_free_tarantula.sql`，不要盲目再次执行初始迁移。当前批次表必须含 `processed_rows`、`success_rows`、`failed_rows` 三列。

## 3. Vercel 项目配置

导入 Git 仓库时将 Root Directory 设置为 `v2`（如果 V2 是单独仓库则使用仓库根目录）。Framework 选择 Next.js；Node.js 选择 22.x；启用 Fluid Compute。当前 `vercel.json` 使用 `npm ci` 和 `npm run build`，区域为 `hkg1`。

在 Settings → Environment Variables 配置：

### 必填

- `DATABASE_URL`：Neon pooled/serverless 连接串。
- `V2_API_KEY`：V3 调用 `/api/v1/*` 的长随机密钥。
- `CORS_ALLOWED_ORIGIN`：V3 的完整 Origin，例如 `https://v3.example.com`，不要带尾部 `/`。
  - V3 项目同时配置 `V2_API_BASE_URL=https://<V2正式域名>`。
  - V3 项目的 `V2_API_KEY` 必须与 V2 项目的 `V2_API_KEY` 完全一致。
- `IMPORT_WORKER_TOKEN`：手工或外部 Worker 调用内部处理接口的独立长随机密钥。
- `IMPORT_BATCH_SIZE=1000`
- `IMPORT_WORKER_CONCURRENCY=4`
- `SKU_VALIDATION_TIMEOUT_MS=3000`

### AI 功能启用时必填

- `DEEPSEEK_API_URL`
- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`

### 采用 Vercel Cron 时必填

- `CRON_SECRET`：至少 16 位，且不要与 `V2_API_KEY`、`IMPORT_WORKER_TOKEN` 复用。

### 采用外部队列时必填

- `IMPORT_QUEUE_WEBHOOK_URL`
- `IMPORT_QUEUE_WEBHOOK_TOKEN`

这两个变量必须同时设置。Preview 与 Production 建议使用不同 Neon 分支和不同密钥。

## 4. Worker / 队列选择

### 方案 A：当前版本直接部署（可验收）

创建任务后，Route Handler 使用 Next.js `after()` 在响应返回后处理批次，不再依赖用户打开任务详情页。导入路由和 Worker 路由 `maxDuration=120`。Vercel 当前 Fluid Compute Hobby 上限为 300 秒，Pro/Enterprise 默认 300 秒，因此 56.798 秒实测处理有余量。

同时保留受保护恢复入口：

```text
GET/POST /api/internal/import-worker?limit=4
```

手工调用需请求头：

```text
X-Worker-Token: <IMPORT_WORKER_TOKEN>
```

该入口每次最多认领 20 个处理单元，利用数据库状态与稳定 ID 保证重复触发安全。

### 方案 B：正式生产推荐

使用 QStash、Inngest、Trigger.dev 或常驻 Railway/Render/Fly.io Worker 消费 Outbox。`IMPORT_QUEUE_WEBHOOK_URL` 应填写队列提供方的“发布/入队 URL”，而不是 V2 自己的回调地址；Dispatcher 会把统一事件信封 POST 到该 URL，并发送 `Authorization: Bearer <IMPORT_QUEUE_WEBHOOK_TOKEN>`。

在队列提供方将最终消费目标配置为：

```text
https://<V2正式域名>/api/internal/import-events
```

队列回调同样使用 `Authorization: Bearer <IMPORT_QUEUE_WEBHOOK_TOKEN>`。该入口按 `task_id + unit_id` 只消费一个处理单元；若队列平台不能原样转发 Authorization Header，应在平台中单独配置回调 Header。要求：

- 至少一次投递；
- 指数退避；
- 死信告警；
- 重复消息安全；
- 不把 Worker 密钥下发到浏览器。

### Vercel Cron 注意事项

Vercel Cron 可调用 `/api/internal/import-worker?limit=4`，并会自动发送 `Authorization: Bearer <CRON_SECRET>`。但 Hobby 计划 Cron 只能每天一次，不适合 2 秒或分钟级队列消费；因此仓库没有默认写入高频 `crons`，避免 Hobby 部署直接失败。Pro 可按需要在 `vercel.json` 增加分钟级恢复扫描，但 Cron 是 best effort、失败不自动重试，只应作为恢复机制，不应替代正式队列。

## 5. 请求体与文件上传边界

Vercel Function 请求/响应体上限为 4.5 MB；`next.config.ts` 的 `serverActions.bodySizeLimit` 不控制 `/api/import-tasks` Route Handler。当前最终 10,000 行测试 JSON 实测约 3.476 MiB，可以上线，但余量有限。接口已在 `Content-Length > 4 MiB` 时提前返回 413，避免贴近平台硬限制。

扩展到更长地址、更多字段或 50,000 行前，必须改为：浏览器直传 S3/R2/Vercel Blob → API 只提交对象键、规则 ID 和校验信息 → Worker 流式下载/解析。不要简单调大 Next 配置，因为无法突破 Vercel 的 4.5 MB Function 限制。

## 6. 是否需要新增中间件

本次不需要 `middleware.ts` 或 Next.js 16 `proxy.ts`：

- `/api/v1/*` 四个路由已逐路由校验 `V2_API_KEY`，未配置时 fail-closed；
- Worker 路由校验 `IMPORT_WORKER_TOKEN` 或 `CRON_SECRET`；
- 全局中间件无法替代服务到服务签名和任务级幂等；
- 站内页面/API 尚无用户账号体系，若公开给真实用户，仍需接入 Auth.js/Clerk/企业 SSO 和租户隔离。

`/api/rules/seed` 已在 Production 返回 403；生产初始化改为部署前运行 `npm run db:seed`。AI 调用日志已移除 API Key 前后缀和完整模型响应。

## 7. 部署与上线验收

1. 运行 `npm run deploy:check`，确保单元测试、Lint、类型检查和生产构建全部通过。
2. 提交并推送 Git。
3. 先部署 Preview；确认 Preview 使用 Neon 测试分支。
4. 验证健康链路：
   - 首页和规则列表可访问；
   - `POST /api/rules/seed` 在 Production/生产构建返回 403；
   - 无 Worker Token 调用 `/api/internal/import-worker` 返回 401；
   - 错误 API Key 调用 `/api/v1/shipments` 返回 401；
   - 正确 API Key 返回 200；
   - 创建小任务后不打开详情页也能自动完成；
   - 重复触发 Worker 不重复入库；
   - 监控页和 Trace 页可查询；
   - CSV 错误导出正常。
5. 用 10,000 行最终 Excel 执行一次 Preview 压测，再在 Production 至少执行 20 次创建请求，计算上传 P95。
6. 确认 Vercel Logs 无 413、504、密钥片段、完整 AI 响应或未脱敏个人信息。
7. 将 Production Deployment 设为正式域名，再把 `CORS_ALLOWED_ORIGIN` 更新为 V3 正式域名并重新部署。

## 8. 回滚

- 应用异常：在 Vercel Deployments 对上一稳定版本执行 Promote/Instant Rollback。
- 数据库迁移异常：应用回滚不等于数据库回滚；先停止 Worker/外部队列，使用 Neon 分支恢复或预先准备的反向 SQL。
- 队列异常：清空 `IMPORT_QUEUE_WEBHOOK_URL` 并重新部署可回到 PostgreSQL 队列 + `after()` 模式；不要删除 Outbox 事件。
- 批次卡死：调用受保护的 `/api/internal/import-worker?limit=4`，它会先恢复锁定超过 5 分钟的批次。

## 9. 当前上线前仍需用户完成的外部事项

- 提供 Git 仓库地址并推送代码。
- 在 Vercel 创建/绑定项目和正式域名。
- 配置上述 Production/Preview 环境变量。
- 确认 Vercel 计划与 Fluid Compute 设置。
- 选择是否接入正式外部队列；考试演示可先用方案 A，真实业务推荐方案 B。
- 执行 Neon 备份/分支与迁移。
- 部署后提供 Vercel URL，完成 20 次上传 P95 和线上 10,000 行复测。
