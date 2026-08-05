import { NextResponse } from "next/server";
import { runImportRecovery } from "@/lib/import-service";
import { verifyQStashRequest } from "@/lib/qstash-receiver";

export const runtime = "nodejs";
export const maxDuration = 30;

async function isAuthorized(request: Request, rawBody: string) {
  const workerToken = process.env.IMPORT_WORKER_TOKEN;
  if (workerToken && request.headers.get("x-worker-token") === workerToken) return true;
  try {
    return await verifyQStashRequest(request, rawBody);
  } catch {
    return false;
  }
}

async function run(request: Request) {
  const rawBody = request.method === "POST" ? await request.text() : "";
  if (!await isAuthorized(request, rawBody)) {
    return NextResponse.json({ error: "无权触发导入恢复控制面" }, { status: 401 });
  }
  try {
    return NextResponse.json({ control_plane: true, ...(await runImportRecovery()) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "恢复控制面执行失败" }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
