import { after } from "next/server";
import { NextResponse } from "next/server";
import { getRule } from "@/lib/server-actions";
import { createImportTask, dispatchOutbox, processPendingBatches } from "@/lib/import-service";
import type { OrderRow } from "@/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  const started = performance.now();
  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 4 * 1024 * 1024) {
      return NextResponse.json(
        { error: "导入请求体超过 4 MiB 安全上限，请缩短字段或改用对象存储直传" },
        { status: 413 }
      );
    }
    const body = await request.json() as { file_name?: string; parse_rule_id?: string; rows?: OrderRow[] };
    if (!body.file_name || !body.parse_rule_id || !Array.isArray(body.rows)) {
      return NextResponse.json({ error: "file_name、parse_rule_id 和 rows 为必填项" }, { status: 400 });
    }
    const rule = await getRule(body.parse_rule_id);
    if (!rule) return NextResponse.json({ error: "解析规则不存在" }, { status: 404 });
    const result = await createImportTask({ fileName: body.file_name, parseRuleId: body.parse_rule_id, rule, rows: body.rows });
    after(async () => {
      try {
        if (process.env.IMPORT_QUEUE_WEBHOOK_URL) {
          await dispatchOutbox(result.task_id);
        } else {
          await processPendingBatches(result.task_id);
        }
      } catch (error) {
        console.error("异步导入后台触发失败", { taskId: result.task_id, error });
      }
    });
    return NextResponse.json({ ...result, upload_response_ms: Math.round(performance.now() - started) }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "任务创建失败" }, { status: 500 });
  }
}
