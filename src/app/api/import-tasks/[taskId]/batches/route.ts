import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { batchPerformanceLog, importTaskBatches } from "@/lib/db-schema";

export async function GET(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
  const rows = await db.select({ batch: importTaskBatches, performance: batchPerformanceLog }).from(importTaskBatches).leftJoin(batchPerformanceLog, and(eq(batchPerformanceLog.taskId, importTaskBatches.taskId), eq(batchPerformanceLog.unitId, importTaskBatches.unitId))).where(eq(importTaskBatches.taskId, taskId)).orderBy(asc(importTaskBatches.batchIndex));
  return NextResponse.json({ items: rows.map(({ batch, performance }) => ({ unit_id: batch.unitId, batch_index: batch.batchIndex, start_row: batch.startRow, end_row: batch.endRow, status: batch.status, retry_count: batch.retryCount, locked_at: batch.lockedAt, completed_at: batch.completedAt, performance: performance ? { parse_duration_ms: performance.parseDurationMs, rule_duration_ms: performance.ruleDurationMs, validate_duration_ms: performance.validateDurationMs, insert_duration_ms: performance.insertDurationMs, total_duration_ms: performance.totalDurationMs } : null })) });
}
