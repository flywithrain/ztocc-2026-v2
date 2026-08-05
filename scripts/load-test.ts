import { upload } from "@vercel/blob/client";
import { config } from "dotenv";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import { buildSourceBlobPath } from "../src/lib/blob-paths";

config({ path: ".env.local", quiet: true });

const baseUrl = (process.env.LOAD_TEST_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const ruleId = process.env.LOAD_TEST_RULE_ID;
const filePath = process.env.LOAD_TEST_FILE || "test-data/10000-orders-fixed.xlsx";
const createSamples = Math.max(1, Math.min(20, Number(process.env.LOAD_TEST_CREATE_SAMPLES || 20)));
const pollIntervalMs = 2000;
if (!ruleId) throw new Error("请设置 LOAD_TEST_RULE_ID（使用已确认保存的解析规则）");

const fileBuffer = await readFile(filePath);
const workbook = XLSX.read(fileBuffer, { type: "buffer" });
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
const fileName = filePath.split(/[\\/]/).pop() || "10000-orders-fixed.xlsx";
const mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function percentile(values: number[], ratio: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function makeSmallWorkbook() {
  const sampleWorkbook = XLSX.utils.book_new();
  const sampleSheet = XLSX.utils.json_to_sheet(records.slice(0, Math.min(10, records.length)));
  XLSX.utils.book_append_sheet(sampleWorkbook, sampleSheet, workbook.SheetNames[0] || "Sheet1");
  return Buffer.from(XLSX.write(sampleWorkbook, { type: "buffer", bookType: "xlsx" }));
}

async function uploadAndCreate(buffer: Buffer, name: string, totalRowsHint: number) {
  const pathname = buildSourceBlobPath(name);
  const blobStarted = performance.now();
  const blobBody = new Uint8Array(buffer.byteLength);
  blobBody.set(buffer);
  const blob = await upload(pathname, new Blob([blobBody], { type: mimeType }), {
    access: "private",
    handleUploadUrl: `${baseUrl}/api/import-files/upload`,
    headers: { origin: baseUrl },
    multipart: buffer.byteLength > 5 * 1024 * 1024,
    contentType: mimeType,
  });
  const blobUploadMs = performance.now() - blobStarted;
  const taskStarted = performance.now();
  const response = await fetch(`${baseUrl}/api/import-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      file_name: name,
      parse_rule_id: ruleId,
      source_blob_url: blob.url,
      source_blob_pathname: blob.pathname,
      file_hash: createHash("sha256").update(buffer).digest("hex"),
      file_mime: mimeType,
      file_size: buffer.byteLength,
      total_rows_hint: totalRowsHint,
    }),
  });
  const taskCreateMs = performance.now() - taskStarted;
  const task = await response.json() as { task_id?: string; trace_id?: string; error?: string };
  if (!response.ok || !task.task_id) throw new Error(`创建失败 ${response.status}: ${task.error || "未知错误"}`);
  return { taskId: task.task_id, traceId: task.trace_id, blobUploadMs, taskCreateMs };
}

async function waitForTask(taskId: string, expectedRows: number, timeoutMs = 180000) {
  const started = performance.now();
  let httpErrors = 0;
  let task: { status: string; success_rows: number; failed_rows: number; processed_rows: number } | undefined;
  while (performance.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/api/import-tasks/${taskId}`);
    if (!response.ok) {
      httpErrors++;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      continue;
    }
    task = await response.json();
    process.stdout.write(`\r${task!.status}: ${task!.processed_rows}/${expectedRows}`);
    if (["completed", "partial_success", "failed"].includes(task!.status)) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  if (!task || !["completed", "partial_success", "failed"].includes(task.status)) {
    throw new Error(`任务 ${taskId} 在 ${timeoutMs / 1000} 秒内未结束`);
  }
  return { task, httpErrors, waitMs: performance.now() - started };
}

console.log(`正式链路任务创建 P95：${createSamples} 个小文件样本`);
const smallBuffer = makeSmallWorkbook();
const smallTasks: string[] = [];
const createDurations: number[] = [];
const uploadDurations: number[] = [];
for (let index = 0; index < createSamples; index++) {
  const created = await uploadAndCreate(smallBuffer, `p95-${String(index + 1).padStart(2, "0")}.xlsx`, Math.min(10, records.length));
  smallTasks.push(created.taskId);
  createDurations.push(created.taskCreateMs);
  uploadDurations.push(created.blobUploadMs);
  console.log(`${index + 1}/${createSamples} Blob ${Math.round(created.blobUploadMs)}ms，任务创建 ${Math.round(created.taskCreateMs)}ms`);
}

console.log("等待 P95 样本任务结束，避免干扰 10,000 行测试...");
await Promise.all(smallTasks.map((taskId) => waitForTask(taskId, Math.min(10, records.length))));
const taskCreateP95 = percentile(createDurations, 0.95);
const blobUploadP95 = percentile(uploadDurations, 0.95);

console.log(`\n开始 ${records.length.toLocaleString("en-US")} 行正式链路测试...`);
const fullStarted = performance.now();
const full = await uploadAndCreate(fileBuffer, fileName, records.length);
const completed = await waitForTask(full.taskId, records.length);
const totalMs = performance.now() - fullStarted;

const result = {
  base_url: baseUrl,
  task_id: full.taskId,
  trace_id: full.traceId,
  create_samples: createSamples,
  blob_upload_p95_ms: Math.round(blobUploadP95),
  task_create_p95_ms: Math.round(taskCreateP95),
  full_blob_upload_ms: Math.round(full.blobUploadMs),
  full_task_create_ms: Math.round(full.taskCreateMs),
  full_chain_ms: Math.round(totalMs),
  status: completed.task.status,
  processed_rows: completed.task.processed_rows,
  success_rows: completed.task.success_rows,
  failed_rows: completed.task.failed_rows,
  http_errors: completed.httpErrors,
  targets: {
    task_create_p95_under_1000: taskCreateP95 <= 1000,
    ten_thousand_rows_under_60000: records.length >= 10000 && totalMs <= 60000,
    no_http_errors: completed.httpErrors === 0,
  },
};
console.log(`\n${JSON.stringify(result, null, 2)}`);
process.exit(
  result.targets.task_create_p95_under_1000 &&
  result.targets.ten_thousand_rows_under_60000 &&
  result.targets.no_http_errors ? 0 : 1
);
