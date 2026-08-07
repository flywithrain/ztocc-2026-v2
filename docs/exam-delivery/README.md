# V2 考试交付文档索引

本目录集中保存 V4.0 考试的正式文档与浏览器验收证据。项目运行入口、在线地址、源码仓库、接口、压测命令和故障模拟说明见仓库根目录 [`README.md`](../../README.md)。

## 正式文档

| 文件 | 用途 |
|---|---|
| [`考试要求-文件版本.html`](./考试要求-文件版本.html) | 本次考试要求的文件版本 |
| [`EXAM_ACCEPTANCE_REPORT.md`](./EXAM_ACCEPTANCE_REPORT.md) | 按考试红线与十一个模块逐项验收 |
| [`LOAD_TEST_REPORT.md`](./LOAD_TEST_REPORT.md) | 10,000 行真实 Neon 压测数据、优化过程与正式链路边界 |
| [`REFACTORING_ASSUMPTIONS.md`](./REFACTORING_ASSUMPTIONS.md) | 异步架构、容量、幂等、降级、隐私和运维假设 |
| [`DEPLOYMENT_GUIDE.md`](./DEPLOYMENT_GUIDE.md) | Vercel、Neon、Private Blob、QStash、Schedule、回滚和部署后验收 |

## 浏览器验收证据

最终截图统一位于 [`evidence/`](./evidence/)：

- `import-history-production.png`：独立导入历史页；
- `import-history-trace-navigation.png`：历史记录跳转 Trace；
- `import-history-trace-detail-production.png`：历史任务 Trace 详情；
- `monitor-production-smoke.png`：生产模式监控页；
- `task-progress-contrast-fixed.png`：任务进度页可读性修复；
- `trace-search-production.png`：六维 Trace 检索；
- `trace-detail-production.png`：API → Blob → Outbox → Queue/Worker → DB 全链路详情。

## 其他强制交付物位置

- 20,000 条 SKU 与 10,000 行 Excel 生成脚本：[`../../scripts/seed-data.ts`](../../scripts/seed-data.ts)
- 正式链路压测脚本：[`../../scripts/load-test.ts`](../../scripts/load-test.ts)
- 真实 Neon 集成测试：[`../../scripts/integration-test-async-import.ts`](../../scripts/integration-test-async-import.ts)
- 10,000 行压测文件：[`../../test-data/10000-orders-fixed.xlsx`](../../test-data/10000-orders-fixed.xlsx)
- 数据库迁移：[`../../drizzle/`](../../drizzle/)

本目录不保存密钥、`.env.local`、构建目录、浏览器 YAML 快照或临时 HTTP/CSV/JSON 输出。