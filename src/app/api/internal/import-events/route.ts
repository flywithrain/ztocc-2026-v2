import { NextResponse } from "next/server";
import { processImportEvent } from "@/lib/import-service";
import { getQStashDeliveryMetadata, verifyQStashRequest } from "@/lib/qstash-receiver";
import type { ImportEventEnvelope } from "@/lib/import-types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  const rawBody = await request.text();
  try {
    if (!await verifyQStashRequest(request, rawBody)) {
      return NextResponse.json({ error: "QStash 签名无效" }, { status: 401 });
    }
  } catch (error) {
    console.error("QStash 签名校验失败", { error });
    return NextResponse.json({ error: "QStash 签名校验失败" }, { status: 401 });
  }

  try {
    const event = JSON.parse(rawBody) as ImportEventEnvelope;
    const delivery = getQStashDeliveryMetadata(request);
    const result = await processImportEvent(event, delivery);
    return NextResponse.json({ event_id: event.event_id, qstash_message_id: delivery.messageId, result });
  } catch (error) {
    // 非 2xx 会让 QStash 按发布时的 retries/retryDelay 策略重投。
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "导入事件处理失败" },
      { status: 500 }
    );
  }
}
