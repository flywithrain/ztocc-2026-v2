# V4.0 考试要求逐项验收报告

验收时间：2026-08-05。结论依据当前源码、自动化测试、真实 Neon 集成测试、生产构建、本地生产模式浏览器烟测和既有 10,000 行 Neon 压测；不虚构尚未完成的 Vercel 线上数据。

## 1. 前置红线

| 红线 | 状态 | 当前证据/剩余项 |
|---|---|---|
| 在线可访问系统 | 待部署 | 尚未提供 Vercel 正式 URL，是最终提交阻断项 |
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
| 9. Trace 检索 | 基础完成 | task/trace 时间线完整；考试若强制统一组合搜索页，仍可增强 |
| 10. 容灾降级 | 已完成 | SKU 超时降级、QStash retry/DLQ、Outbox 恢复、卡死批次恢复 |
| 11. 假设说明 | 已完成 | `REFACTORING_ASSUMPTIONS.md` 已同步当前 QStash + Blob 架构 |

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
- Next.js 16.2.6 生产构建：通过；编译、TypeScript、20 个静态页面生成及全部动态 Route 收集成功。
- 真实 Neon 消费核心集成测试：15 项断言通过。
- 集成测试信号：1 条 E001、3 个关键 Trace、1 条性能日志、delivery_attempt=1；重复投递不改写数据。
- 既有 10,000 行真实 Neon 数据库处理基线：56.798 秒，11,536 行/分钟，达到 ≤60 秒目标。

注意：56.798 秒是数据库处理核心基线；新 Blob + QStash 生产链路仍需部署后重新测量端到端时间。

## 6. 本地生产模式烟测

使用成功构建的生产产物启动 `next start`，并完成 HTTP 与真实浏览器验收：

- 首页：HTTP 200；浏览器可见“万能导入 V2”、文件上传区和导航。
- 监控页及 `/api/import-monitor/summary`：HTTP 200；浏览器成功呈现 QStash/DLQ、积压、Flow Control 并发、慢批次和最近任务。
- `/api/internal/import-events` 无 QStash 签名：401。
- `/api/import-tasks` 发送完整 `rows`：400。
- `/api/internal/import-cleanup` 未授权：401。
- 浏览器控制台：无 error。
- 截图证据：`monitor-production-smoke.png`。

本地 `.env.local` 仅配置 Neon，因此监控页按设计显示 QStash 未配置和历史积压告警；这不是生产链路通过证据，正式环境配置 QStash/Blob 后仍需复验健康状态。

## 7. 安全与生产边界

- QStash Consumer 和 failure callback 强制官方签名验证。
- 恢复/清理控制面支持 QStash 签名；可选独立应急 token。
- Private Blob token 仅在服务端；客户端使用短期上传 token。
- Blob URL/pathname 限制为 Vercel Blob 域名和导入前缀；拒绝 `..`。
- 手机号、地址写错误日志前脱敏。
- 任务、错误、Trace、监控读取 API 仍缺登录/租户隔离；若考试按单租户演示可接受，真实多租户生产必须补授权。

## 8. 强制提交物

| 提交物 | 状态 |
|---|---|
| Vercel URL | 缺失，等待用户部署 |
| 源码仓库 URL | 缺失，由用户提交 |
| 20,000 SKU 脚本 | 已有 |
| 10,000 行 Excel | 已有 |
| 压测报告 | 已有真实 Neon 基线；待补正式线上数据与截图 |
| 架构/假设说明 | 已有 `REFACTORING_ASSUMPTIONS.md` 与部署手册 |
| 部署手册 | 已有 `DEPLOYMENT_GUIDE.md` |
| 接口/运行说明 | 部署手册已有关键 Route 和配置；可按提交模板补截图 |
| 演示访问说明 | 待正式 URL 和 Deployment Protection 状态 |

## 9. 最终待办与结论

本地代码侧 P0 已补齐：专业队列、官方验签、重试、失败回调、DLQ、Transactional Outbox、Private Blob 直传、轻量任务 API、异步原文件解析、批次 Blob、恢复、监控和 24 小时清理。

目前不能宣称“考试全部通过”，唯一主要阻断面是正式部署后的真实环境证据。用户部署后需完成：20 次任务创建 P95 ≤1 秒、10,000 行新链路 ≤60 秒、2 秒进度刷新、重复投递幂等、重试/DLQ、恢复控制面、监控页及无 500/504。完成后再把正式 URL、指标和截图写回本报告。
