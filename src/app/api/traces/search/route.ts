import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionalUuid(value: string | null, name: string) {
  const normalized = value?.trim() || null;
  if (normalized && !UUID_RE.test(normalized)) throw new Error(`${name} 必须是有效 UUID`);
  return normalized;
}

function optionalInteger(value: string | null, name: string, minimum: number) {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${name} 必须是大于等于 ${minimum} 的整数`);
  return parsed;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const taskId = optionalUuid(searchParams.get("task_id"), "task_id");
    const traceId = optionalUuid(searchParams.get("trace_id"), "trace_id");
    const fileName = searchParams.get("file_name")?.trim().slice(0, 200) || null;
    const batchNumber = optionalInteger(searchParams.get("batch"), "批次号", 1);
    const rowFrom = optionalInteger(searchParams.get("row_from"), "起始行号", 1);
    const rowTo = optionalInteger(searchParams.get("row_to"), "结束行号", 1);
    const errorCode = searchParams.get("error_code")?.trim().toUpperCase().slice(0, 16) || null;
    if (rowFrom && rowTo && rowFrom > rowTo) throw new Error("起始行号不能大于结束行号");

    const rows = await sql`
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
        t.created_at,
        t.completed_at,
        r.name as rule_name,
        (select count(*)::int from trace_events te where te.task_id = t.id) as trace_event_count,
        (select count(*)::int from event_outbox o where o.aggregate_id = t.id) as outbox_count,
        (select count(*)::int from import_task_errors e where e.task_id = t.id) as error_count,
        (select count(*)::int from import_task_errors e where e.task_id = t.id
          and (${batchNumber}::int is null or e.batch_index = ${batchNumber === null ? null : batchNumber - 1})
          and (${rowFrom}::int is null or e.row_number >= ${rowFrom})
          and (${rowTo}::int is null or e.row_number <= ${rowTo})
          and (${errorCode}::text is null or e.error_code = ${errorCode})
        ) as matched_error_count
      from import_tasks t
      left join parse_rules r on r.id = t.parse_rule_id
      where (${taskId}::uuid is null or t.id = ${taskId}::uuid)
        and (${traceId}::uuid is null or t.trace_id = ${traceId}::uuid)
        and (${fileName}::text is null or t.file_name ilike '%' || ${fileName} || '%')
        and (${batchNumber}::int is null or exists (
          select 1 from import_task_batches b where b.task_id = t.id and b.batch_index = ${batchNumber === null ? null : batchNumber - 1}
        ))
        and ((${rowFrom}::int is null and ${rowTo}::int is null and ${errorCode}::text is null) or exists (
          select 1 from import_task_errors e where e.task_id = t.id
            and (${batchNumber}::int is null or e.batch_index = ${batchNumber === null ? null : batchNumber - 1})
            and (${rowFrom}::int is null or e.row_number >= ${rowFrom})
            and (${rowTo}::int is null or e.row_number <= ${rowTo})
            and (${errorCode}::text is null or e.error_code = ${errorCode})
        ))
      order by t.created_at desc
      limit 50
    `;

    return NextResponse.json({
      filters: { task_id: taskId, trace_id: traceId, file_name: fileName, batch: batchNumber, row_from: rowFrom, row_to: rowTo, error_code: errorCode },
      total: rows.length,
      items: rows,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Trace 搜索失败" }, { status: 400 });
  }
}
