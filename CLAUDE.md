# CLAUDE.md

This file provides repository-specific guidance for AI coding and static review.

@AGENTS.md

> This project uses Next.js 16.2.6. Read the matching framework documentation before changing App Router or Route Handler code.

## Project scope

“万能导入 V2” is a Next.js App Router + TypeScript import system. The production order-import path has been refactored to an asynchronous event-driven architecture for Vercel:

```text
Browser → Vercel Private Blob Client Upload
        → POST /api/import-tasks (Blob references only; full rows are rejected)
        → Neon PostgreSQL import_tasks + Transactional Outbox
        → Upstash QStash Direct Publish
        → /api/internal/import-events Worker
        → reuse V2 parse-engine.ts
        → Private Blob batch payloads
        → batch SKU validation + bulk database writes
        → task/error/performance/trace aggregation
```

The browser still performs V2 preview parsing and editing for user confirmation. That preview is not the production persistence path. Final submission creates an asynchronous task and redirects to `/import-tasks/:taskId`.

## Commands

```bash
npm ci
npm run dev
npm run test:async-import
npm run test:async-import:integration  # requires RUN_NEON_INTEGRATION_TEST=true
npm run lint
npm run typecheck
npm run db:check
npm run db:generate
npm run db:migrate
npm run build
npm run db:seed
npm run db:seed-load
npm run load:test
```

Do not add database migration or seed commands to the Vercel Build Command.

## Production modules

- File upload: `src/app/api/import-files/upload/route.ts`, `src/lib/blob-storage.ts`
- Task creation: `src/app/api/import-tasks/route.ts`, `createBlobImportTask()`
- Transactional Outbox / recovery: `dispatchOutbox()`, `runImportRecovery()`
- QStash publisher and receiver: `src/lib/qstash-publisher.ts`, `src/lib/qstash-receiver.ts`
- Worker consumer: `src/app/api/internal/import-events/route.ts`, `processImportEvent()`
- V2 parse rule engine: `src/lib/parse-engine.ts`
- Batch validation and bulk writes: `processImportBatch()`
- Task UI: `/import-tasks/:taskId`
- Monitoring: `/import-monitor`, `/api/import-monitor/summary`
- Trace search: `/traces`, `/traces/:traceId`, `/api/traces/*`
- Cleanup: `/api/internal/import-cleanup`

`createImportTask()` and `processPendingBatches()` are deprecated compatibility/integration-test helpers. They may carry a compressed `rows` payload for old tests. They are not reachable from the production task API; `parseBlobImportTaskRequest()` explicitly rejects `rows`.

## Database

Schema is in `src/lib/db-schema.ts`, managed with Drizzle ORM over Neon PostgreSQL. Core tables include:

- `parse_rules`
- `shipments`, `orders`
- `sku_master`
- `import_tasks`, `import_task_batches`, `import_task_errors`
- `event_outbox`
- `batch_performance_log`
- `trace_events`

Do not describe this repository as a two-table synchronous application.

## Reliability requirements

When changing the import path, preserve these invariants:

- Task + Outbox are created atomically.
- Outbox publishing leases and file-parse leases are recoverable.
- QStash retries and failure callback remain enabled and signed.
- A completed batch cannot be claimed again.
- A DLQ batch must put its task into a terminal failed state.
- SKU validation and persistence remain batch operations; no per-row database query or insert loop.
- `trace_id` must remain available across API, Outbox, QStash, Worker, errors and performance logs.
- `OrderRow.sourceRowNumber` is the original 1-based physical file row; `rowIndex` is the stable normalized sequence used for idempotency.
- Phone/address values must be masked before storing them in `import_task_errors`.

## Environment

Use `.env.example` as the variable contract. Production requires at least:

- `DATABASE_URL`
- `APP_BASE_URL`
- `BLOB_READ_WRITE_TOKEN`
- `QSTASH_TOKEN`
- `QSTASH_CURRENT_SIGNING_KEY`
- `QSTASH_NEXT_SIGNING_KEY`

Never commit `.env.local` or real credentials.

## Submission evidence

- All exam delivery docs (architecture, refactoring assumptions, API, README, deployment, load-test report, acceptance report, reflection) are consolidated in `docs/PROJECT_DELIVERY.md`.

Load-test evidence is the 2026-08-07 real online run in `docs/PROJECT_DELIVERY.md` §8 (10,000 rows in 30.046s).

Do not present the historical Neon database-core baseline as proof of the final Vercel + Blob + QStash end-to-end result. Formal acceptance still uses the deployed URL and the post-deploy load-test workflow.
