import { after } from "next/server";
import { NextResponse } from "next/server";
import { getRule } from "@/lib/server-actions";
import { createBlobImportTask, dispatchOutbox } from "@/lib/import-service";
import { ImportTaskRequestError, parseBlobImportTaskRequest } from "@/lib/import-task-request";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  const started = performance.now();
  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 64 * 1024) {
      return NextResponse.json({ error: "任务创建接口只接受 Blob 引用，最大请求体为 64 KiB" }, { status: 413 });
    }
    const input = parseBlobImportTaskRequest(await request.json());
    const rule = await getRule(input.parseRuleId);
    if (!rule) return NextResponse.json({ error: "解析规则不存在" }, { status: 404 });
    const result = await createBlobImportTask(input);
    after(async () => {
      try {
        await dispatchOutbox(result.task_id);
      } catch (error) {
        console.error("Outbox 投递失败，恢复控制面将重试", { taskId: result.task_id, error });
      }
    });
    return NextResponse.json({ ...result, upload_response_ms: Math.round(performance.now() - started) }, { status: 202 });
  } catch (error) {
    const status = error instanceof ImportTaskRequestError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "任务创建失败" }, { status });
  }
}
