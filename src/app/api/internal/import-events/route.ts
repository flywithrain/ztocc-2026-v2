import { NextRequest, NextResponse } from "next/server";
import { processImportEvent } from "@/lib/import-service";
import type { ImportEventEnvelope } from "@/lib/import-types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const expectedToken = process.env.IMPORT_QUEUE_WEBHOOK_TOKEN || process.env.IMPORT_WORKER_TOKEN;
  const authorization = request.headers.get("authorization");
  if (!expectedToken || authorization !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "无权消费导入事件" }, { status: 401 });
  }

  try {
    const event = await request.json() as ImportEventEnvelope;
    const result = await processImportEvent(event);
    return NextResponse.json({ event_id: event.event_id, result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "导入事件处理失败" },
      { status: 400 }
    );
  }
}
