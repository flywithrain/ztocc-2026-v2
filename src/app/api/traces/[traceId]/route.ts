import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await context.params;
  if (!UUID_RE.test(traceId)) return NextResponse.json({ error: "trace_id 格式无效" }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const batchNumber = Math.max(0, Number(searchParams.get("batch") || 0));
  const rowFrom = Math.max(0, Number(searchParams.get("row_from") || 0));
  const rowTo = Math.max(0, Number(searchParams.get("row_to") || 0));
  const errorCode = searchParams.get("error_code")?.trim().toUpperCase().slice(0, 16) || null;

  const tasks = await sql`
    select t.*, r.name as rule_name
    from import_tasks t
    left join parse_rules r on r.id = t.parse_rule_id
    where t.trace_id = ${traceId}
    limit 1
  `;
  if (!tasks.length) return NextResponse.json({ error: "Trace 不存在" }, { status: 404 });
  const task = tasks[0] as Record<string, unknown>;
  const taskId = String(task.id);

  const [events, outbox, batches, performance, errors, dbWrites] = await Promise.all([
    sql`select id, trace_id, task_id, unit_id, event_name, event_status, message, metadata, occurred_at
        from trace_events where trace_id = ${traceId} order by occurred_at asc`,
    sql`select id, event_type, status, provider, provider_message_id, retry_count, last_error,
          payload->'payload'->>'unit_id' as unit_id, created_at, claimed_at, sent_at, dead_lettered_at
        from event_outbox where aggregate_id = ${taskId}::uuid order by created_at asc`,
    sql`select id, unit_id, batch_index, start_row, end_row, status, retry_count, processed_rows, success_rows,
          failed_rows, qstash_message_id, delivery_attempt, queued_at, last_delivery_at, locked_at, completed_at, last_error
        from import_task_batches where task_id = ${taskId}::uuid order by batch_index asc`,
    sql`select unit_id, batch_index, parse_duration_ms, rule_duration_ms, validate_duration_ms, insert_duration_ms,
          total_duration_ms, status, created_at
        from batch_performance_log where task_id = ${taskId}::uuid order by batch_index asc`,
    sql`select id, unit_id, batch_index, row_number, field_name, raw_value, error_code, error_reason, suggestion, created_at
        from import_task_errors where task_id = ${taskId}::uuid
          and (${batchNumber || null}::int is null or batch_index = ${batchNumber ? batchNumber - 1 : null})
          and (${rowFrom || null}::int is null or row_number >= ${rowFrom || null})
          and (${rowTo || null}::int is null or row_number <= ${rowTo || null})
          and (${errorCode}::text is null or error_code = ${errorCode})
        order by row_number asc limit 200`,
    sql`select
          (select count(*)::int from shipments where batch_id = ${taskId}::uuid) as shipment_count,
          (select count(*)::int from orders o join shipments s on s.id = o.shipment_id where s.batch_id = ${taskId}::uuid) as order_count`,
  ]);

  return NextResponse.json({
    trace_id: traceId,
    task: {
      task_id: task.id,
      trace_id: task.trace_id,
      file_name: task.file_name,
      file_hash: task.file_hash,
      file_mime: task.file_mime,
      file_size: task.file_size,
      source_blob_pathname: task.source_blob_pathname,
      source_blob_saved: Boolean(task.source_blob_pathname || task.file_payload),
      parse_rule_id: task.parse_rule_id,
      rule_name: task.rule_name,
      status: task.status,
      processing_stage: task.processing_stage,
      total_rows: task.total_rows,
      processed_rows: task.processed_rows,
      success_rows: task.success_rows,
      failed_rows: task.failed_rows,
      total_batches: task.total_batches,
      completed_batches: task.completed_batches,
      degraded: task.degraded,
      degraded_reason: task.degraded_reason,
      created_at: task.created_at,
      parsed_at: task.parsed_at,
      started_at: task.started_at,
      completed_at: task.completed_at,
    },
    filters: { batch: batchNumber || null, row_from: rowFrom || null, row_to: rowTo || null, error_code: errorCode },
    events,
    outbox,
    batches,
    performance,
    errors,
    db_writes: dbWrites[0] || { shipment_count: 0, order_count: 0 },
  });
}
