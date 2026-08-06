import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_STATUS = new Set(["pending", "processing", "completed", "partial_success", "failed"]);

function optionalUuid(value: string | null, name: string) {
  const normalized = value?.trim() || null;
  if (normalized && !UUID_RE.test(normalized)) throw new Error(`${name} 必须是有效 UUID`);
  return normalized;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, Number(searchParams.get("page") || 1));
    const pageSize = Math.min(50, Math.max(10, Number(searchParams.get("page_size") || 20)));
    if (!Number.isInteger(page) || !Number.isInteger(pageSize)) throw new Error("分页参数必须是整数");

    const taskId = optionalUuid(searchParams.get("task_id"), "task_id");
    const traceId = optionalUuid(searchParams.get("trace_id"), "trace_id");
    const fileName = searchParams.get("file_name")?.trim().slice(0, 200) || null;
    const status = searchParams.get("status")?.trim() || null;
    if (status && !ALLOWED_STATUS.has(status)) throw new Error("任务状态无效");

    const offset = (page - 1) * pageSize;
    const [items, totals] = await Promise.all([
      sql`
        select
          t.id as task_id,
          t.trace_id,
          t.file_name,
          t.status,
          t.processing_stage,
          t.total_rows,
          t.processed_rows,
          t.success_rows,
          t.failed_rows,
          t.total_batches,
          t.completed_batches,
          t.degraded,
          t.created_at,
          t.started_at,
          t.completed_at,
          r.name as rule_name,
          count(*) over()::int as filtered_total,
          (select count(*)::int from trace_events te where te.task_id = t.id) as trace_event_count,
          (select count(*)::int from import_task_errors e where e.task_id = t.id) as error_count,
          (select count(*)::int from event_outbox o where o.aggregate_id = t.id and o.status = 'dead-lettered') as dlq_count
        from import_tasks t
        left join parse_rules r on r.id = t.parse_rule_id
        where (${taskId}::uuid is null or t.id = ${taskId}::uuid)
          and (${traceId}::uuid is null or t.trace_id = ${traceId}::uuid)
          and (${fileName}::text is null or t.file_name ilike '%' || ${fileName} || '%')
          and (${status}::text is null or t.status = ${status})
        order by t.created_at desc
        limit ${pageSize} offset ${offset}
      `,
      sql`
        select
          count(*)::int as total,
          count(*) filter (where status = 'processing')::int as processing,
          count(*) filter (where status = 'completed')::int as completed,
          count(*) filter (where status = 'partial_success')::int as partial_success,
          count(*) filter (where status = 'failed')::int as failed
        from import_tasks
      `,
    ]);

    return NextResponse.json({
      page,
      page_size: pageSize,
      total: Number(items[0]?.filtered_total || 0),
      summary: totals[0] || { total: 0, processing: 0, completed: 0, partial_success: 0, failed: 0 },
      filters: { task_id: taskId, trace_id: traceId, file_name: fileName, status },
      items: items.map((item) => {
        const result = { ...item };
        delete result.filtered_total;
        return result;
      }),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "导入历史查询失败" }, { status: 400 });
  }
}
