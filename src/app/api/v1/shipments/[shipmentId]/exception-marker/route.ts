import { NextRequest } from "next/server";
import {
  getRequestId,
  verifyV2ApiKey,
  unauthorizedResponse,
  wrapV2Response,
  wrapV2Error,
} from "@/lib/v2-api-auth";

/**
 * POST /api/v1/shipments/{shipmentId}/exception-marker
 * 可选回写接口：V3 有未关闭异常时通知 V2 展示提示。
 * 本轮落地为“日志通道” —— 不改 V2 schema，仅记录到 V2 console。
 * 后续若 V2 需要持久化，可在 V2 侧新增字段，不影响本接口契约。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ shipmentId: string }> }
) {
  const requestId = getRequestId(req);
  const { shipmentId } = await params;

  if (!verifyV2ApiKey(req)) {
    console.warn(`[v2-api][401] ${requestId} exception-marker missing/bad api key`);
    return unauthorizedResponse(requestId);
  }

  if (!shipmentId) {
    return wrapV2Error(requestId, "BAD_REQUEST", 400, "缺少 shipmentId");
  }

  let body: { hasOpenException?: boolean; ticketNo?: string; category?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {}; // 允许空 body
  }

  console.info(
    `[v2-api][marker] ${requestId} shipment=${shipmentId} hasOpen=${!!body.hasOpenException} ticket=${body.ticketNo ?? "-"} category=${body.category ?? "-"}`
  );

  // 不持久化到 V2 schema；本轮仅日志通道（需求 §9.4 可选加分项）。
  return wrapV2Response(requestId, { received: true });
}
