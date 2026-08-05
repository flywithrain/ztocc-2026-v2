import { NextResponse } from "next/server";
import { recordQStashFailure } from "@/lib/import-service";
import { verifyQStashRequest } from "@/lib/qstash-receiver";

export const runtime = "nodejs";
export const maxDuration = 30;

type FailureCallbackBody = {
  status?: number;
  body?: string;
  retried?: number;
  maxRetries?: number;
  sourceMessageId?: string;
  sourceBody?: string;
};

export async function POST(request: Request) {
  const rawBody = await request.text();
  try {
    if (!await verifyQStashRequest(request, rawBody)) {
      return NextResponse.json({ error: "QStash failure callback 签名无效" }, { status: 401 });
    }
    const failure = JSON.parse(rawBody) as FailureCallbackBody;
    if (!failure.sourceMessageId) {
      return NextResponse.json({ error: "failure callback 缺少 sourceMessageId" }, { status: 400 });
    }
    const result = await recordQStashFailure({
      sourceMessageId: failure.sourceMessageId,
      status: failure.status,
      retried: failure.retried,
      maxRetries: failure.maxRetries,
      responseBody: failure.body,
      sourceBody: failure.sourceBody,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "死信同步失败" }, { status: 500 });
  }
}
