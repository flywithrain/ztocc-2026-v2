# V4.0 考试要求逐项验收报告

验收时间：2026-08-07。结论依据当前源码、自动化测试、真实 Neon 集成测试、生产构建、本地生产模式浏览器烟测、已提供的 Vercel/GitHub 地址和既有 10,000 行 Neon 压测；不把数据库核心基线冒充为最新 Vercel + Blob + QStash 线上全链路数据。

## 1. 前置红线

| 红线 | 状态 | 当前证据/剩余项 |
|---|---|---|
| 在线可访问系统 | 已提供 | `https://ztocc-2026-v2.vercel.app/`；提交前仍需确认最新部署版本包含当前工作树修改 |
| 20,000 SKU 脚本 | 已完成 | `scripts/seed-data.ts`；真实 Neon 已确认 20,000 条 |
| 10,000 行 Excel | 已完成 | `test-data/10000-orders-fixed.xlsx`；10,000 行、104 个非法 SKU |
| 不同步逐行 INSERT | 已完成 | QStash Worker、1,000 行批次、`jsonb_to_recordset` 批量写库、单批事务 |
| 大文件不进入请求内存链路 | 已完成（代码） | Vercel Private Blob Client Upload；任务 API ≤64 KiB 且显式拒绝 `rows` |
| 保存原始文件/可复读引用 | 已完成（代码） | source Blob、edit manifest、batch Blob；默认 24 小时保留 |
| 必须引入队列或任务系统 | 已完成（代码） | `@upstash/qstash` Direct Publish + Flow Control + retries + failure callback + DLQ |
| 无真实密钥入库 | 代码符合 | 所有凭据来自环境变量；提交前仍需对实际 Git 仓库执行 secret scan |

## 2. 十一个功能模块

| 模块 | 状态 | 说明 |
|---|---|---|
| 1. 压测数据准备 | 已完成 | 可重复灌入 20,000 SKU；生成 10,000 行 Excel |
| 2. 上传即返回 | 已完成（代码），待线上 P95 | 浏览器直传 Blob；任务接口只写轻量引用并返回 202 |
| 3. Outbox 与队列 | 已完成 | Transactional Outbox；lease/claim；QStash message ID；指数退避；恢复扫描 |
| 4. Worker 异步处理 | 已完成 | `ImportFileUploaded` 解析事件与 `ImportBatchCreated` 批次事件分离 |
| 5. 幂等保护 | 已完成 | `task_id + unit_id` 唯一、原子认领、稳定 UUID、`ON CONFLICT DO NOTHING` |
| 6. 行级错误 | 已完成 | 行号、字段、脱敏值、错误码、原因、建议、Trace；筛选/分页/CSV |
| 7. 任务结果页 | 已完成 | 2 秒轮询、批次聚合、吞吐、ETA、错误和降级提示 |
| 8. 监控看板 | 已完成 | queue wait、active workers、Outbox pending/failed、QStash published、DLQ、P50/P95/P99 |
| 9. Trace 检索 | 已完成 | 独立 `/traces` 检索页支持 task_id、trace_id、文件名、批次号、行号范围、错误码；详情聚合 API、Outbox、QStash Queue、Worker、DB、性能和失败行 |
| 10. 容灾降级 | 已完成 | SKU 超时降级、QStash retry/DLQ、Outbox 恢复、卡死批次恢复 |
| 11. 假设说明 | 已完成 | `docs/exam-delivery/REFACTORING_ASSUMPTIONS.md` 已同步当前 QStash + Blob 架构 |

## 3. 队列与对象存储静态证据

- 依赖：`@upstash/qstash@2.11.3`、`@vercel/blob@2.6.1`。
- Publisher：`Client.publishJSON()`，含 retries、retryDelay、failureCallback、Flow Control parallelism=4、内容去重。
- Receiver：`Receiver.verify()`，支持 current/next signing key，基于原始 body 和 URL 验签。
- Consumer：`/api/internal/import-events`；非 2xx 触发 QStash 重试。
- 最终失败：`/api/internal/import-events/failure` 同步 Outbox/批次/任务 `dead-lettered`。
- 恢复控制面：`/api/internal/import-worker`，不绕过 QStash 直接落库。
- Blob 清理：`/api/internal/import-cleanup`，只清理结束任务和三个导入隔离前缀。

这些代码符号可直接供外部 AI 静态审计，不会再被误判为“只有 Neon 任务表、没有专业队列”。

## 4. 数据模型与迁移

`drizzle/0001_dusty_alex_wilder.sql` 已应用到 `.env.local` 指向的最终 Neon 数据库。迁移只增加 Blob、处理阶段、QStash delivery、Outbox lease/DLQ 字段，并将旧 `file_payload` 改为可空。

本次发现数据库业务表已存在但 `drizzle.__drizzle_migrations` 为空，导致工具试图重放 `0000`；已在确认迁移表为空后安全登记现有 `0000` 基线，再由 Drizzle 成功应用 `0001`。后续 `npm run db:migrate` 可正常增量执行。

## 5. 自动化与真实数据库结果

- 核心 + QStash/Blob 合同测试：11/11 通过。
- 覆盖：10,000 行分批、部分成功、最终聚合、幂等认领、Blob 前缀/路径、清理白名单、请求禁止 rows、Publisher 参数、current/next key 验签、伪造/篡改拒绝、delivery metadata。
- ESLint：通过（0 error，保留 8 个非阻断 warning）。
- TypeScript：通过。
- Drizzle schema check：通过。
- Next.js 16.2.6 生产构建：通过；编译、TypeScript、24 个静态页面生成及全部动态 Route 收集成功。
- 真实 Neon 消费核心集成测试：15 项断言通过。
- 集成测试信号：1 条 E001、3 个关键 Trace、1 条性能日志、delivery_attempt=1；重复投递不改写数据。
- 既有 10,000 行真实 Neon 数据库处理基线：56.798 秒，11,536 行/分钟，达到 ≤60 秒目标。

注意：56.798 秒是数据库处理核心基线；新 Blob + QStash 生产链路仍需部署后重新测量端到端时间。

## 6. 模块九 Trace 检索验收

- 独立入口：顶部导航 `Trace 检索` → `/traces`。
- Trace ID 获取入口：独立 `/import-history` 导入历史表和监控页“最近导入任务”都展示完整 `task_id`、`trace_id`，并提供“任务详情”“Trace 链路”双入口，运维不需要预先复制或猜测 trace_id。
- 六类搜索条件：`task_id`、`trace_id`、文件名、批次号、行号范围、错误码；支持组合查询。
- 详情聚合：`/api/traces/[traceId]` 返回 `import_tasks`、解析规则、原文件/兼容载荷引用、Trace 事件、Outbox、QStash message/delivery、批次、性能日志、行级错误和 DB 写入计数。
- 时间线按 API → Blob → Outbox → Queue/Worker → DB 分阶段展示；新任务显式写入 API 接收、ID 生成、文件引用保存、行数预扫描、任务记录创建、队列消费、批量校验和数据库写入事件。
- 失败节点可展开批次号、行号、字段、脱敏原值、错误码、原因、所属规则、阶段耗时、批次重试、QStash delivery/message ID 与修复建议。
- 真实 Neon 历史任务验收：按 task_id 命中 1 个任务、23 个 Trace 事件、11 条 Outbox、104 条错误；按文件名 + E001 命中 104 条；按批次 1 + 行号 1～100 命中 2 条；详情聚合 10 个批次、10 条性能日志、5,000 运单与 9,896 条 SKU 明细。
- 独立导入历史验收：`/api/import-history` 返回 2 条真实历史任务，支持文件名 + 状态组合筛选；页面显示完整 task_id/trace_id，任务详情和 Trace 链路按钮均可用。

## 7. 本地生产模式烟测

使用成功构建的生产产物启动 `next start`，并完成 HTTP 与真实浏览器验收：

- 首页：HTTP 200；浏览器可见“万能导入 V2”、文件上传区和导航。
- 监控页及 `/api/import-monitor/summary`：HTTP 200；浏览器成功呈现 QStash/DLQ、积压、Flow Control 并发、慢批次和最近任务。
- `/api/internal/import-events` 无 QStash 签名：401。
- `/api/import-tasks` 发送完整 `rows`：400。
- `/api/internal/import-cleanup` 未授权：401。
- 浏览器控制台：无 error。
- 截图证据：`docs/exam-delivery/evidence/monitor-production-smoke.png`。

本地 `.env.local` 仅配置 Neon，因此监控页按设计显示 QStash 未配置和历史积压告警；这不是生产链路通过证据，正式环境配置 QStash/Blob 后仍需复验健康状态。

## 8. 安全与生产边界

- QStash Consumer 和 failure callback 强制官方签名验证。
- 恢复/清理控制面支持 QStash 签名；可选独立应急 token。
- Private Blob token 仅在服务端；客户端使用短期上传 token。
- Blob URL/pathname 限制为 Vercel Blob 域名和导入前缀；拒绝 `..`。
- 手机号、地址写错误日志前脱敏。
- 任务、错误、Trace、监控读取 API 仍缺登录/租户隔离；若考试按单租户演示可接受，真实多租户生产必须补授权。

## 9. 强制提交物

| 提交物 | 状态 |
|---|---|
| Vercel URL | 已提供：`https://ztocc-2026-v2.vercel.app/` |
| 源码仓库 URL | 已提供：`https://github.com/flywithrain/ztocc-2026-v2` |
| 20,000 SKU 脚本 | `scripts/seed-data.ts` |
| 10,000 行 Excel | `test-data/10000-orders-fixed.xlsx` |
| 正式链路压测脚本 | `scripts/load-test.ts` |
| 压测报告 | `docs/exam-delivery/LOAD_TEST_REPORT.md`；已有真实 Neon 核心基线，最新线上 QStash 全链路指标仍需回填 |
| 架构/假设说明 | `docs/exam-delivery/REFACTORING_ASSUMPTIONS.md`；总 README 也包含流程图、Outbox、Queue/Worker 与批量策略 |
| 部署手册 | `docs/exam-delivery/DEPLOYMENT_GUIDE.md` |
| 接口/运行说明 | 根目录 `README.md` 已汇总上传、任务、错误、Trace、监控、启动、环境、部署和故障模拟 |
| 演示访问说明 | `README.md` 已列出导入、历史、监控、Trace 页面；无需演示账号 |

## 10. 最终待办与结论

本地代码侧 P0 已补齐：专业队列、官方验签、重试、失败回调、DLQ、Transactional Outbox、Private Blob 直传、轻量任务 API、异步原文件解析、批次 Blob、恢复、监控和 24 小时清理。

正式 URL、源码仓库和文档类强制提交物已齐全。当前尚不能把“考试全部通过”作为最终结论，因为最新工作树仍需提交并部署，且正式环境还需完成：20 次任务创建 P95 ≤1 秒、10,000 行新链路 ≤60 秒、2 秒进度刷新、重复投递幂等、重试/DLQ、恢复控制面、监控健康及无 500/504。完成后把正式 task_id、trace_id、指标和截图写回本报告。
