ALTER TABLE "import_tasks" ADD COLUMN "parse_claim_token" uuid;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD COLUMN "parse_lease_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD COLUMN "parse_duration_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD COLUMN "rule_duration_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "import_tasks_parse_lease_idx" ON "import_tasks" USING btree ("processing_stage","parse_lease_expires_at");