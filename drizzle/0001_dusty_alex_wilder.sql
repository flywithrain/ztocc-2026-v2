ALTER TABLE "import_tasks" ALTER COLUMN "file_payload" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "provider" varchar(32) DEFAULT 'qstash' NOT NULL;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "provider_message_id" varchar(255);--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "claimed_at" timestamp;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "lease_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "last_provider_response" jsonb;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "dead_lettered_at" timestamp;--> statement-breakpoint
ALTER TABLE "import_task_batches" ADD COLUMN "payload_blob_url" text;--> statement-breakpoint
ALTER TABLE "import_task_batches" ADD COLUMN "payload_blob_pathname" text;--> statement-breakpoint
ALTER TABLE "import_task_batches" ADD COLUMN "qstash_message_id" varchar(255);--> statement-breakpoint
ALTER TABLE "import_task_batches" ADD COLUMN "delivery_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_task_batches" ADD COLUMN "queued_at" timestamp;--> statement-breakpoint
ALTER TABLE "import_task_batches" ADD COLUMN "last_delivery_at" timestamp;--> statement-breakpoint
ALTER TABLE "import_task_batches" ADD COLUMN "dead_lettered_at" timestamp;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD COLUMN "source_blob_url" text;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD COLUMN "source_blob_pathname" text;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD COLUMN "edit_manifest_blob_url" text;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD COLUMN "edit_manifest_blob_pathname" text;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD COLUMN "file_mime" varchar(255);--> statement-breakpoint
ALTER TABLE "import_tasks" ADD COLUMN "file_size" integer;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD COLUMN "processing_stage" varchar(50) DEFAULT 'file_uploaded' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD COLUMN "parse_retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD COLUMN "parse_last_error" text;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD COLUMN "blob_retain_until" timestamp;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD COLUMN "blob_deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD COLUMN "parsed_at" timestamp;