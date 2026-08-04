# 万能导入 V2：异步事件驱动与全链路可观测性

基于 Next.js App Router、TypeScript、Drizzle ORM、Neon PostgreSQL。保留 V2 Excel/PDF 读取、可配置解析规则、AI 生成规则、在线预览编辑；下单改为任务化、可靠 Outbox、批量 Worker 和可观测链路。

## 功能入口
- `/`：上传、复用解析规则并预览
- `/import-tasks/:taskId`：2 秒刷新进度、错误筛选、降级提示、Trace 入口
- `/import-monitor`：吞吐、队列积压、阶段 P50/P95/P99、错误分布、慢批次、最近任务
- `/traces/:traceId`：上传 → Outbox → Worker → 批量校验/写入时间线

## 环境变量
复制到 `.env.local`，不要提交真实密钥：

```bash
DATABASE_URL="postgresql://..."
V2_API_KEY="replace-with-random-token"
CORS_ALLOWED_ORIGIN="https://your-v3-app.vercel.app"
IMPORT_BATCH_SIZE="1000"
IMPORT_WORKER_CONCURRENCY="4"
SKU_VALIDATION_TIMEOUT_MS="3000"
IMPORT_WORKER_TOKEN="replace-with-different-random-token"
CRON_SECRET="replace-with-another-random-token"
# 生产可选：QStash/Inngest/独立 Worker webhook（URL 与 Token 必须同时配置）
IMPORT_QUEUE_WEBHOOK_URL=""
IMPORT_QUEUE_WEBHOOK_TOKEN=""
```

## 初始化与启动

```bash
npm install
npm run db:push
npm run db:seed
npm run db:seed-load
npm run dev
```

`db:seed-load` 可重复执行：清理 `SKU_%` 压测 SKU，批量写入 20,000 条主数据，覆盖生成 `test-data/10000-orders-fixed.xlsx`（含少量非法 SKU）。

## API
- `POST /api/import-tasks`：JSON `{ file_name, parse_rule_id, rows }`，返回 `task_id/trace_id`，不等待后台处理
- `GET /api/import-tasks/:taskId`：任务进度与吞吐、ETA、降级状态
- `POST /api/import-tasks/:taskId/process`：Worker 消费入口；生产需 `x-worker-token`
- `GET /api/import-tasks/:taskId/errors?batch=0&error_code=E001&page=1&page_size=50`
- `GET /api/import-tasks/:taskId/batches`
- `GET /api/traces/:traceId`
- `GET /api/import-monitor/summary`

## 压测
先在系统中确认保存一条适配压测 Excel 的标准解析规则，并取其 ID：

```bash
LOAD_TEST_BASE_URL="https://your-app.vercel.app" \
LOAD_TEST_RULE_ID="your-rule-id" \
IMPORT_WORKER_TOKEN="your-worker-token" \
npm run load:test
```

脚本读取 10,000 行文件、记录上传响应、触发 Worker、轮询到完成、输出总耗时/成功失败/HTTP 错误，并以 P95 单样本 ≤1 秒、全链路 ≤60 秒作为退出条件。真实 Neon 服务层压测已达到 56.798 秒和 11,536 行/分钟，但当前结构化 JSON 任务创建为 2.150 秒，上传 P95 尚未达标；正式 Vercel HTTP P95 仍需至少执行 20 次。真实结果、瓶颈和后续方案见 [LOAD_TEST_REPORT.md](./LOAD_TEST_REPORT.md)，仓库不伪造未完成指标。

## 自动化验证

```bash
npm run test:async-import
npm run lint
npm run build
```

单元测试覆盖批次稳定划分、部分成功、状态聚合、完成批次不可重复认领。真实 Neon 集成测试需显式授权运行，覆盖任务/Outbox 原子创建、Worker 成功、重复消费幂等、行级错误、Trace、性能日志和卡死恢复：

```bash
RUN_NEON_INTEGRATION_TEST=true npm run test:async-import:integration
```

集成测试会使用唯一业务编码创建 2 行临时任务，并在断言完成后按精确 `task_id` 清理。

## 部署与 Worker
Vercel 部署 Web/API；创建任务后由 Next.js `after()` 在响应返回后自动消费，不再依赖浏览器打开任务页。`/api/internal/import-worker?limit=4` 是受 `IMPORT_WORKER_TOKEN` 或 `CRON_SECRET` 保护的恢复入口。真实生产推荐配置 QStash/Inngest webhook，或在 Railway/Render/Fly.io 部署常驻 Dispatcher/Worker。部署前使用 `npm run db:check` 和 `npm run db:migrate`，不要把 `db:push` 放进 Vercel 构建。完整环境变量、请求体限制、上线验收和回滚步骤见 [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)。

## 故障模拟
- SKU 超时：设置 `SKU_VALIDATION_TIMEOUT_MS=500` 并在高延迟环境运行，或在测试环境注入 SKU 查询超时；页面应显示降级风险，Trace metadata 记录未校验的行范围
- 重复消息：重复调用 `/process`，已完成单元应快速返回且进度不重复累计
- 卡死恢复：将批次置为 `processing` 且 `locked_at` 超过 5 分钟，再触发 Worker
- Outbox 失败：配置不可访问 webhook，确认 `failed/retry_count/next_retry_at` 变化

详细容量、幂等窗口、隐私和清理策略见 [REFACTORING_ASSUMPTIONS.md](./REFACTORING_ASSUMPTIONS.md)。
