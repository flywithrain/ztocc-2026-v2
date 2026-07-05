import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { shipments } from "@/lib/db-schema";
import { desc, gte, sql as drizzleSql } from "drizzle-orm";
import {
  getRequestId,
  verifyV2ApiKey,
  unauthorizedResponse,
  wrapV2Response,
  wrapV2Error,
} from "@/lib/v2-api-auth";

/**
 * GET /api/v1/shipments?updatedSince=ISO&page=1&pageSize=100
 * 运单增量同步。V2 表无 updatedAt，按 submittedAt 作为变更时间窗口。
 * 默认窗口为最近 7 天（需求 §9.3 已说明此限制）。
 */
export async function GET(req: NextRequest) {
  const requestId = getRequestId(req);
  const params = req.nextUrl.searchParams;

  if (!verifyV2ApiKey(req)) {
    console.warn(`[v2-api][401] ${requestId} sync missing/bad api key`);
    return unauthorizedResponse(requestId);
  }

  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  const pageSize = Math.min(200, Math.max(1, Number(params.get("pageSize") ?? "100") || 100));

  // updatedSince 缺省 = 7 天前；忽略前端传入的“超过 7 天”以收敛窗口
  const sevenAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const sinceRaw = params.get("updatedSince") ?? params.get("since");
  let since = sevenAgo;
  if (sinceRaw) {
    const parsed = new Date(sinceRaw);
    if (!Number.isNaN(parsed.getTime())) since = parsed > sevenAgo ? parsed : sevenAgo;
  }

  try {
    const [countRow] = await db
      .select({ count: drizzleSql<number>`count(*)` })
      .from(shipments)
      .where(gte(shipments.submittedAt, since))
      .execute();
    const total = Number(countRow?.count || 0);

    const rows = await db
      .select()
      .from(shipments)
      .where(gte(shipments.submittedAt, since))
      .orderBy(desc(shipments.submittedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    console.info(`[v2-api][200] ${requestId} sync page=${page} size=${pageSize} since=${since.toISOString()} total=${total}`);

    return wrapV2Response(requestId, {
      page,
      pageSize,
      total,
      since: since.toISOString(),
      note: "V2 表无 updatedAt，按 submittedAt 近 7 天增量同步",
      items: rows.map((r) => ({
        id: r.id,
        externalCode: r.externalCode,
        storeName: r.storeName,
        submittedAt: r.submittedAt,
        skuCount: r.skuCount,
        totalQuantity: r.totalQuantity,
        batchId: r.batchId,
        itemsUrl: `/api/v1/shipments/lookup?shipmentId=${r.id}`,
      })),
    });
  } catch (e) {
    console.error(`[v2-api][500] ${requestId} sync fail`, e);
    return wrapV2Error(requestId, "V2_INTERNAL", 500, "V2 内部错误");
  }
}
