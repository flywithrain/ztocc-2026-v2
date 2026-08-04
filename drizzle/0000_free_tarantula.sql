CREATE TABLE "batch_performance_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"unit_id" varchar(100) NOT NULL,
	"batch_index" integer NOT NULL,
	"parse_duration_ms" integer DEFAULT 0 NOT NULL,
	"rule_duration_ms" integer DEFAULT 0 NOT NULL,
	"validate_duration_ms" integer DEFAULT 0 NOT NULL,
	"insert_duration_ms" integer DEFAULT 0 NOT NULL,
	"total_duration_ms" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) NOT NULL,
	"trace_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"sent_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "import_task_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"unit_id" varchar(100) NOT NULL,
	"batch_index" integer NOT NULL,
	"start_row" integer NOT NULL,
	"end_row" integer NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"success_rows" integer DEFAULT 0 NOT NULL,
	"failed_rows" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"locked_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_task_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"unit_id" varchar(100) NOT NULL,
	"batch_index" integer NOT NULL,
	"row_number" integer NOT NULL,
	"field_name" varchar(100) NOT NULL,
	"raw_value" text,
	"error_code" varchar(16) NOT NULL,
	"error_reason" text NOT NULL,
	"suggestion" text,
	"trace_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_name" varchar(500) NOT NULL,
	"file_hash" varchar(64) NOT NULL,
	"parse_rule_id" uuid NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"total_rows" integer NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"success_rows" integer DEFAULT 0 NOT NULL,
	"failed_rows" integer DEFAULT 0 NOT NULL,
	"total_batches" integer NOT NULL,
	"completed_batches" integer DEFAULT 0 NOT NULL,
	"trace_id" uuid NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"degraded_reason" text,
	"file_payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"sku_code" varchar(255) NOT NULL,
	"sku_name" varchar(500) NOT NULL,
	"sku_quantity" numeric NOT NULL,
	"sku_spec" varchar(500),
	"remark" text
);
--> statement-breakpoint
CREATE TABLE "parse_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"config" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_code" varchar(255),
	"store_name" varchar(255),
	"receiver_name" varchar(255),
	"receiver_phone" varchar(50),
	"receiver_address" text,
	"remark" text,
	"sku_count" integer DEFAULT 0 NOT NULL,
	"total_quantity" numeric DEFAULT '0' NOT NULL,
	"batch_id" uuid NOT NULL,
	"submitted_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sku_master" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku_code" varchar(255) NOT NULL,
	"name" varchar(500) NOT NULL,
	"spec" varchar(500),
	"unit" varchar(50) DEFAULT '件' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trace_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"unit_id" varchar(100),
	"event_name" varchar(100) NOT NULL,
	"event_status" varchar(32) NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "batch_performance_log" ADD CONSTRAINT "batch_performance_log_task_id_import_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."import_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_task_batches" ADD CONSTRAINT "import_task_batches_task_id_import_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."import_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_task_errors" ADD CONSTRAINT "import_task_errors_task_id_import_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."import_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD CONSTRAINT "import_tasks_parse_rule_id_parse_rules_id_fk" FOREIGN KEY ("parse_rule_id") REFERENCES "public"."parse_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_events" ADD CONSTRAINT "trace_events_task_id_import_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."import_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "batch_performance_task_unit_uidx" ON "batch_performance_log" USING btree ("task_id","unit_id");--> statement-breakpoint
CREATE INDEX "batch_performance_created_idx" ON "batch_performance_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "event_outbox_status_retry_idx" ON "event_outbox" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_task_batches_task_unit_uidx" ON "import_task_batches" USING btree ("task_id","unit_id");--> statement-breakpoint
CREATE INDEX "import_task_batches_task_status_idx" ON "import_task_batches" USING btree ("task_id","status");--> statement-breakpoint
CREATE INDEX "import_task_errors_task_unit_idx" ON "import_task_errors" USING btree ("task_id","unit_id");--> statement-breakpoint
CREATE INDEX "import_task_errors_code_idx" ON "import_task_errors" USING btree ("error_code");--> statement-breakpoint
CREATE INDEX "import_tasks_status_created_idx" ON "import_tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "import_tasks_trace_idx" ON "import_tasks" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "import_tasks_file_hash_idx" ON "import_tasks" USING btree ("file_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "sku_master_sku_code_uidx" ON "sku_master" USING btree ("sku_code");--> statement-breakpoint
CREATE INDEX "trace_events_trace_time_idx" ON "trace_events" USING btree ("trace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "trace_events_task_idx" ON "trace_events" USING btree ("task_id");