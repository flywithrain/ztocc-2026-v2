import { NextResponse } from "next/server";
import { cleanupExpiredImportBlobs } from "@/lib/import-service";
import { verifyQStashRequest } from "@/lib/qstash-receiver";

export const runtime = "nodejs";
export const maxDuration = 60;

async function isAuthorized(request: Request, rawBody: string) {
  const cleanupToken = process.env.IMPORT_CLEANUP_TOKEN || process.env.IMPORT_WORKER_TOKEN;
  if (cleanupToken && request.headers.get("x-cleanup-token") === cleanupToken) return true;
  try {
    return await verifyQStashRequest(request, rawBody);
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (!await isAuthorized(request, rawBody)) {
    return NextResponse.json({ error: "无权触发导入 Blob 清理" }, { status: 401 });
  }
  try {
    const body = rawBody ? JSON.parse(rawBody) as { limit?: number } : {};
    return NextResponse.json(await cleanupExpiredImportBlobs(body.limit));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Blob 清理失败" }, { status: 500 });
  }
}
