import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import type { OrderRow, ParseRule } from "../src/types";

config({ path: ".env.local", quiet: true });

async function main() {
const [{ sql }, { createImportTask, processPendingBatches, getImportTask }] = await Promise.all([
  import("../src/lib/db"),
  import("../src/lib/import-service"),
]);
const ruleRows = await sql`select id, name, config from parse_rules where config->>'parseMode' = 'standard' order by updated_at desc nulls last limit 1`;
if (!ruleRows.length) throw new Error("没有可用的 standard 解析规则");
const ruleId = String(ruleRows[0].id);
const rule = { id: ruleId, ...(ruleRows[0].config as object) } as ParseRule;
const inputFile = process.env.LOAD_TEST_FILE || "test-data/10000-orders-fixed.xlsx";
const buffer = await readFile(inputFile);
const workbook = XLSX.read(buffer, { type: "buffer" });
const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[workbook.SheetNames[0]]);
const rows: OrderRow[] = records.map((item, index) => ({
  id: crypto.randomUUID(), rowIndex: index,
  externalCode: String(item["外部编码"] || ""), storeName: String(item["收货门店"] || ""),
  receiverName: String(item["收件人姓名"] || ""), receiverPhone: String(item["收件人电话"] || ""),
  receiverAddress: String(item["收件人地址"] || ""), skuCode: String(item["SKU编码"] || ""),
  skuName: String(item["SKU名称"] || ""), skuQuantity: Number(item["数量"] || 0),
  skuSpec: String(item["SKU规格"] || ""), remark: String(item["备注"] || ""),
}));

const started = performance.now();
const uploadStarted = performance.now();
console.log(JSON.stringify({ stage: "create_task_started", rows: rows.length, at: new Date().toISOString() }));
const created = await createImportTask({ fileName: inputFile.split(/[\\/]/).pop() || "10000-orders-fixed.xlsx", parseRuleId: ruleId, rule, rows });
const uploadMs = performance.now() - uploadStarted;
console.log(JSON.stringify({ stage: "task_created", task_id: created.task_id, upload_ms: Math.round(uploadMs), at: new Date().toISOString() }));
const firstRun = await processPendingBatches(created.task_id);
const totalMs = performance.now() - started;
console.log(JSON.stringify({ stage: "worker_finished", task_id: created.task_id, total_ms: Math.round(totalMs), at: new Date().toISOString() }));
const task = await getImportTask(created.task_id);
const retryStarted = performance.now();
const secondRun = await processPendingBatches(created.task_id);
const retryMs = performance.now() - retryStarted;
const [counts] = await sql`select
  (select count(*)::int from import_task_errors where task_id = ${created.task_id}) error_count,
  (select count(*)::int from batch_performance_log where task_id = ${created.task_id}) perf_count,
  (select count(*)::int from trace_events where task_id = ${created.task_id}) trace_count,
  (select count(*)::int from event_outbox where aggregate_id = ${created.task_id}) outbox_count,
  (select count(*)::int from shipments where batch_id = ${created.task_id}) shipment_count`;
console.log(JSON.stringify({
  task_id: created.task_id, trace_id: created.trace_id, rule_id: ruleId,
  upload_ms: Math.round(uploadMs), total_ms: Math.round(totalMs), first_run_batches: firstRun.length,
  retry_ms: Math.round(retryMs), second_run_batches: secondRun.length, task, counts,
  targets: { upload_under_1000: uploadMs <= 1000, total_under_60000: totalMs <= 60000 },
}, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
