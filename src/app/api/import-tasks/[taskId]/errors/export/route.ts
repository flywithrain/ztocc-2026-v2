import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { importTaskErrors, importTasks } from "@/lib/db-schema";

function csvCell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
  const { searchParams } = new URL(request.url);
  const batch = searchParams.get("batch");
  const errorCode = searchParams.get("error_code");
  const filters = [eq(importTaskErrors.taskId, taskId)];
  if (batch !== null && batch !== "") filters.push(eq(importTaskErrors.batchIndex, Number(batch)));
  if (errorCode) filters.push(eq(importTaskErrors.errorCode, errorCode));

  const [[task], rows] = await Promise.all([
    db.select({ fileName: importTasks.fileName }).from(importTasks).where(eq(importTasks.id, taskId)).limit(1),
    db.select().from(importTaskErrors).where(and(...filters)).orderBy(asc(importTaskErrors.rowNumber)).limit(50000),
  ]);
  if (!task) return NextResponse.json({ error: "任务不存在" }, { status: 404 });

  const header = ["批次", "行号", "字段", "错误码", "原始值（已脱敏）", "错误原因", "修复建议", "Trace ID"];
  const lines = [
    header.map(csvCell).join(","),
    ...rows.map((row) => [row.batchIndex + 1, row.rowNumber, row.fieldName, row.errorCode, row.rawValue, row.errorReason, row.suggestion, row.traceId].map(csvCell).join(",")),
  ];
  const safeName = task.fileName.replace(/[\\/:*?"<>|]/g, "_");
  return new Response(`\uFEFF${lines.join("\r\n")}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${safeName}-errors.csv`)}`,
      "cache-control": "no-store",
    },
  });
}
