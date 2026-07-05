import { NextRequest } from "next/server";
import { getShipmentDetail } from "@/lib/server-actions";
import {
  getRequestId,
  verifyV2ApiKey,
  unauthorizedResponse,
  wrapV2Response,
  wrapV2Error,
} from "@/lib/v2-api-auth";

/**
 * GET /api/v1/shipments/{shipmentId}/sku/validate?skuCode={skuCode}
 * SKU 归属校验：命中返回 valid=true 及规格等；未命中 valid=false。
 * 运单本身不存在返回 404 WAYBILL_NOT_FOUND。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ shipmentId: string }> }
) {
  const requestId = getRequestId(req);
  const { shipmentId } = await params;
  const skuCode = req.nextUrl.searchParams.get("skuCode")?.trim();

  if (!shipmentId || !skuCode) {
    return wrapV2Error(requestId, "BAD_REQUEST", 400, "需提供 shipmentId 与 skuCode");
  }

  if (!verifyV2ApiKey(req)) {
    console.warn(`[v2-api][401] ${requestId} sku-validate missing/bad api key`);
    return unauthorizedResponse(requestId);
  }

  try {
    const items = await getShipmentDetail(shipmentId);
    if (items.length === 0) {
      // 注意：此处无法区分“运单不存在”还是“运单无明细”，统一按 NOT_FOUND 处理
      console.warn(`[v2-api][404] ${requestId} sku-validate shipment ${shipmentId} NOT_FOUND`);
      return wrapV2Error(requestId, "WAYBILL_NOT_FOUND", 404, "运单不存在或无明细");
    }

    const hit = items.find((it) => it.skuCode === skuCode);
    if (!hit) {
      return wrapV2Response(requestId, {
        valid: false,
        shipmentId,
        skuCode,
      });
    }

    return wrapV2Response(requestId, {
      valid: true,
      shipmentId,
      skuCode: hit.skuCode,
      skuName: hit.skuName,
      skuQuantity: hit.skuQuantity,
      skuSpec: hit.skuSpec,
    });
  } catch (e) {
    console.error(`[v2-api][500] ${requestId} sku-validate fail`, e);
    return wrapV2Error(requestId, "V2_INTERNAL", 500, "V2 内部错误");
  }
}
