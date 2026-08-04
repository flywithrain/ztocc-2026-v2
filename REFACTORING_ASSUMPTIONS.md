# V2 异步事件驱动重构假设说明

## 1. 架构选择
同步上传请求不再承担 10,000 行完整导入。浏览器仍复用 V2 `parse-engine.ts` 完成既有规则解析和可编辑预览；确认后 `POST /api/import-tasks` 只写入任务、处理单元、Outbox 和 Trace，返回 `task_id`。后台 Worker 消费处理单元，批量校验、批量写入并聚合状态。

## 2. 处理单元与容量规划
默认 `IMPORT_BATCH_SIZE=1000`，10,000 行拆为 10 个独立处理单元；`IMPORT_WORKER_CONCURRENCY=4`。每个处理单元对最多 1,000 个 SKU 做一次 `IN` 批量查询，并把错误、运单主表、SKU 明细、批次计数、性能日志和 Trace 合并到单次 Neon HTTP 事务中提交。

真实 Neon 压测发现：多个 Worker 直接原子累加同一 `import_tasks` 行会产生热点锁竞争，首波 4 批事务耗时达到 46～49 秒。最终方案将处理结果先写入各自 `import_task_batches`，所有批次结束后一次聚合主任务，移除热点行竞争。2026-08-04 实测 10,000 行总耗时 56.798 秒、吞吐 11,536 行/分钟，达到 60 秒目标；详细结果见 `LOAD_TEST_REPORT.md`。

## 3. Outbox 可靠性
任务、批次和 `ImportBatchCreated` 事件由 Neon HTTP transaction 批量提交，避免任务存在但事件丢失。Dispatcher 扫描 `pending/failed + next_retry_at`，指数退避重试。未配置外部队列 Webhook 时，Outbox 本身作为 PostgreSQL 可靠任务队列；生产环境建议配置 QStash、Inngest 或独立常驻 Worker，并使用 `IMPORT_QUEUE_WEBHOOK_URL` 投递。

## 4. 幂等、重试和恢复
稳定键为 `task_id + unit_id`，数据库唯一索引保护。Worker 仅允许原子认领 `pending/failed` 单元；`completed` 再消费直接返回，不写库、不累加进度。批次性能日志同样以 `task_id + unit_id` 唯一。超过 5 分钟仍为 `processing` 的单元会被恢复为 `failed`，等待重新认领。

运单主表和明细表 ID 均由 `task_id + 外部编码/行号 + SKU` 生成稳定 UUID，批量写入使用 `ON CONFLICT DO NOTHING`；即使 Worker 在“写库成功、批次状态提交失败”的窗口重试，也不会重复插入。异步任务同时使用稳定 `batch_id=task_id`，便于按任务核对和清理。

## 5. 部分成功
行级业务错误不回滚整个 1,000 行单元。错误行写 `import_task_errors`，成功行继续批量入库；最终状态为 `partial_success`。系统级数据库错误仍使整个处理单元失败并重试，避免不确定的部分提交。

## 6. SKU 降级
SKU 查询超过 `SKU_VALIDATION_TIMEOUT_MS`（默认 3 秒）或数据库短暂失败时，当前批次仅执行本地必填、电话、数量和收货信息一致性校验。任务写入 `degraded=true`、原因和 Trace 告警；任务详情显示明确风险提示。服务恢复后新处理单元自动恢复主数据校验。降级任务不自动补校验，需由运营导出任务并人工确认后重跑，避免静默修改已入库数据。

## 7. 错误与隐私
手机号保存为 `138****0000`，地址仅保留前 6 位和末 2 位，中间脱敏；单值最多 500 字符。错误明细保留批次、全局行号、字段、错误码、原因、建议和 Trace ID，运维无需下载原文件即可定位。

## 8. 压测数据与清理
`npm run db:seed-load` 会删除 `SKU_%` 前缀的压测 SKU 后重建 20,000 条，并覆盖 `test-data/10000-orders-fixed.xlsx`。Excel 每 97 行插入一个非法 SKU。业务任务、错误、Trace、Outbox 和性能日志必须按 `task_id` 定向删除；建议每天归档 30 天前已完成数据，Outbox `sent` 数据保留 7 天。禁止无条件清空生产表。

## 9. 重复上传
文件名和结构化行内容计算 SHA-256 `file_hash` 并建立索引，当前策略允许重复上传但保留可检索指纹，便于演示和人工重跑。生产可增加租户维度与 10 分钟去重窗口，并允许用户显式“重新执行”。

## 10. 事件版本
事件统一包含 `event_id`、`event_type`、`schema_version`、`aggregate_id`、`trace_id`、`occurred_at` 和 `payload`。新增字段必须可选且消费者忽略未知字段；语义不兼容时升级 `schema_version` 并并行兼容旧版本。

## 11. 希望向产品与运维确认的问题
1. 同一外部编码跨任务是否允许覆盖，还是必须拒绝？
2. SKU 降级导入是否需要审批，以及补校验 SLA？
3. 大促峰值是单个超大文件还是多租户并发文件？
4. 错误明细、原文件和 Trace 的保留期限与合规要求？
5. 外部队列首选平台、Worker 部署平台和数据库连接预算？
6. 队列积压、失败率、P99 的正式告警阈值及通知渠道？
