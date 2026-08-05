import { desc, gte, inArray, sql as dsql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { batchPerformanceLog, eventOutbox, importTaskBatches, importTaskErrors, importTasks } from "@/lib/db-schema";

export async function GET() {
  const since = new Date(Date.now() - 5 * 60 * 1000);
  const [throughput, [queue], [outbox], latency, errors, slowBatches, recentTasks] = await Promise.all([
    db.select({ minute: dsql<string>`to_char(date_trunc('minute', ${importTasks.completedAt}), 'HH24:MI')`, rows: dsql<number>`coalesce(sum(${importTasks.successRows}), 0)::int` }).from(importTasks).where(gte(importTasks.completedAt, since)).groupBy(dsql`date_trunc('minute', ${importTasks.completedAt})`).orderBy(dsql`date_trunc('minute', ${importTasks.completedAt})`),
    db.select({
      batches: dsql<number>`count(*)::int`,
      rows: dsql<number>`coalesce(sum(${importTaskBatches.endRow} - ${importTaskBatches.startRow}), 0)::int`,
      active_workers: dsql<number>`count(*) filter (where ${importTaskBatches.status} = 'processing')::int`,
      max_queue_wait_ms: dsql<number>`coalesce(max(extract(epoch from (now() - ${importTaskBatches.createdAt})) * 1000) filter (where ${importTaskBatches.status} in ('pending', 'failed')), 0)::int`,
    }).from(importTaskBatches).where(inArray(importTaskBatches.status, ["pending", "processing", "failed"])),
    db.select({
      pending: dsql<number>`count(*) filter (where ${eventOutbox.status} in ('pending', 'publishing'))::int`,
      failed: dsql<number>`count(*) filter (where ${eventOutbox.status} = 'failed')::int`,
      dead_lettered: dsql<number>`count(*) filter (where ${eventOutbox.status} = 'dead-lettered')::int`,
      published_last_5m: dsql<number>`count(*) filter (where ${eventOutbox.sentAt} >= ${since})::int`,
    }).from(eventOutbox),
    db.select({ stage: dsql<string>`stage`, p50: dsql<number>`percentile_cont(0.5) within group (order by duration)::int`, p95: dsql<number>`percentile_cont(0.95) within group (order by duration)::int`, p99: dsql<number>`percentile_cont(0.99) within group (order by duration)::int` }).from(dsql`(select unnest(array['parse','rule','validate','insert']) as stage, unnest(array[parse_duration_ms, rule_duration_ms, validate_duration_ms, insert_duration_ms]) as duration from batch_performance_log where created_at >= ${since}) metrics`).groupBy(dsql`stage`),
    db.select({ code: importTaskErrors.errorCode, count: dsql<number>`count(*)::int` }).from(importTaskErrors).where(gte(importTaskErrors.createdAt, since)).groupBy(importTaskErrors.errorCode).orderBy(desc(dsql`count(*)`)),
    db.select({ task_id: batchPerformanceLog.taskId, unit_id: batchPerformanceLog.unitId, duration_ms: batchPerformanceLog.totalDurationMs }).from(batchPerformanceLog).orderBy(desc(batchPerformanceLog.totalDurationMs)).limit(10),
    db.select({ id: importTasks.id, file_name: importTasks.fileName, status: importTasks.status, processing_stage: importTasks.processingStage, total_rows: importTasks.totalRows, success_rows: importTasks.successRows, failed_rows: importTasks.failedRows, created_at: importTasks.createdAt }).from(importTasks).orderBy(desc(importTasks.createdAt)).limit(8),
  ]);

  const qstashConfigured = Boolean(process.env.QSTASH_TOKEN && process.env.QSTASH_CURRENT_SIGNING_KEY && process.env.QSTASH_NEXT_SIGNING_KEY && process.env.APP_BASE_URL);
  const queueStatus = !qstashConfigured || outbox.dead_lettered > 0 || outbox.failed > 0
    ? "critical"
    : queue.rows > 5000 || outbox.pending > 100
      ? "warning"
      : "healthy";
  return NextResponse.json({
    generated_at: new Date().toISOString(),
    throughput,
    queue_depth: queue,
    queue_status: queueStatus,
    qstash: { configured: qstashConfigured, ...outbox },
    stage_latency: latency,
    errors,
    slow_batches: slowBatches,
    recent_tasks: recentTasks,
  });
}
