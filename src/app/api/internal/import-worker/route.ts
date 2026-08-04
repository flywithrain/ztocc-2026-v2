import { NextRequest, NextResponse } from "next/server";
import { processQueuedBatches } from "@/lib/import-service";

export const runtime = "nodejs";
export const maxDuration = 120;

function isAuthorized(request: NextRequest) {
  const workerToken = process.env.IMPORT_WORKER_TOKEN;
  const cronSecret = process.env.CRON_SECRET;
  const workerHeader = request.headers.get("x-worker-token");
  const authorization = request.headers.get("authorization");

  return Boolean(
    (workerToken && workerHeader === workerToken) ||
    (cronSecret && authorization === `Bearer ${cronSecret}`)
  );
}

async function run(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "无权触发内部 Worker" }, { status: 401 });
  }

  const limit = Number(request.nextUrl.searchParams.get("limit") || 4);
  const results = await processQueuedBatches(limit);
  return NextResponse.json({ processed_batches: results.length, results });
}

export const GET = run;
export const POST = run;
