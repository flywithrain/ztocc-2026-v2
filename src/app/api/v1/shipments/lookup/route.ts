import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { shipments, orders } from "@/lib/db-schema";
import { eq } from "drizzle-orm";
import { getShipmentDetail } from "@/lib/server-actions";
import {
  getRequestId,
  verifyV2ApiKey,
  unauthorizedResponse,
  wrapV2Response,
  wrapV2Error,
  maskPhone,
} from "@/lib/v2-api-auth";

/**
 * GET /api/v1/shipments/lookup?shipmentId={id}
 * GET /api/v1/shipments/lookup?externalCode={externalCode}
 * 对外只读接口，供 V3 校验并刷新运单快照。
 */
export async function GET(req: NextRequest) {
  const requestId = getRequestId(req);
  const startedAt = Date.now();
  const params = req.nextUrl.searchParams;
  const shipmentId = params.get("shipmentId")?.trim();
  const externalCode = params.get("externalCode")?.trim();

  if (!shipmentId && !externalCode) {
    return wrapV2Error(requestId, "BAD_REQUEST", 400, "需提供 shipmentId 或 externalCode");
  }

  if (!verifyV2ApiKey(req)) {
    console.warn(`[v2-api][401] ${requestId} lookup missing/bad api key`);
    return unauthorizedResponse(requestId);
  }

  try {
    // 查主表（按 id 精确，或按 externalCode 精确取最近一条）
    const rows = await db
      .select()
      .from(shipments)
      .where(
        shipmentId ? eq(shipments.id, shipmentId!) : eq(shipments.externalCode, externalCode!)
      )
      .limit(1);

    if (rows.length === 0) {
      const durMs = Date.now() - startedAt;
      console.warn(`[v2-api][404] ${requestId} lookup NOT_FOUND in ${durMs}ms`);
      return wrapV2Error(requestId, "WAYBILL_NOT_FOUND", 404, "运单不存在");
    }

    const row = rows[0];
    const items = await getShipmentDetail(row.id);

    const durMs = Date.now() - startedAt;
    console.info(`[v2-api][200] ${requestId} lookup ${row.id} sku=${items.length} ${durMs}ms`);

    return wrapV2Response(requestId, {
      id: row.id,
      externalCode: row.externalCode,
      storeName: row.storeName,
      receiverName: row.receiverName,
      receiverPhone: maskPhone(row.receiverPhone),
      receiverAddress: row.receiverAddress,
      remark: row.remark,
      skuCount: row.skuCount,
      totalQuantity: row.totalQuantity,
      batchId: row.batchId,
      submittedAt: row.submittedAt,
      items: items.map((it) => ({
        id: it.id,
        skuCode: it.skuCode,
        skuName: it.skuName,
        skuQuantity: it.skuQuantity,
        skuSpec: it.skuSpec,
        remark: it.remark,
      })),
    });
  } catch (e) {
    const durMs = Date.now() - startedAt;
    console.error(`[v2-api][500] ${requestId} lookup fail in ${durMs}ms`, e);
    return wrapV2Error(requestId, "V2_INTERNAL", 500, "V2 内部错误");
  }
}
