import { NextResponse } from "next/server";
import { dispatchOutbox, recoverStalledBatches } from "@/lib/import-service";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
  const expectedToken = process.env.IMPORT_WORKER_TOKEN;
  const token = request.headers.get("x-worker-token");
  if (!expectedToken || token !== expectedToken) {
    return NextResponse.json({ error: "无权触发恢复控制面" }, { status: 401 });
  }
  try {
    const recovered = await recoverStalledBatches();
    const dispatched = await dispatchOutbox(taskId);
    return NextResponse.json({ task_id: taskId, control_plane: true, recovered_batches: recovered.length, dispatched_events: dispatched });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "恢复控制面执行失败" }, { status: 500 });
  }
}
