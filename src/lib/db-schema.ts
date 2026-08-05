import {
  pgTable,
  uuid,
  varchar,
  text,
  numeric,
  integer,
  timestamp,
  jsonb,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const parseRules = pgTable("parse_rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  config: jsonb("config").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// 出库单主表：按外部编码聚合，存收货信息与冗余汇总
export const shipments = pgTable("shipments", {
  id: uuid("id").defaultRandom().primaryKey(),
  externalCode: varchar("external_code", { length: 255 }),       // 可空（无外编码时每行独立成单）
  storeName: varchar("store_name", { length: 255 }),
  receiverName: varchar("receiver_name", { length: 255 }),
  receiverPhone: varchar("receiver_phone", { length: 50 }),
  receiverAddress: text("receiver_address"),
  remark: text("remark"),
  skuCount: integer("sku_count").notNull().default(0),           // 明细行数（冗余，列表展示用）
  totalQuantity: numeric("total_quantity").notNull().default("0"), // 总数量（冗余）
  batchId: uuid("batch_id").notNull(),
  submittedAt: timestamp("submitted_at").defaultNow(),
});

// SKU 明细子表：关联到 shipments
export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  shipmentId: uuid("shipment_id").notNull().references(() => shipments.id, { onDelete: "cascade" }),
  skuCode: varchar("sku_code", { length: 255 }).notNull(),
  skuName: varchar("sku_name", { length: 500 }).notNull(),
  skuQuantity: numeric("sku_quantity").notNull(),
  skuSpec: varchar("sku_spec", { length: 500 }),
  remark: text("remark"),
});

export const skuMaster = pgTable("sku_master", {
  id: uuid("id").defaultRandom().primaryKey(),
  skuCode: varchar("sku_code", { length: 255 }).notNull(),
  name: varchar("name", { length: 500 }).notNull(),
  spec: varchar("spec", { length: 500 }),
  unit: varchar("unit", { length: 50 }).notNull().default("件"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [uniqueIndex("sku_master_sku_code_uidx").on(table.skuCode)]);

export const importTasks = pgTable("import_tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  fileName: varchar("file_name", { length: 500 }).notNull(),
  fileHash: varchar("file_hash", { length: 64 }).notNull(),
  parseRuleId: uuid("parse_rule_id").notNull().references(() => parseRules.id),
  status: varchar("status", { length: 32 }).notNull().default("pending"),
  totalRows: integer("total_rows").notNull(),
  processedRows: integer("processed_rows").notNull().default(0),
  successRows: integer("success_rows").notNull().default(0),
  failedRows: integer("failed_rows").notNull().default(0),
  totalBatches: integer("total_batches").notNull(),
  completedBatches: integer("completed_batches").notNull().default(0),
  traceId: uuid("trace_id").notNull(),
  degraded: boolean("degraded").notNull().default(false),
  degradedReason: text("degraded_reason"),
  // 兼容旧版 gzip rows 载荷；新任务只保存 Blob 引用，避免把 10,000 行 JSON 放入请求/数据库热路径。
  filePayload: jsonb("file_payload"),
  sourceBlobUrl: text("source_blob_url"),
  sourceBlobPathname: text("source_blob_pathname"),
  editManifestBlobUrl: text("edit_manifest_blob_url"),
  editManifestBlobPathname: text("edit_manifest_blob_pathname"),
  fileMime: varchar("file_mime", { length: 255 }),
  fileSize: integer("file_size"),
  processingStage: varchar("processing_stage", { length: 50 }).notNull().default("file_uploaded"),
  parseRetryCount: integer("parse_retry_count").notNull().default(0),
  parseLastError: text("parse_last_error"),
  blobRetainUntil: timestamp("blob_retain_until"),
  blobDeletedAt: timestamp("blob_deleted_at"),
  parsedAt: timestamp("parsed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
}, (table) => [
  index("import_tasks_status_created_idx").on(table.status, table.createdAt),
  index("import_tasks_trace_idx").on(table.traceId),
  index("import_tasks_file_hash_idx").on(table.fileHash),
]);

export const importTaskBatches = pgTable("import_task_batches", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: uuid("task_id").notNull().references(() => importTasks.id, { onDelete: "cascade" }),
  unitId: varchar("unit_id", { length: 100 }).notNull(),
  batchIndex: integer("batch_index").notNull(),
  startRow: integer("start_row").notNull(),
  endRow: integer("end_row").notNull(),
  status: varchar("status", { length: 32 }).notNull().default("pending"),
  retryCount: integer("retry_count").notNull().default(0),
  processedRows: integer("processed_rows").notNull().default(0),
  successRows: integer("success_rows").notNull().default(0),
  failedRows: integer("failed_rows").notNull().default(0),
  version: integer("version").notNull().default(0),
  lastError: text("last_error"),
  payloadBlobUrl: text("payload_blob_url"),
  payloadBlobPathname: text("payload_blob_pathname"),
  qstashMessageId: varchar("qstash_message_id", { length: 255 }),
  deliveryAttempt: integer("delivery_attempt").notNull().default(0),
  queuedAt: timestamp("queued_at"),
  lastDeliveryAt: timestamp("last_delivery_at"),
  deadLetteredAt: timestamp("dead_lettered_at"),
  lockedAt: timestamp("locked_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("import_task_batches_task_unit_uidx").on(table.taskId, table.unitId),
  index("import_task_batches_task_status_idx").on(table.taskId, table.status),
]);

export const importTaskErrors = pgTable("import_task_errors", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: uuid("task_id").notNull().references(() => importTasks.id, { onDelete: "cascade" }),
  unitId: varchar("unit_id", { length: 100 }).notNull(),
  batchIndex: integer("batch_index").notNull(),
  rowNumber: integer("row_number").notNull(),
  fieldName: varchar("field_name", { length: 100 }).notNull(),
  rawValue: text("raw_value"),
  errorCode: varchar("error_code", { length: 16 }).notNull(),
  errorReason: text("error_reason").notNull(),
  suggestion: text("suggestion"),
  traceId: uuid("trace_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("import_task_errors_task_unit_idx").on(table.taskId, table.unitId),
  index("import_task_errors_code_idx").on(table.errorCode),
]);

export const eventOutbox = pgTable("event_outbox", {
  id: uuid("id").defaultRandom().primaryKey(),
  aggregateId: uuid("aggregate_id").notNull(),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  payload: jsonb("payload").notNull(),
  status: varchar("status", { length: 32 }).notNull().default("pending"),
  retryCount: integer("retry_count").notNull().default(0),
  nextRetryAt: timestamp("next_retry_at").defaultNow().notNull(),
  lastError: text("last_error"),
  provider: varchar("provider", { length: 32 }).notNull().default("qstash"),
  providerMessageId: varchar("provider_message_id", { length: 255 }),
  claimedAt: timestamp("claimed_at"),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  lastProviderResponse: jsonb("last_provider_response"),
  deadLetteredAt: timestamp("dead_lettered_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  sentAt: timestamp("sent_at"),
}, (table) => [index("event_outbox_status_retry_idx").on(table.status, table.nextRetryAt)]);

export const batchPerformanceLog = pgTable("batch_performance_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: uuid("task_id").notNull().references(() => importTasks.id, { onDelete: "cascade" }),
  unitId: varchar("unit_id", { length: 100 }).notNull(),
  batchIndex: integer("batch_index").notNull(),
  parseDurationMs: integer("parse_duration_ms").notNull().default(0),
  ruleDurationMs: integer("rule_duration_ms").notNull().default(0),
  validateDurationMs: integer("validate_duration_ms").notNull().default(0),
  insertDurationMs: integer("insert_duration_ms").notNull().default(0),
  totalDurationMs: integer("total_duration_ms").notNull().default(0),
  status: varchar("status", { length: 32 }).notNull(),
  traceId: uuid("trace_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("batch_performance_task_unit_uidx").on(table.taskId, table.unitId),
  index("batch_performance_created_idx").on(table.createdAt),
]);

export const traceEvents = pgTable("trace_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  traceId: uuid("trace_id").notNull(),
  taskId: uuid("task_id").notNull().references(() => importTasks.id, { onDelete: "cascade" }),
  unitId: varchar("unit_id", { length: 100 }),
  eventName: varchar("event_name", { length: 100 }).notNull(),
  eventStatus: varchar("event_status", { length: 32 }).notNull(),
  message: text("message").notNull(),
  metadata: jsonb("metadata"),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
}, (table) => [
  index("trace_events_trace_time_idx").on(table.traceId, table.occurredAt),
  index("trace_events_task_idx").on(table.taskId),
]);
