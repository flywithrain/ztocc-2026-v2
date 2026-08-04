import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { and, asc, eq, inArray, lte, ne } from "drizzle-orm";
import { db, sql } from "@/lib/db";
import {
  eventOutbox,
  importTaskBatches,
  importTasks,
  orders,
  shipments,
  skuMaster,
  traceEvents,
} from "@/lib/db-schema";
import { checkReceiverConsistency, validateOrders } from "@/lib/validators";
import type { OrderRow, ValidationError } from "@/types";
import type { ImportEventEnvelope, ImportTaskPayload, ImportTaskSummary } from "@/lib/import-types";

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
  payload: ImportTaskPayload;
};

const taskContextCache = new Map<string, Promise<WorkerTaskContext>>();

function loadWorkerTaskContext(taskId: string) {
  const cached = taskContextCache.get(taskId);
  if (cached) return cached;
  const pending = db.select({ id: importTasks.id, traceId: importTasks.traceId, startedAt: importTasks.startedAt, filePayload: importTasks.filePayload })
    .from(importTasks)
    .where(eq(importTasks.id, taskId))
    .limit(1)
    .then(([task]) => {
      if (!task) throw new Error("导入任务不存在");
      return { id: task.id, traceId: task.traceId, startedAt: task.startedAt, payload: decodePayload(task.filePayload) };
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
  const endpoint = process.env.IMPORT_QUEUE_WEBHOOK_URL;
  if (!endpoint) {
    const events = await sql`
      with claimable as (
        select id
        from event_outbox
        where status in ('pending', 'failed')
          and next_retry_at <= now()
          and (${taskId || null}::uuid is null or aggregate_id = ${taskId || null}::uuid)
        order by created_at
        limit 100
        for update skip locked
      )
      update event_outbox e
      set status = 'sent', sent_at = now(), last_error = null
      from claimable c
      where e.id = c.id
      returning e.id, e.aggregate_id, e.payload
    ` as unknown as { id: string; aggregate_id: string; payload: ImportEventEnvelope }[];
    if (events.length) {
      const first = events[0];
      await trace(first.aggregate_id, String(first.payload.trace_id), "OutboxDispatched", "success", `${events.length} 个事件已进入 PostgreSQL 可靠任务队列`, undefined, {
        event_count: events.length,
        event_ids: events.map((event) => event.id),
      });
    }
    return events.length;
  }

  const conditions = [inArray(eventOutbox.status, ["pending", "failed"]), lte(eventOutbox.nextRetryAt, new Date())];
  if (taskId) conditions.push(eq(eventOutbox.aggregateId, taskId));
  const events = await db.select().from(eventOutbox).where(and(...conditions)).orderBy(asc(eventOutbox.createdAt)).limit(100);

  for (const event of events) {
    try {
      const response = await fetch(endpoint!, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.IMPORT_QUEUE_WEBHOOK_TOKEN || ""}` },
        body: JSON.stringify(event.payload),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Queue webhook ${response.status}`);
      await db.update(eventOutbox).set({ status: "sent", sentAt: new Date(), lastError: null }).where(eq(eventOutbox.id, event.id));
      await trace(event.aggregateId, String((event.payload as ImportEventEnvelope).trace_id), "OutboxDispatched", "success", "事件已投递到外部队列", undefined, { event_id: event.id });
    } catch (error) {
      const retry = event.retryCount + 1;
      await db.update(eventOutbox).set({ status: "failed", retryCount: retry, lastError: error instanceof Error ? error.message : String(error), nextRetryAt: new Date(Date.now() + Math.min(60000, 1000 * 2 ** retry)) }).where(eq(eventOutbox.id, event.id));
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

export async function processImportBatch(taskId: string, unitId: string) {
  const batchStartedAt = new Date();
  const claimed = await sql`
    with claimed as (
      update import_task_batches
      set status = 'processing', locked_at = now(), retry_count = retry_count + 1, version = version + 1
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
  const rows = task.payload.rows.slice(batch.start_row, batch.end_row);

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
        row_number: error.rowIndex + 1,
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
      sql`insert into batch_performance_log (id, task_id, unit_id, batch_index, parse_duration_ms, rule_duration_ms, validate_duration_ms, insert_duration_ms, total_duration_ms, status, trace_id)
          values (gen_random_uuid(), ${taskId}, ${unitId}, ${batch.batch_index}, 0, 0, ${validateDurationMs},
            greatest(0, extract(epoch from (clock_timestamp() - ${batchStartedAt}::timestamptz)) * 1000 - ${validateDurationMs})::int,
            (extract(epoch from (clock_timestamp() - ${batchStartedAt}::timestamptz)) * 1000)::int, 'completed', ${task.traceId})
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

async function finalizeTask(taskId: string) {
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
      case when status = 'partial_success' then 'ImportTaskPartialSuccess' else 'ImportTaskCompleted' end,
      case when status = 'failed' then 'failed' else 'success' end,
      '任务结束：成功 ' || success_rows || ' 行，失败 ' || failed_rows || ' 行'
    from finished
  `;
}

export async function recoverStalledBatches() {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  return db.update(importTaskBatches).set({ status: "failed", lastError: "Worker 超时，等待重试" }).where(and(eq(importTaskBatches.status, "processing"), lte(importTaskBatches.lockedAt, cutoff))).returning({ id: importTaskBatches.id });
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
