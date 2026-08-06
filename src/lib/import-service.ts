import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { and, asc, eq, inArray, lte, ne } from "drizzle-orm";
import { db, sql } from "@/lib/db";
import { assertImportBlobReference, deleteImportBlobs, readPrivateBlobBuffer, readPrivateBlobJson, verifyImportBlob, writeBatchPayload, type ImportEditManifest } from "@/lib/blob-storage";
import { readFileBuffer } from "@/lib/file-reader";
import { parseFile } from "@/lib/parse-engine";
import { isQStashConfigured, publishImportEvent } from "@/lib/qstash-publisher";
import {
  importTaskBatches,
  importTasks,
  orders,
  parseRules,
  shipments,
  skuMaster,
  traceEvents,
} from "@/lib/db-schema";
import { checkReceiverConsistency, validateOrders } from "@/lib/validators";
import type { OrderRow, ValidationError } from "@/types";
import type { BlobImportTaskInput, ImportEventEnvelope, ImportTaskPayload, ImportTaskSummary } from "@/lib/import-types";

export const IMPORT_BATCH_SIZE = Math.max(100, Number(process.env.IMPORT_BATCH_SIZE || 1000));
export const WORKER_CONCURRENCY = Math.max(1, Number(process.env.IMPORT_WORKER_CONCURRENCY || 4));
const SKU_TIMEOUT_MS = Math.max(500, Number(process.env.SKU_VALIDATION_TIMEOUT_MS || 3000));

const ERROR_MAP: Record<string, { code: string; suggestion: string }> = {
  skuCode: { code: "E002", suggestion: "补充 SKU 编码后重新导入" },
  skuName: { code: "E002", suggestion: "补充 SKU 名称后重新导入" },
  receiverPhone: { code: "E003", suggestion: "填写 11 位中国大陆手机号" },
  skuQuantity: { code: "E004", suggestion: "数量必须是大于 0 的数字" },
  externalCode: { code: "E005", suggestion: "确认外部编码是否已导入或更换业务编码" },
};

function nowMs() {
  return performance.now();
}

function hashPayload(fileName: string, rows: OrderRow[]) {
  return createHash("sha256").update(fileName).update(JSON.stringify(rows)).digest("hex");
}

function encodePayload(payload: ImportTaskPayload) {
  return { encoding: "gzip-base64-v1", data: gzipSync(JSON.stringify(payload), { level: 6 }).toString("base64") };
}

function decodePayload(value: unknown): ImportTaskPayload {
  const encoded = value as { encoding?: string; data?: string };
  if (encoded?.encoding === "gzip-base64-v1" && encoded.data) {
    return JSON.parse(gunzipSync(Buffer.from(encoded.data, "base64")).toString("utf8")) as ImportTaskPayload;
  }
  return value as ImportTaskPayload;
}

type WorkerTaskContext = {
  id: string;
  traceId: string;
  startedAt: Date | null;
  totalBatches: number;
  parseDurationMs: number;
  ruleDurationMs: number;
  payload: ImportTaskPayload | null;
};

const taskContextCache = new Map<string, Promise<WorkerTaskContext>>();

function loadWorkerTaskContext(taskId: string) {
  const cached = taskContextCache.get(taskId);
  if (cached) return cached;
  const pending = db.select({ id: importTasks.id, traceId: importTasks.traceId, startedAt: importTasks.startedAt, totalBatches: importTasks.totalBatches, parseDurationMs: importTasks.parseDurationMs, ruleDurationMs: importTasks.ruleDurationMs, filePayload: importTasks.filePayload })
    .from(importTasks)
    .where(eq(importTasks.id, taskId))
    .limit(1)
    .then(([task]) => {
      if (!task) throw new Error("导入任务不存在");
      return { id: task.id, traceId: task.traceId, startedAt: task.startedAt, totalBatches: task.totalBatches, parseDurationMs: task.parseDurationMs, ruleDurationMs: task.ruleDurationMs, payload: task.filePayload ? decodePayload(task.filePayload) : null };
    });
  taskContextCache.set(taskId, pending);
  return pending;
}

function stableUuid(value: string) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function maskSensitive(field: string, value: unknown) {
  const raw = String(value ?? "");
  if (field === "receiverPhone") return raw.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
  if (field === "receiverAddress" && raw.length > 8) return `${raw.slice(0, 6)}***${raw.slice(-2)}`;
  return raw.slice(0, 500);
}

function rawValue(row: OrderRow, field: string) {
  return (row as unknown as Record<string, unknown>)[field];
}

async function trace(taskId: string, traceId: string, eventName: string, status: string, message: string, unitId?: string, metadata?: Record<string, unknown>) {
  try {
    await db.insert(traceEvents).values({ taskId, traceId, unitId, eventName, eventStatus: status, message, metadata });
  } catch (error) {
    console.error("Trace 写入失败", { taskId, traceId, eventName, error });
  }
}

export async function createBlobImportTask(input: BlobImportTaskInput) {
  if (!/^[0-9a-f]{64}$/i.test(input.fileHash)) throw new Error("file_hash 必须是 64 位 SHA-256");
  assertImportBlobReference(input.sourceBlobUrl, input.sourceBlobPathname, "source");
  if (input.editManifestBlobPathname || input.editManifestBlobUrl) {
    if (!input.editManifestBlobPathname || !input.editManifestBlobUrl) throw new Error("编辑清单 Blob URL 与 pathname 必须同时提供");
    assertImportBlobReference(input.editManifestBlobUrl, input.editManifestBlobPathname, "manifest");
  }
  const source = await verifyImportBlob(input.sourceBlobPathname, Math.max(1, Number(process.env.IMPORT_MAX_FILE_SIZE_MB || 50)) * 1024 * 1024);
  if (source.size !== input.fileSize) throw new Error("原始文件大小与 Blob 元数据不一致");
  if (input.editManifestBlobPathname) await verifyImportBlob(input.editManifestBlobPathname, 50 * 1024 * 1024);

  const taskId = crypto.randomUUID();
  const traceId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const retentionHours = Math.max(1, Number(process.env.IMPORT_BLOB_RETENTION_HOURS || 24));
  const retainUntil = new Date(Date.now() + retentionHours * 60 * 60 * 1000);
  const envelope: ImportEventEnvelope = {
    event_id: eventId,
    event_type: "ImportFileUploaded",
    schema_version: 1,
    aggregate_id: taskId,
    trace_id: traceId,
    occurred_at: new Date().toISOString(),
    payload: { task_id: taskId },
  };
  const initialTraceEvents = [
    { event_name: "ImportApiAccepted", event_status: "success", message: "导入 API 已接收文件引用请求", metadata: { file_name: input.fileName, request_mode: "private_blob_reference" } },
    { event_name: "ImportIdentifiersGenerated", event_status: "success", message: "已生成 task_id 与 trace_id", metadata: { task_id: taskId, trace_id: traceId } },
    { event_name: "ImportFileReferenceSaved", event_status: "success", message: "原始文件可复读引用已验证并保存", metadata: { source_pathname: input.sourceBlobPathname, file_size: source.size, file_mime: input.fileMime || source.contentType, retention_hours: retentionHours } },
    { event_name: "ImportRowCountPrescanned", event_status: "success", message: `预扫描得到总行数提示 ${Math.max(0, input.totalRowsHint || 0)} 行`, metadata: { total_rows_hint: Math.max(0, input.totalRowsHint || 0), final_count_pending_worker_parse: true } },
    { event_name: "ImportTaskRecordCreated", event_status: "success", message: "import_tasks 任务记录与 Transactional Outbox 已原子创建", metadata: { task_id: taskId, trace_id: traceId, outbox_event_id: eventId, outbox_event_type: envelope.event_type } },
  ];

  await sql`
    with task_insert as (
      insert into import_tasks (
        id, file_name, file_hash, parse_rule_id, status, total_rows, total_batches, trace_id,
        source_blob_url, source_blob_pathname, edit_manifest_blob_url, edit_manifest_blob_pathname,
        file_mime, file_size, processing_stage, blob_retain_until
      ) values (
        ${taskId}, ${input.fileName}, ${input.fileHash}, ${input.parseRuleId}, 'pending', ${Math.max(0, input.totalRowsHint || 0)}, 0, ${traceId},
        ${input.sourceBlobUrl}, ${input.sourceBlobPathname}, ${input.editManifestBlobUrl || null}, ${input.editManifestBlobPathname || null},
        ${input.fileMime || source.contentType}, ${source.size}, 'file_uploaded', ${retainUntil}
      ) returning id
    ), outbox_insert as (
      insert into event_outbox (id, aggregate_id, event_type, schema_version, payload, status, provider, next_retry_at)
      select ${eventId}, id, 'ImportFileUploaded', 1, ${JSON.stringify(envelope)}::jsonb, 'pending', 'qstash', now()
      from task_insert returning id
    )
    insert into trace_events (id, trace_id, task_id, event_name, event_status, message, metadata)
    select gen_random_uuid(), ${traceId}, task_insert.id, x.event_name, x.event_status, x.message, x.metadata
    from task_insert
    cross join jsonb_to_recordset(${JSON.stringify(initialTraceEvents)}::jsonb)
      as x(event_name varchar, event_status varchar, message text, metadata jsonb)
    where exists (select 1 from outbox_insert)
  `;

  return {
    task_id: taskId,
    trace_id: traceId,
    status: "pending" as const,
    total_rows: Math.max(0, input.totalRowsHint || 0),
    total_batches: 0,
    duplicate_key: input.fileHash,
  };
}

/**
 * @deprecated 仅供真实 Neon 集成测试和旧任务兼容；生产 API 明确拒绝 rows，正式链路必须使用 createBlobImportTask。
 */
export async function createImportTask(input: { fileName: string; parseRuleId: string; rule: ImportTaskPayload["rule"]; rows: OrderRow[] }) {
  if (input.rows.length === 0) throw new Error("解析结果为空，无法创建导入任务");
  if (input.rows.length > 50000) throw new Error("单个任务最多支持 50,000 行");

  const taskId = crypto.randomUUID();
  const traceId = crypto.randomUUID();
  const taskCreatedEventId = crypto.randomUUID();
  const totalBatches = Math.ceil(input.rows.length / IMPORT_BATCH_SIZE);
  const fileHash = hashPayload(input.fileName, input.rows);
  const payload: ImportTaskPayload = { fileName: input.fileName, rule: input.rule, rows: input.rows };
  const storedPayload = encodePayload(payload);

  const batchValues = Array.from({ length: totalBatches }, (_, batchIndex) => ({
    id: crypto.randomUUID(),
    taskId,
    unitId: `batch_${String(batchIndex + 1).padStart(4, "0")}`,
    batchIndex,
    startRow: batchIndex * IMPORT_BATCH_SIZE,
    endRow: Math.min((batchIndex + 1) * IMPORT_BATCH_SIZE, input.rows.length),
    status: "pending",
  }));

  const outboxValues = batchValues.map((batch) => {
    const eventId = crypto.randomUUID();
    const envelope: ImportEventEnvelope = {
      event_id: eventId,
      event_type: "ImportBatchCreated",
      schema_version: 1,
      aggregate_id: taskId,
      trace_id: traceId,
      occurred_at: new Date().toISOString(),
      payload: { task_id: taskId, unit_id: batch.unitId, batch_index: batch.batchIndex, start_row: batch.startRow, end_row: batch.endRow },
    };
    return { id: eventId, aggregateId: taskId, eventType: envelope.event_type, schemaVersion: 1, payload: envelope };
  });

  const taskEvent: ImportEventEnvelope = {
    event_id: taskCreatedEventId,
    event_type: "ImportTaskCreated",
    schema_version: 1,
    aggregate_id: taskId,
    trace_id: traceId,
    occurred_at: new Date().toISOString(),
    payload: { task_id: taskId, file_name: input.fileName, total_rows: input.rows.length, total_batches: totalBatches },
  };

  const storedBatches = batchValues.map((batch) => ({ id: batch.id, task_id: batch.taskId, unit_id: batch.unitId, batch_index: batch.batchIndex, start_row: batch.startRow, end_row: batch.endRow, status: batch.status }));
  const storedOutbox = [
    { id: taskCreatedEventId, aggregate_id: taskId, event_type: "ImportTaskCreated", schema_version: 1, payload: taskEvent, status: "sent" },
    ...outboxValues.map((event) => ({ id: event.id, aggregate_id: taskId, event_type: event.eventType, schema_version: 1, payload: event.payload, status: "pending" })),
  ];
  await sql`
    with task_insert as (
      insert into import_tasks (id, file_name, file_hash, parse_rule_id, status, total_rows, total_batches, trace_id, file_payload)
      values (${taskId}, ${input.fileName}, ${fileHash}, ${input.parseRuleId}, 'pending', ${input.rows.length}, ${totalBatches}, ${traceId}, ${JSON.stringify(storedPayload)}::jsonb)
      returning id
    ), batch_insert as (
      insert into import_task_batches (id, task_id, unit_id, batch_index, start_row, end_row, status)
      select x.id, x.task_id, x.unit_id, x.batch_index, x.start_row, x.end_row, x.status
      from jsonb_to_recordset(${JSON.stringify(storedBatches)}::jsonb)
      as x(id uuid, task_id uuid, unit_id varchar, batch_index int, start_row int, end_row int, status varchar)
      cross join task_insert
      returning id
    ), outbox_insert as (
      insert into event_outbox (id, aggregate_id, event_type, schema_version, payload, status, next_retry_at)
      select x.id, x.aggregate_id, x.event_type, x.schema_version, x.payload, x.status, now()
      from jsonb_to_recordset(${JSON.stringify(storedOutbox)}::jsonb)
      as x(id uuid, aggregate_id uuid, event_type varchar, schema_version int, payload jsonb, status varchar)
      cross join task_insert
      returning id
    )
    insert into trace_events (id, trace_id, task_id, event_name, event_status, message, metadata)
    select gen_random_uuid(), ${traceId}, task_insert.id, 'ImportTaskCreated', 'success',
      ${`已创建 ${totalBatches} 个处理单元，等待可靠投递`},
      ${JSON.stringify({ total_rows: input.rows.length, total_batches: totalBatches, batch_size: IMPORT_BATCH_SIZE })}::jsonb
    from task_insert
    where (select count(*) from batch_insert) = ${totalBatches}
      and (select count(*) from outbox_insert) = ${storedOutbox.length}
  `;

  return { task_id: taskId, trace_id: traceId, status: "pending", total_rows: input.rows.length, total_batches: totalBatches, duplicate_key: fileHash };
}

export async function dispatchOutbox(taskId?: string) {
  if (!isQStashConfigured()) {
    if (process.env.NODE_ENV === "production") throw new Error("Production 必须完整配置 QStash");
    return 0;
  }

  const claimToken = crypto.randomUUID();
  const events = await sql`
    with expired_leases as (
      update event_outbox
      set status = 'failed', retry_count = retry_count + 1,
        next_retry_at = now(), last_error = 'Outbox publishing lease expired; dispatcher will retry',
        claimed_at = null, claim_token = null, lease_expires_at = null
      where status = 'publishing' and lease_expires_at < now()
      returning id
    ), claimable as (
      select id
      from event_outbox
      where status in ('pending', 'failed')
        and next_retry_at <= now()
        and (lease_expires_at is null or lease_expires_at < now())
        and (${taskId || null}::uuid is null or aggregate_id = ${taskId || null}::uuid)
      order by created_at
      limit 100
      for update skip locked
    )
    update event_outbox e
    set status = 'publishing', claimed_at = now(), claim_token = ${claimToken}, lease_expires_at = now() + interval '30 seconds'
    from claimable c
    where e.id = c.id
    returning e.id, e.aggregate_id, e.payload, e.retry_count
  ` as unknown as Array<{ id: string; aggregate_id: string; payload: ImportEventEnvelope; retry_count: number }>;

  for (const event of events) {
    try {
      const published = await publishImportEvent(event.payload);
      await sql`
        update event_outbox
        set status = 'sent', sent_at = now(), last_error = null, provider = 'qstash',
          provider_message_id = ${published.messageId}, last_provider_response = ${JSON.stringify(published.providerResponse)}::jsonb,
          claimed_at = null, claim_token = null, lease_expires_at = null
        where id = ${event.id} and claim_token = ${claimToken}
      `;
      await trace(event.aggregate_id, event.payload.trace_id, "QStashPublished", "success", "事件已投递到 Upstash QStash", undefined, {
        event_id: event.id,
        event_type: event.payload.event_type,
        qstash_message_id: published.messageId,
      });
    } catch (error) {
      const retry = event.retry_count + 1;
      const message = error instanceof Error ? error.message : String(error);
      await sql`
        update event_outbox
        set status = 'failed', retry_count = ${retry}, last_error = ${message},
          next_retry_at = now() + make_interval(secs => least(60, power(2, ${retry})::int)),
          claimed_at = null, claim_token = null, lease_expires_at = null
        where id = ${event.id} and claim_token = ${claimToken}
      `;
      await trace(event.aggregate_id, event.payload.trace_id, "QStashPublishFailed", "failed", message, undefined, {
        event_id: event.id,
        retry_count: retry,
      });
    }
  }
  return events.length;
}

async function loadSkuSet(codes: string[]) {
  if (!codes.length) return new Set<string>();
  const rows = await Promise.race([
    db.select({ skuCode: skuMaster.skuCode }).from(skuMaster).where(inArray(skuMaster.skuCode, codes)),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SKU validation timeout")), SKU_TIMEOUT_MS)),
  ]);
  return new Set(rows.map((row) => row.skuCode));
}

function buildValidationErrors(rows: OrderRow[], existingSkuCodes: Set<string> | null, existingExternalCodes: Set<string>) {
  const errors = [...validateOrders(rows), ...checkReceiverConsistency(rows)];
  for (const row of rows) {
    const code = row.externalCode?.trim();
    if (code && existingExternalCodes.has(code)) {
      errors.push({ rowIndex: row.rowIndex, field: "externalCode", message: `外部编码"${code}"已存在于数据库中` });
    }
  }
  if (existingSkuCodes) {
    for (const row of rows) {
      if (row.skuCode?.trim() && !existingSkuCodes.has(row.skuCode.trim())) {
        errors.push({ rowIndex: row.rowIndex, field: "skuCode", message: "SKU 不存在于商品主数据" });
      }
    }
  }
  return errors;
}

function buildSuccessfulRows(rows: OrderRow[], taskId: string, batchIndex: number) {
  const shipmentRows: (typeof shipments.$inferInsert)[] = [];
  const orderRows: (typeof orders.$inferInsert)[] = [];
  const groups = new Map<string, OrderRow[]>();
  for (const row of rows) {
    const key = row.externalCode?.trim() ? `code:${row.externalCode.trim()}` : `row:${row.rowIndex}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const groupKey = group[0].externalCode?.trim() || `row:${group[0].rowIndex}`;
    const shipmentId = stableUuid(`${taskId}:${groupKey}`);
    const pick = (field: keyof OrderRow) => group.map((row) => String(row[field] ?? "").trim()).find(Boolean) || null;
    shipmentRows.push({
      id: shipmentId,
      externalCode: group[0].externalCode?.trim() || `ASYNC-${taskId.slice(0, 8)}-${batchIndex}-${group[0].rowIndex}`,
      storeName: pick("storeName"), receiverName: pick("receiverName"), receiverPhone: pick("receiverPhone"), receiverAddress: pick("receiverAddress"), remark: pick("remark"),
      skuCount: group.length, totalQuantity: String(group.reduce((sum, row) => sum + Number(row.skuQuantity || 0), 0)), batchId: taskId,
    });
    for (const row of group) {
      orderRows.push({ id: stableUuid(`${taskId}:${row.rowIndex}:${row.skuCode}`), shipmentId, skuCode: row.skuCode, skuName: row.skuName, skuQuantity: String(row.skuQuantity), skuSpec: row.skuSpec || null, remark: row.remark || null });
    }
  }

  return { shipmentRows, orderRows };
}

export async function processImportBatch(taskId: string, unitId: string, delivery?: { messageId?: string | null; deliveryAttempt?: number }) {
  const batchStartedAt = new Date();
  const claimed = await sql`
    with claimed as (
      update import_task_batches
      set status = 'processing', locked_at = now(), retry_count = retry_count + 1, version = version + 1,
        qstash_message_id = coalesce(${delivery?.messageId || null}, qstash_message_id),
        delivery_attempt = greatest(delivery_attempt, ${delivery?.deliveryAttempt || 0}),
        last_delivery_at = case when ${delivery?.deliveryAttempt || 0} > 0 then now() else last_delivery_at end
      where task_id = ${taskId} and unit_id = ${unitId} and status in ('pending', 'failed')
      returning id, batch_index, start_row, end_row
    ), task_started as (
      update import_tasks
      set status = 'processing', started_at = coalesce(started_at, now())
      where id = ${taskId} and exists (select 1 from claimed)
      returning trace_id
    ), trace_insert as (
      insert into trace_events (id, trace_id, task_id, unit_id, event_name, event_status, message, metadata)
      select gen_random_uuid(), task_started.trace_id, ${taskId}, ${unitId}, 'ImportBatchStarted', 'processing',
        ${`${unitId} 开始处理`}, jsonb_build_object('batch_index', claimed.batch_index)
      from claimed cross join task_started
      returning id
    )
    select claimed.*, task_started.trace_id
    from claimed cross join task_started
  ` as unknown as { id: string; batch_index: number; start_row: number; end_row: number; trace_id: string }[];
  if (!claimed.length) return { idempotent: true, unit_id: unitId };

  const batch = claimed[0];
  const task = await loadWorkerTaskContext(taskId);
  const batchRow = await db.select({ payloadBlobPathname: importTaskBatches.payloadBlobPathname })
    .from(importTaskBatches)
    .where(eq(importTaskBatches.id, batch.id))
    .limit(1);
  const rows = batchRow[0]?.payloadBlobPathname
    ? (await readPrivateBlobJson<{ schema_version: 1; rows: OrderRow[] }>(batchRow[0].payloadBlobPathname)).rows
    : task.payload?.rows.slice(batch.start_row, batch.end_row);
  if (!rows) throw new Error("批次既没有 Blob payload，也没有可兼容的旧任务载荷");

  try {
    const validateStarted = nowMs();
    const skuCodes = Array.from(new Set(rows.map((row) => row.skuCode?.trim()).filter(Boolean) as string[]));
    const externalCodes = Array.from(new Set(rows.map((row) => row.externalCode?.trim()).filter(Boolean) as string[]));
    const externalPromise = externalCodes.length
      ? db.select({ externalCode: shipments.externalCode }).from(shipments).where(and(inArray(shipments.externalCode, externalCodes), ne(shipments.batchId, taskId)))
      : Promise.resolve([]);
    let skuSet: Set<string> | null = null;
    let degraded = false;
    let degradedError = "";
    try {
      skuSet = await loadSkuSet(skuCodes);
    } catch (error) {
      degraded = true;
      degradedError = error instanceof Error ? error.message : String(error);
    }
    const existingExternalRows = await externalPromise;
    const existingExternalCodes = new Set(existingExternalRows.map((row) => row.externalCode).filter(Boolean) as string[]);
    const validationErrors = buildValidationErrors(rows, skuSet, existingExternalCodes);
    const validateDurationMs = Math.round(nowMs() - validateStarted);
    const errorsByRow = new Map<number, ValidationError[]>();
    for (const error of validationErrors) {
      const list = errorsByRow.get(error.rowIndex) || [];
      list.push(error);
      errorsByRow.set(error.rowIndex, list);
    }

    const successfulRows = rows.filter((row) => !errorsByRow.has(row.rowIndex));
    const rowsByIndex = new Map(rows.map((row) => [row.rowIndex, row]));
    // 文件解析与规则执行发生在批次创建前，按处理单元均摊到每条性能日志，避免阶段监控出现固定 0。
    const batchParseDurationMs = Math.round(task.parseDurationMs / Math.max(task.totalBatches, 1));
    const batchRuleDurationMs = Math.round(task.ruleDurationMs / Math.max(task.totalBatches, 1));
    const errorValues = validationErrors.map((error) => {
      const row = rowsByIndex.get(error.rowIndex)!;
      const meta = error.message.includes("SKU 不存在")
        ? { code: "E001", suggestion: "核对 SKU 编码，或先维护商品主数据" }
        : ERROR_MAP[error.field] || { code: "E006", suggestion: "检查解析规则映射与原始文件字段" };
      return {
        id: stableUuid(`${taskId}:${unitId}:${error.rowIndex}:${error.field}:${error.message}`),
        task_id: taskId,
        unit_id: unitId,
        batch_index: batch.batch_index,
        row_number: row.sourceRowNumber ?? error.rowIndex + 1,
        field_name: error.field,
        raw_value: maskSensitive(error.field, rawValue(row, error.field)),
        error_code: meta.code,
        error_reason: error.message,
        suggestion: meta.suggestion,
        trace_id: task.traceId,
      };
    });
    const { shipmentRows, orderRows } = buildSuccessfulRows(successfulRows, taskId, batch.batch_index);
    const shipmentValues = shipmentRows.map((row) => ({
      id: row.id, external_code: row.externalCode, store_name: row.storeName, receiver_name: row.receiverName,
      receiver_phone: row.receiverPhone, receiver_address: row.receiverAddress, remark: row.remark,
      sku_count: row.skuCount, total_quantity: row.totalQuantity, batch_id: row.batchId,
    }));
    const orderValues = orderRows.map((row) => ({
      id: row.id, shipment_id: row.shipmentId, sku_code: row.skuCode, sku_name: row.skuName,
      sku_quantity: row.skuQuantity, sku_spec: row.skuSpec, remark: row.remark,
    }));

    const queries: unknown[] = [];
    if (errorValues.length) queries.push(sql`
      insert into import_task_errors (id, task_id, unit_id, batch_index, row_number, field_name, raw_value, error_code, error_reason, suggestion, trace_id)
      select id, task_id, unit_id, batch_index, row_number, field_name, raw_value, error_code, error_reason, suggestion, trace_id
      from jsonb_to_recordset(${JSON.stringify(errorValues)}::jsonb)
      as x(id uuid, task_id uuid, unit_id varchar, batch_index int, row_number int, field_name varchar, raw_value text, error_code varchar, error_reason text, suggestion text, trace_id uuid)
      on conflict (id) do nothing
    `);
    if (shipmentValues.length) queries.push(sql`
      insert into shipments (id, external_code, store_name, receiver_name, receiver_phone, receiver_address, remark, sku_count, total_quantity, batch_id)
      select id, external_code, store_name, receiver_name, receiver_phone, receiver_address, remark, sku_count, total_quantity, batch_id
      from jsonb_to_recordset(${JSON.stringify(shipmentValues)}::jsonb)
      as x(id uuid, external_code varchar, store_name varchar, receiver_name varchar, receiver_phone varchar, receiver_address text, remark text, sku_count int, total_quantity numeric, batch_id uuid)
      on conflict (id) do nothing
    `);
    if (orderValues.length) queries.push(sql`
      insert into orders (id, shipment_id, sku_code, sku_name, sku_quantity, sku_spec, remark)
      select id, shipment_id, sku_code, sku_name, sku_quantity, sku_spec, remark
      from jsonb_to_recordset(${JSON.stringify(orderValues)}::jsonb)
      as x(id uuid, shipment_id uuid, sku_code varchar, sku_name varchar, sku_quantity numeric, sku_spec varchar, remark text)
      on conflict (id) do nothing
    `);
    if (degraded) queries.push(sql`
      update import_tasks set degraded = true, degraded_reason = 'SKU 主数据查询超时或暂时不可用，已仅执行本地格式校验' where id = ${taskId}
    `);
    queries.push(
      sql`update import_task_batches set status = 'completed', processed_rows = ${rows.length}, success_rows = ${successfulRows.length}, failed_rows = ${errorsByRow.size}, completed_at = now(), last_error = null where id = ${batch.id}`,
      sql`insert into trace_events (id, trace_id, task_id, unit_id, event_name, event_status, message, metadata)
          values (gen_random_uuid(), ${task.traceId}, ${taskId}, ${unitId}, 'ImportBatchValidated', 'success',
            ${`${unitId} 批量校验完成：${validationErrors.length} 个字段错误，影响 ${errorsByRow.size} 行`},
            ${JSON.stringify({ batch_index: batch.batch_index, validate_duration_ms: validateDurationMs, error_fields: validationErrors.length, error_rows: errorsByRow.size, degraded })}::jsonb)`,
      sql`insert into trace_events (id, trace_id, task_id, unit_id, event_name, event_status, message, metadata)
          values (gen_random_uuid(), ${task.traceId}, ${taskId}, ${unitId}, 'ImportDatabaseWritten', 'success',
            ${`${unitId} 已完成数据库批量写入：${shipmentRows.length} 个运单，${orderRows.length} 条 SKU 明细`},
            ${JSON.stringify({ batch_index: batch.batch_index, shipment_count: shipmentRows.length, order_count: orderRows.length, success_rows: successfulRows.length })}::jsonb)`,
      sql`insert into batch_performance_log (id, task_id, unit_id, batch_index, parse_duration_ms, rule_duration_ms, validate_duration_ms, insert_duration_ms, total_duration_ms, status, trace_id)
          values (gen_random_uuid(), ${taskId}, ${unitId}, ${batch.batch_index}, ${batchParseDurationMs}, ${batchRuleDurationMs}, ${validateDurationMs},
            greatest(0, extract(epoch from (clock_timestamp() - ${batchStartedAt}::timestamptz)) * 1000 - ${validateDurationMs})::int,
            ((extract(epoch from (clock_timestamp() - ${batchStartedAt}::timestamptz)) * 1000)::int + ${batchParseDurationMs} + ${batchRuleDurationMs}), 'completed', ${task.traceId})
          on conflict (task_id, unit_id) do nothing`,
      sql`insert into trace_events (id, trace_id, task_id, unit_id, event_name, event_status, message, metadata)
          values (gen_random_uuid(), ${task.traceId}, ${taskId}, ${unitId}, 'ImportBatchSucceeded', 'success',
            ${`${unitId} 完成：成功 ${successfulRows.length} 行，失败 ${errorsByRow.size} 行`},
            ${JSON.stringify({ degraded, degraded_error: degradedError || undefined, validate_duration_ms: validateDurationMs, start_row: batch.start_row + 1, end_row: batch.end_row })}::jsonb)`,
    );
    await (sql as typeof sql & { transaction: (queries: unknown[]) => Promise<unknown> }).transaction(queries);
    return { idempotent: false, unit_id: unitId, processed: rows.length, success: successfulRows.length, failed: errorsByRow.size, degraded };
  } catch (error) {
    await sql.transaction([
      sql`update import_task_batches set status = 'failed', last_error = ${error instanceof Error ? error.message : String(error)} where id = ${batch.id}`,
      sql`insert into trace_events (id, trace_id, task_id, unit_id, event_name, event_status, message) values (gen_random_uuid(), ${task.traceId}, ${taskId}, ${unitId}, 'ImportBatchFailed', 'failed', ${error instanceof Error ? error.message : String(error)})`,
    ]);
    throw error;
  }
}

/** @deprecated 仅供旧任务和数据库集成测试；生产消费统一由 QStash processImportEvent 驱动。 */
export async function processPendingBatches(taskId: string) {
  await dispatchOutbox(taskId);
  const batches = await db.select({ unitId: importTaskBatches.unitId }).from(importTaskBatches).where(and(eq(importTaskBatches.taskId, taskId), inArray(importTaskBatches.status, ["pending", "failed"]))).orderBy(asc(importTaskBatches.batchIndex));
  const results: unknown[] = [];
  try {
    for (let i = 0; i < batches.length; i += WORKER_CONCURRENCY) {
      results.push(...await Promise.all(batches.slice(i, i + WORKER_CONCURRENCY).map((batch) => processImportBatch(taskId, batch.unitId))));
    }
    await finalizeTask(taskId);
    return results;
  } finally {
    taskContextCache.delete(taskId);
  }
}

function applyEditManifest(rows: OrderRow[], manifest: ImportEditManifest | null) {
  if (!manifest) return rows;
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.deleted_row_indexes) || !Array.isArray(manifest.upserts)) {
    throw new Error("编辑清单格式无效");
  }
  if (manifest.mode === "replace") return manifest.upserts;
  const deleted = new Set(manifest.deleted_row_indexes);
  const byRowIndex = new Map(rows.filter((row) => !deleted.has(row.rowIndex)).map((row) => [row.rowIndex, row]));
  for (const row of manifest.upserts) byRowIndex.set(row.rowIndex, row);
  return Array.from(byRowIndex.values()).sort((a, b) => a.rowIndex - b.rowIndex);
}

export async function processImportFile(taskId: string) {
  const parseClaimToken = crypto.randomUUID();
  const claimed = await sql`
    update import_tasks
    set processing_stage = 'parsing', status = 'processing', started_at = coalesce(started_at, now()),
      parse_retry_count = parse_retry_count + 1, parse_last_error = null,
      parse_claim_token = ${parseClaimToken}, parse_lease_expires_at = now() + interval '3 minutes'
    where id = ${taskId} and processing_stage in ('file_uploaded', 'parse_failed')
    returning id, trace_id, file_name, file_hash, parse_rule_id, source_blob_pathname,
      edit_manifest_blob_pathname, file_mime
  ` as unknown as Array<{
    id: string;
    trace_id: string;
    file_name: string;
    file_hash: string;
    parse_rule_id: string;
    source_blob_pathname: string | null;
    edit_manifest_blob_pathname: string | null;
    file_mime: string | null;
  }>;
  if (!claimed.length) return { idempotent: true, task_id: taskId };
  const task = claimed[0];

  try {
    if (!task.source_blob_pathname) throw new Error("任务缺少原始文件 Blob 引用");
    const [sourceBuffer, ruleRows, manifest] = await Promise.all([
      readPrivateBlobBuffer(task.source_blob_pathname),
      db.select({ config: parseRules.config }).from(parseRules).where(eq(parseRules.id, task.parse_rule_id)).limit(1),
      task.edit_manifest_blob_pathname
        ? readPrivateBlobJson<ImportEditManifest>(task.edit_manifest_blob_pathname)
        : Promise.resolve(null),
    ]);
    if (!ruleRows[0]) throw new Error("解析规则不存在");
    const actualHash = createHash("sha256").update(sourceBuffer).digest("hex");
    if (actualHash !== task.file_hash) throw new Error("原始文件 SHA-256 与任务声明不一致");

    const rule = { id: task.parse_rule_id, ...(ruleRows[0].config as Record<string, unknown>) } as ImportTaskPayload["rule"];
    const parseStarted = nowMs();
    const parsed = await readFileBuffer(sourceBuffer, task.file_name, task.file_mime || undefined);
    const parseDurationMs = Math.round(nowMs() - parseStarted);
    const ruleStarted = nowMs();
    const rows = applyEditManifest(parseFile(parsed, rule), manifest);
    const ruleDurationMs = Math.round(nowMs() - ruleStarted);
    if (rows.length === 0) throw new Error("解析结果为空，无法创建处理批次");
    if (rows.length > 50000) throw new Error("单个任务最多支持 50,000 行");

    const totalBatches = Math.ceil(rows.length / IMPORT_BATCH_SIZE);
    const batchArtifacts = await Promise.all(Array.from({ length: totalBatches }, async (_, batchIndex) => {
      const unitId = `batch_${String(batchIndex + 1).padStart(4, "0")}`;
      const startRow = batchIndex * IMPORT_BATCH_SIZE;
      const endRow = Math.min((batchIndex + 1) * IMPORT_BATCH_SIZE, rows.length);
      const blob = await writeBatchPayload(taskId, unitId, rows.slice(startRow, endRow));
      const eventId = crypto.randomUUID();
      const envelope: ImportEventEnvelope = {
        event_id: eventId,
        event_type: "ImportBatchCreated",
        schema_version: 1,
        aggregate_id: taskId,
        trace_id: task.trace_id,
        occurred_at: new Date().toISOString(),
        payload: { task_id: taskId, unit_id: unitId, batch_index: batchIndex },
      };
      return {
        id: crypto.randomUUID(), eventId, unitId, batchIndex, startRow, endRow,
        payloadBlobUrl: blob.url, payloadBlobPathname: blob.pathname, envelope,
      };
    }));

    const storedBatches = batchArtifacts.map((batch) => ({
      id: batch.id, task_id: taskId, unit_id: batch.unitId, batch_index: batch.batchIndex,
      start_row: batch.startRow, end_row: batch.endRow, status: "pending",
      payload_blob_url: batch.payloadBlobUrl, payload_blob_pathname: batch.payloadBlobPathname,
    }));
    const storedOutbox = batchArtifacts.map((batch) => ({
      id: batch.eventId, aggregate_id: taskId, event_type: "ImportBatchCreated",
      schema_version: 1, payload: batch.envelope, status: "pending", provider: "qstash",
    }));

    await sql`
      with claim_guard as (
        select id from import_tasks where id = ${taskId} and parse_claim_token = ${parseClaimToken}
      ), batch_insert as (
        insert into import_task_batches (
          id, task_id, unit_id, batch_index, start_row, end_row, status, payload_blob_url, payload_blob_pathname
        )
        select x.id, x.task_id, x.unit_id, x.batch_index, x.start_row, x.end_row, x.status,
          x.payload_blob_url, x.payload_blob_pathname
        from jsonb_to_recordset(${JSON.stringify(storedBatches)}::jsonb)
        as x(id uuid, task_id uuid, unit_id varchar, batch_index int, start_row int, end_row int,
          status varchar, payload_blob_url text, payload_blob_pathname text)
        cross join claim_guard
        on conflict (task_id, unit_id) do nothing
        returning id
      ), outbox_insert as (
        insert into event_outbox (id, aggregate_id, event_type, schema_version, payload, status, provider, next_retry_at)
        select x.id, x.aggregate_id, x.event_type, x.schema_version, x.payload, x.status, x.provider, now()
        from jsonb_to_recordset(${JSON.stringify(storedOutbox)}::jsonb)
        as x(id uuid, aggregate_id uuid, event_type varchar, schema_version int, payload jsonb, status varchar, provider varchar)
        cross join claim_guard
        on conflict (id) do nothing
        returning id
      ), task_update as (
        update import_tasks set total_rows = ${rows.length}, total_batches = ${totalBatches},
          processing_stage = 'waiting_batches', parsed_at = now(), parse_last_error = null,
          parse_claim_token = null, parse_lease_expires_at = null,
          parse_duration_ms = ${parseDurationMs}, rule_duration_ms = ${ruleDurationMs}
        where id = ${taskId} and parse_claim_token = ${parseClaimToken}
        returning id
      )
      insert into trace_events (id, trace_id, task_id, event_name, event_status, message, metadata)
      select gen_random_uuid(), ${task.trace_id}, id, 'ImportFileParsed', 'success',
        ${`文件解析完成，已生成 ${totalBatches} 个 Blob 批次`},
        ${JSON.stringify({ total_rows: rows.length, total_batches: totalBatches, batch_size: IMPORT_BATCH_SIZE, parse_duration_ms: parseDurationMs, rule_duration_ms: ruleDurationMs })}::jsonb
      from task_update
    `;
    return { idempotent: false, task_id: taskId, total_rows: rows.length, total_batches: totalBatches };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql.transaction([
      sql`update import_tasks set processing_stage = 'parse_failed', status = 'pending', parse_last_error = ${message}, parse_claim_token = null, parse_lease_expires_at = null where id = ${taskId} and parse_claim_token = ${parseClaimToken}`,
      sql`insert into trace_events (id, trace_id, task_id, event_name, event_status, message) values (gen_random_uuid(), ${task.trace_id}, ${taskId}, 'ImportFileParseFailed', 'failed', ${message})`,
    ]);
    throw error;
  }
}

export async function processImportEvent(
  event: ImportEventEnvelope,
  delivery?: { messageId?: string | null; deliveryAttempt?: number }
) {
  const payload = event.payload as { task_id?: unknown; unit_id?: unknown };
  if (typeof payload.task_id !== "string") throw new Error("导入事件缺少 task_id");

  if (event.event_type === "ImportFileUploaded") {
    await trace(payload.task_id, event.trace_id, "ImportQueueConsumed", "processing", "QStash 已投递 ImportFileUploaded，Worker 开始读取原始文件", undefined, { qstash_message_id: delivery?.messageId || null, delivery_attempt: delivery?.deliveryAttempt || 0, event_type: event.event_type });
    const result = await processImportFile(payload.task_id);
    await dispatchOutbox(payload.task_id);
    return result;
  }
  if (event.event_type !== "ImportBatchCreated" || typeof payload.unit_id !== "string") {
    throw new Error("不支持的导入事件类型或缺少 unit_id");
  }

  try {
    await trace(payload.task_id, event.trace_id, "ImportQueueConsumed", "processing", `${payload.unit_id} 已由 QStash 投递给 Worker`, payload.unit_id, { qstash_message_id: delivery?.messageId || null, delivery_attempt: delivery?.deliveryAttempt || 0, event_type: event.event_type });
    const result = await processImportBatch(payload.task_id, payload.unit_id, delivery);
    await finalizeTask(payload.task_id);
    return result;
  } finally {
    taskContextCache.delete(payload.task_id);
  }
}

export async function finalizeTask(taskId: string) {
  await sql`
    with totals as (
      select task_id, count(*) filter (where status = 'completed')::int completed_batches,
        coalesce(sum(processed_rows), 0)::int processed_rows,
        coalesce(sum(success_rows), 0)::int success_rows,
        coalesce(sum(failed_rows), 0)::int failed_rows
      from import_task_batches where task_id = ${taskId} group by task_id
    ), finished as (
      update import_tasks t
      set processed_rows = totals.processed_rows,
        success_rows = totals.success_rows,
        failed_rows = totals.failed_rows,
        completed_batches = totals.completed_batches,
        status = case
          when totals.success_rows = 0 and totals.failed_rows > 0 then 'failed'
          when totals.failed_rows > 0 then 'partial_success'
          else 'completed'
        end,
        completed_at = now()
      from totals
      where t.id = totals.task_id and totals.completed_batches = t.total_batches and t.status = 'processing'
      returning t.id, t.trace_id, t.status, t.success_rows, t.failed_rows
    )
    insert into trace_events (id, trace_id, task_id, event_name, event_status, message)
    select gen_random_uuid(), trace_id, id,
      case when status = 'partial_success' then 'ImportTaskPartialSuccess' when status = 'failed' then 'ImportTaskFailed' else 'ImportTaskCompleted' end,
      case when status = 'failed' then 'failed' else 'success' end,
      '任务结束：成功 ' || success_rows || ' 行，失败 ' || failed_rows || ' 行'
    from finished
  `;
}

export async function recoverStalledParses() {
  const stalled = await sql`
    with recovered as (
      update import_tasks
      set processing_stage = 'parse_failed', status = 'pending',
        parse_last_error = '文件解析 Worker 租约过期，恢复控制面将重新投递',
        parse_claim_token = null, parse_lease_expires_at = null
      where processing_stage = 'parsing'
        and parse_lease_expires_at is not null
        and parse_lease_expires_at < now()
      returning id, trace_id
    ), outbox_reset as (
      update event_outbox o
      set status = 'failed', next_retry_at = now(),
        last_error = '文件解析 Worker 租约过期，恢复控制面重新投递',
        claimed_at = null, claim_token = null, lease_expires_at = null
      from recovered r
      where o.aggregate_id = r.id and o.event_type = 'ImportFileUploaded'
      returning o.aggregate_id
    )
    insert into trace_events (id, trace_id, task_id, event_name, event_status, message)
    select gen_random_uuid(), r.trace_id, r.id, 'ImportFileParseRecovered', 'warning',
      '文件解析 Worker 租约过期，任务已恢复为可重试状态'
    from recovered r
    returning task_id
  ` as unknown as Array<{ task_id: string }>;
  return stalled;
}

export async function recoverStalledBatches() {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  const stalled = await db.update(importTaskBatches)
    .set({ status: "failed", lastError: "Worker 超时，等待 QStash 重新投递" })
    .where(and(eq(importTaskBatches.status, "processing"), lte(importTaskBatches.lockedAt, cutoff)))
    .returning({ taskId: importTaskBatches.taskId, unitId: importTaskBatches.unitId });
  if (stalled.length) {
    await sql`
      update event_outbox o
      set status = 'failed', next_retry_at = now(), last_error = 'Worker 超时，恢复控制面重新投递',
        claimed_at = null, claim_token = null, lease_expires_at = null
      from import_task_batches b
      where b.task_id = o.aggregate_id
        and b.status = 'failed'
        and o.event_type = 'ImportBatchCreated'
        and o.payload->'payload'->>'unit_id' = b.unit_id
        and o.aggregate_id = any(${stalled.map((item) => item.taskId)}::uuid[])
    `;
  }
  return stalled;
}

export async function runImportRecovery() {
  const [stalledParses, stalledBatches] = await Promise.all([
    recoverStalledParses(),
    recoverStalledBatches(),
  ]);
  const dispatched = await dispatchOutbox();
  return { recovered_parses: stalledParses.length, recovered_batches: stalledBatches.length, dispatched_events: dispatched };
}

export async function cleanupExpiredImportBlobs(limit = 25) {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const tasks = await sql`
    select t.id, t.source_blob_pathname, t.edit_manifest_blob_pathname,
      coalesce(array_agg(b.payload_blob_pathname) filter (where b.payload_blob_pathname is not null), '{}') batch_paths
    from import_tasks t
    left join import_task_batches b on b.task_id = t.id
    where t.blob_retain_until is not null
      and t.blob_retain_until <= now()
      and t.blob_deleted_at is null
      and t.status in ('completed', 'partial_success', 'failed')
    group by t.id, t.source_blob_pathname, t.edit_manifest_blob_pathname, t.blob_retain_until
    order by t.blob_retain_until asc
    limit ${safeLimit}
  ` as unknown as Array<{
    id: string;
    source_blob_pathname: string | null;
    edit_manifest_blob_pathname: string | null;
    batch_paths: string[];
  }>;

  const results: Array<{ task_id: string; deleted_blobs: number; error?: string }> = [];
  for (const task of tasks) {
    try {
      const deleted = await deleteImportBlobs([
        task.source_blob_pathname,
        task.edit_manifest_blob_pathname,
        ...task.batch_paths,
      ]);
      await sql.transaction([
        sql`update import_tasks set blob_deleted_at = now() where id = ${task.id} and blob_deleted_at is null`,
        sql`insert into trace_events (id, trace_id, task_id, event_name, event_status, message, metadata)
          select gen_random_uuid(), trace_id, id, 'ImportBlobsDeleted', 'success', '已按保留策略清理导入 Blob',
            ${JSON.stringify({ deleted_blobs: deleted })}::jsonb from import_tasks where id = ${task.id}`,
      ]);
      results.push({ task_id: task.id, deleted_blobs: deleted });
    } catch (error) {
      results.push({
        task_id: task.id,
        deleted_blobs: 0,
        error: error instanceof Error ? error.message : "Blob 清理失败",
      });
    }
  }
  return {
    scanned_tasks: tasks.length,
    cleaned_tasks: results.filter((item) => !item.error).length,
    failed_tasks: results.filter((item) => item.error).length,
    deleted_blobs: results.reduce((sum, item) => sum + item.deleted_blobs, 0),
    results,
  };
}

export async function processQueuedBatches() {
  // 向后兼容旧调用名，但恢复控制面绝不直接执行批次，所有正式消费统一经过 QStash。
  const result = await runImportRecovery();
  return [{ control_plane: true, ...result }];
}

export async function recordQStashFailure(input: {
  sourceMessageId: string;
  status?: number;
  retried?: number;
  maxRetries?: number;
  responseBody?: string;
  sourceBody?: string;
}) {
  let event: ImportEventEnvelope | null = null;
  if (input.sourceBody) {
    try {
      event = JSON.parse(Buffer.from(input.sourceBody, "base64").toString("utf8")) as ImportEventEnvelope;
    } catch {
      event = null;
    }
  }
  const records = await sql`
    update event_outbox
    set status = 'dead-lettered', dead_lettered_at = now(), last_error = ${`QStash 最终投递失败（HTTP ${input.status || 0}）`},
      last_provider_response = ${JSON.stringify({
        source_message_id: input.sourceMessageId,
        status: input.status,
        retried: input.retried,
        max_retries: input.maxRetries,
        response_body: input.responseBody,
      })}::jsonb
    where provider_message_id = ${input.sourceMessageId}
      or (${event?.event_id || null}::uuid is not null and id = ${event?.event_id || null}::uuid)
    returning aggregate_id, event_type, payload
  ` as unknown as Array<{ aggregate_id: string; event_type: string; payload: ImportEventEnvelope }>;
  const record = records[0];
  if (!record) return { matched: false };

  const payload = record.payload.payload as { unit_id?: string };
  if (record.event_type === "ImportBatchCreated" && payload.unit_id) {
    await sql.transaction([
      sql`update import_task_batches set status = 'failed', dead_lettered_at = now(),
          last_error = ${`QStash 重试耗尽：${input.sourceMessageId}`}
        where task_id = ${record.aggregate_id} and unit_id = ${payload.unit_id}`,
      sql`update import_tasks set status = 'failed', processing_stage = 'dead_lettered',
          completed_at = now(), parse_last_error = ${`批次 ${payload.unit_id} QStash 重试耗尽：${input.sourceMessageId}`}
        where id = ${record.aggregate_id} and status not in ('completed', 'partial_success', 'failed')`,
      sql`insert into trace_events (id, trace_id, task_id, unit_id, event_name, event_status, message)
        select gen_random_uuid(), trace_id, id, ${payload.unit_id}, 'ImportTaskFailed', 'failed',
          ${`任务因批次 ${payload.unit_id} 进入 DLQ，已标记失败`} from import_tasks where id = ${record.aggregate_id}`,
    ]);
  } else if (record.event_type === "ImportFileUploaded") {
    await db.update(importTasks).set({
      status: "failed",
      processingStage: "dead_lettered",
      parseLastError: `QStash 重试耗尽：${input.sourceMessageId}`,
      completedAt: new Date(),
    }).where(eq(importTasks.id, record.aggregate_id));
  }
  await trace(record.aggregate_id, record.payload.trace_id, "QStashDeadLettered", "failed", "QStash 重试耗尽，消息已进入 DLQ", payload.unit_id, {
    source_message_id: input.sourceMessageId,
    status: input.status,
    retried: input.retried,
    max_retries: input.maxRetries,
  });
  return { matched: true, task_id: record.aggregate_id, event_type: record.event_type };
}

export async function getImportTask(taskId: string): Promise<ImportTaskSummary | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) return null;
  const rows = await sql`
    select t.id task_id, t.trace_id, t.file_name, t.status, t.total_rows, t.total_batches,
      coalesce(p.processed_rows, 0)::int processed_rows,
      coalesce(p.success_rows, 0)::int success_rows,
      coalesce(p.failed_rows, 0)::int failed_rows,
      coalesce(p.completed_batches, 0)::int completed_batches,
      t.degraded, t.degraded_reason, t.created_at, t.started_at, t.completed_at,
      coalesce(e.recent_errors, '[]'::jsonb) recent_errors
    from import_tasks t
    left join lateral (
      select sum(processed_rows)::int processed_rows, sum(success_rows)::int success_rows,
        sum(failed_rows)::int failed_rows,
        count(*) filter (where status = 'completed')::int completed_batches
      from import_task_batches where task_id = t.id
    ) p on true
    left join lateral (
      select jsonb_agg(jsonb_build_object('error_code', error_code, 'error_reason', error_reason, 'count', error_count) order by error_count desc) recent_errors
      from (
        select error_code, error_reason, count(*)::int error_count
        from import_task_errors where task_id = t.id
        group by error_code, error_reason order by count(*) desc limit 5
      ) grouped_errors
    ) e on true
    where t.id = ${taskId}
    limit 1
  ` as unknown as Array<{
    task_id: string; trace_id: string; file_name: string; status: ImportTaskSummary["status"];
    total_rows: number; processed_rows: number; success_rows: number; failed_rows: number;
    total_batches: number; completed_batches: number; degraded: boolean; degraded_reason: string | null;
    created_at: Date | string; started_at: Date | string | null; completed_at: Date | string | null;
    recent_errors: ImportTaskSummary["recent_errors"];
  }>;
  const task = rows[0];
  if (!task) return null;
  const completedAtMs = task.completed_at ? new Date(task.completed_at).getTime() : Date.now();
  const startedAtMs = new Date(task.started_at || task.created_at).getTime();
  const elapsedSeconds = Math.max(1, (completedAtMs - startedAtMs) / 1000);
  const throughput = Math.round((task.processed_rows / elapsedSeconds) * 60);
  const etaSeconds = task.processed_rows > 0 && task.processed_rows < task.total_rows ? Math.ceil((task.total_rows - task.processed_rows) / (task.processed_rows / elapsedSeconds)) : null;
  return { ...task, throughput, eta_seconds: etaSeconds };
}
