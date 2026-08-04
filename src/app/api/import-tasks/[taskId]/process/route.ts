import { NextResponse } from "next/server";
import { processPendingBatches, recoverStalledBatches } from "@/lib/import-service";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
  const token = request.headers.get("x-worker-token");
  if (process.env.IMPORT_WORKER_TOKEN && token !== process.env.IMPORT_WORKER_TOKEN) {
    return NextResponse.json({ error: "无权触发 Worker" }, { status: 401 });
  }
  try {
    await recoverStalledBatches();
    const results = await processPendingBatches(taskId);
    return NextResponse.json({ task_id: taskId, processed_batches: results.length, results });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Worker 执行失败" }, { status: 500 });
  }
}
