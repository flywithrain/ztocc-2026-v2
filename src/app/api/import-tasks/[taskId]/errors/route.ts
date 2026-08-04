import { and, asc, count, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { importTaskErrors, importTasks } from "@/lib/db-schema";

export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page") || 1));
  const pageSize = Math.min(100, Math.max(1, Number(searchParams.get("page_size") || 20)));
  const batch = searchParams.get("batch");
  const errorCode = searchParams.get("error_code");
  const filters = [eq(importTaskErrors.taskId, taskId)];
  if (batch !== null && batch !== "") filters.push(eq(importTaskErrors.batchIndex, Number(batch)));
  if (errorCode) filters.push(eq(importTaskErrors.errorCode, errorCode));
  const where = and(...filters);
  const [[task], [total], rows] = await Promise.all([
    db.select({ id: importTasks.id }).from(importTasks).where(eq(importTasks.id, taskId)).limit(1),
    db.select({ value: count() }).from(importTaskErrors).where(where),
    db.select().from(importTaskErrors).where(where).orderBy(asc(importTaskErrors.rowNumber)).limit(pageSize).offset((page - 1) * pageSize),
  ]);
  if (!task) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  return NextResponse.json({ page, page_size: pageSize, total: total.value, items: rows.map((row) => ({ id: row.id, unit_id: row.unitId, batch_index: row.batchIndex, row_number: row.rowNumber, field_name: row.fieldName, raw_value: row.rawValue, error_code: row.errorCode, error_reason: row.errorReason, suggestion: row.suggestion, trace_id: row.traceId, created_at: row.createdAt })) });
}
