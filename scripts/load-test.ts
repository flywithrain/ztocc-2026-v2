import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";

config({ path: ".env.local" });
const baseUrl = process.env.LOAD_TEST_BASE_URL || "http://localhost:3000";
const ruleId = process.env.LOAD_TEST_RULE_ID;
const filePath = process.env.LOAD_TEST_FILE || "test-data/10000-orders-fixed.xlsx";
if (!ruleId) throw new Error("请设置 LOAD_TEST_RULE_ID（使用已确认保存的解析规则）");

const workbook = XLSX.read(await readFile(filePath), { type: "buffer" });
const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[workbook.SheetNames[0]]);
const rows = records.map((row, index) => ({ id: crypto.randomUUID(), rowIndex: index, externalCode: String(row["外部编码"] || ""), storeName: String(row["收货门店"] || ""), receiverName: String(row["收件人姓名"] || ""), receiverPhone: String(row["收件人电话"] || ""), receiverAddress: String(row["收件人地址"] || ""), skuCode: String(row["SKU编码"] || ""), skuName: String(row["SKU名称"] || ""), skuQuantity: Number(row["数量"] || 0), skuSpec: String(row["SKU规格"] || ""), remark: String(row["备注"] || "") }));

const started = performance.now();
const uploadStarted = performance.now();
const createResponse = await fetch(`${baseUrl}/api/import-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file_name: filePath.split(/[\\/]/).pop(), parse_rule_id: ruleId, rows }) });
const uploadMs = performance.now() - uploadStarted;
const task = await createResponse.json() as { task_id?: string; trace_id?: string; error?: string };
if (!createResponse.ok || !task.task_id) throw new Error(`创建失败 ${createResponse.status}: ${task.error}`);
console.log(`上传接口：${Math.round(uploadMs)}ms，task_id=${task.task_id}`);

const workerResponse = await fetch(`${baseUrl}/api/import-tasks/${task.task_id}/process`, { method: "POST", headers: process.env.IMPORT_WORKER_TOKEN ? { "x-worker-token": process.env.IMPORT_WORKER_TOKEN } : {} });
if (!workerResponse.ok) console.warn(`Worker 触发响应 ${workerResponse.status}`);

let finalTask: { status: string; success_rows: number; failed_rows: number; processed_rows: number } | undefined;
let httpErrors = 0;
while (performance.now() - started < 180000) {
  const response = await fetch(`${baseUrl}/api/import-tasks/${task.task_id}`);
  if (!response.ok) { httpErrors++; continue; }
  finalTask = await response.json();
  process.stdout.write(`\r${finalTask!.status}: ${finalTask!.processed_rows}/${rows.length}`);
  if (["completed", "partial_success", "failed"].includes(finalTask!.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const totalMs = performance.now() - started;
console.log(`\n总耗时：${(totalMs / 1000).toFixed(2)}s；成功 ${finalTask?.success_rows ?? 0}；失败 ${finalTask?.failed_rows ?? 0}；HTTP 错误 ${httpErrors}`);
console.log(`上传 P95（单次样本）：${Math.round(uploadMs)}ms；目标 <=1000ms：${uploadMs <= 1000 ? "PASS" : "FAIL"}`);
console.log(`10,000 行 <=60s：${rows.length >= 10000 && totalMs <= 60000 ? "PASS" : "FAIL"}`);
process.exit(rows.length >= 10000 && totalMs <= 60000 && uploadMs <= 1000 && httpErrors === 0 ? 0 : 1);
